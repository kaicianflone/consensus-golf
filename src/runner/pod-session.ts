import { RunPodsClient, type RunPodsConfig } from './runpods-client.js'
import type { CostTracker } from './cost-tracker.js'

/**
 * Manages a RunPod pod lifecycle across tiers.
 * A single pod can be reused for Tier 2 → Tier 3 to avoid
 * losing GPU availability between tiers.
 */
export class PodSession {
  private podId: string | null = null
  private volumeId: string | null = null
  private depsInstalled = false
  private dataVerified = false
  private charged = false

  constructor(
    private readonly client: RunPodsClient,
    private readonly costTracker: CostTracker,
    private readonly onProgress?: (agent: string, line: string) => void,
  ) {}

  get activePodId(): string | null {
    return this.podId
  }

  get activeVolumeId(): string | null {
    return this.volumeId
  }

  get isDepsInstalled(): boolean {
    return this.depsInstalled
  }

  /**
   * Acquire a GPU pod across multiple volumes and GPU types.
   * Returns true if a pod is now running.
   */
  async acquire(
    gpuTypes: string[],
    volumeIds: string[],
    config: { gpuCount: number; templateId: string; containerImage: string },
    podName: string,
  ): Promise<boolean> {
    if (this.podId) return true // already have a pod

    for (const vol of volumeIds) {
      for (const gpu of gpuTypes) {
        try {
          this.onProgress?.('gpu', `Trying ${gpu}${config.gpuCount > 1 ? ` x${config.gpuCount}` : ''} (vol:${vol.slice(0, 6)})...`)
          this.podId = await this.client.createPod(
            {
              gpuType: gpu,
              gpuCount: config.gpuCount,
              templateId: config.templateId,
              containerImage: config.containerImage,
              volumeId: vol,
            },
            podName,
          )
          this.volumeId = vol
          this.onProgress?.('gpu', `Pod ${this.podId} on ${gpu}`)
          return true
        } catch (err) {
          const errStr = String(err)
          if (errStr.includes('SUPPLY_CONSTRAINT') || errStr.includes('HTTP 5')) continue
          throw err
        }
      }
    }
    return false
  }

  /**
   * Wait for the pod to reach RUNNING state.
   */
  async waitReady(timeoutMs = 120_000): Promise<void> {
    if (!this.podId) throw new Error('No pod to wait on')
    this.onProgress?.('gpu', 'Waiting for RUNNING...')
    await this.client.waitForRunning(this.podId, timeoutMs)
    this.onProgress?.('gpu', 'Pod running.')
  }

  /**
   * Install deps if not already installed on this session.
   */
  async ensureDeps(): Promise<void> {
    if (!this.podId) throw new Error('No pod')
    if (this.depsInstalled) return
    this.onProgress?.('gpu', 'Installing dependencies...')
    await this.client.executeCommand(
      this.podId,
      'pip install -q sentencepiece 2>&1 | tail -1',
      120_000,
    )
    // Verify torch 2.5 is available on the volume
    const torchCheck = await this.client.executeCommand(
      this.podId,
      'PYTHONPATH=/workspace/site-packages python3 -c "import torch; print(torch.__version__)" 2>&1 | tail -1',
      15_000,
    )
    if (!torchCheck.includes('2.5')) {
      this.onProgress?.('gpu', 'Torch 2.5 not found on volume, installing...')
      await this.client.executeCommand(
        this.podId,
        'pip install torch==2.5.1 --index-url https://download.pytorch.org/whl/cu124 --target=/workspace/site-packages 2>&1 | tail -3',
        600_000,
      )
    }
    this.depsInstalled = true
    this.onProgress?.('gpu', 'Dependencies ready.')
  }

  /**
   * Verify the volume has data. If not, provision it inline.
   */
  async ensureData(dataPath: string, tokenizerPath: string): Promise<void> {
    if (!this.podId) throw new Error('No pod')
    if (this.dataVerified) return

    // Validate paths to prevent shell injection
    const safePath = /^[a-zA-Z0-9_.\-\/]+$/
    if (!safePath.test(dataPath)) throw new Error(`Unsafe dataPath: ${dataPath}`)
    if (!safePath.test(tokenizerPath)) throw new Error(`Unsafe tokenizerPath: ${tokenizerPath}`)

    const checkOutput = await this.client.executeCommand(
      this.podId,
      `[ -f ${dataPath}/fineweb_train_000000.bin ] && [ -f ${tokenizerPath} ] && echo DATA_OK || echo DATA_MISSING`,
      15_000,
    )

    if (checkOutput.includes('DATA_OK')) {
      this.dataVerified = true
      return
    }

    // Provision data inline — this volume hasn't been set up yet
    this.onProgress?.('gpu', `Volume ${this.volumeId?.slice(0, 6)} missing data, provisioning inline...`)

    await this.client.executeCommand(this.podId, [
      'pip install -q huggingface_hub',
      `mkdir -p ${dataPath} $(dirname ${tokenizerPath})`,
      'python3 -c "' +
        'from huggingface_hub import hf_hub_download; import shutil, os; ' +
        `os.makedirs(\\"${dataPath}\\", exist_ok=True); ` +
        `os.makedirs(\\"$(dirname ${tokenizerPath})\\", exist_ok=True); ` +
        `[shutil.copy(hf_hub_download(\\"willdepueoai/parameter-golf\\", f, subfolder=\\"datasets/datasets/fineweb10B_sp1024\\", repo_type=\\"dataset\\"), ` +
          `\\"${dataPath}/\\" + f) ` +
          `for f in [\\"fineweb_train_000000.bin\\", \\"fineweb_val_000000.bin\\"]]; ` +
        `shutil.copy(hf_hub_download(\\"willdepueoai/parameter-golf\\", \\"fineweb_1024_bpe.model\\", subfolder=\\"datasets/tokenizers\\", repo_type=\\"dataset\\"), ` +
          `\\"${tokenizerPath}\\"); ` +
        'print(\\"PROVISION_DONE\\")"',
    ].join(' && '), 600_000)

    this.dataVerified = true
    this.onProgress?.('gpu', 'Volume provisioned.')
  }

  /**
   * Upload a script to the pod.
   */
  async uploadScript(content: string, remotePath: string): Promise<void> {
    if (!this.podId) throw new Error('No pod')
    await this.client.uploadScript(this.podId, content, remotePath)
  }

  /**
   * Execute a training command on the pod.
   */
  async executeTraining(command: string, timeoutMs: number): Promise<string> {
    if (!this.podId) throw new Error('No pod')
    return this.client.executeCommand(this.podId, command, timeoutMs)
  }

  /**
   * Record cost for this session. Only charges once per pod.
   */
  recordCost(amount: number): void {
    if (this.charged) return
    this.costTracker.recordSpend(amount)
    this.charged = true
  }

  /**
   * Record additional cost (e.g., Tier 3 on same pod).
   */
  recordAdditionalCost(amount: number): void {
    this.costTracker.recordSpend(amount)
  }

  /**
   * Terminate the pod. Safe to call multiple times.
   */
  async terminate(): Promise<void> {
    if (!this.podId) return
    try {
      await this.client.terminatePod(this.podId)
      this.onProgress?.('gpu', `Pod ${this.podId} terminated`)
    } catch {
      this.onProgress?.('gpu', `WARNING: Failed to terminate pod ${this.podId}`)
    }
    this.podId = null
  }
}
