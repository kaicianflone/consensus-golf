import type { TierRunner, TierRunResult, TierRunnerContext, TierGateResult } from './tier-runner.js'
import type { Proposal } from '../schema/proposal.js'
import type { ExperimentRun } from '../schema/experiment.js'
import { RunPodsClient } from './runpods-client.js'
import { CostTracker } from './cost-tracker.js'
import { parseMetrics } from './metrics-parser.js'
import { analyzeLossCurve, compareToBaseline } from './loss-curve-analyzer.js'
import { computeSimpleDiff } from './sandbox.js'
import { ulid } from 'ulid'

export class Tier3Runner implements TierRunner {
  readonly tier = 3 as const

  constructor(
    private readonly client: RunPodsClient,
    private readonly costTracker: CostTracker,
  ) {}

  async run(proposal: Proposal, ctx: TierRunnerContext): Promise<TierRunResult> {
    // Pre-gate
    const preGate = this.checkPreGate(ctx)
    if (!preGate.passed) {
      return {
        tier: 3, proposal, preGate,
        postGate: preGate, promotable: false,
      }
    }

    // Execute
    let run: ExperimentRun | undefined
    const tier3Config = ctx.policy.tiers.tier3!
    let podId: string | null = null

    try {
      const runId = ulid()

      // GPU fallback list — use configured type first, then H100 variants
      const gpuFallbacks = [
        tier3Config.gpuType,
        'NVIDIA H100 80GB HBM3',
        'NVIDIA H100 SXM',
      ]
      const gpuTypes = [...new Set(gpuFallbacks)]

      for (let i = 0; i < gpuTypes.length; i++) {
        try {
          ctx.onProgress?.(proposal.agent, `Trying GPU: ${gpuTypes[i]} (8x)...`)
          podId = await this.client.createPod(
            {
              gpuType: gpuTypes[i],
              gpuCount: tier3Config.gpuCount,
              templateId: tier3Config.templateId,
              containerImage: tier3Config.containerImage,
              volumeId: tier3Config.volumeId,
            },
            `cgolf-t3-${runId.slice(-8)}`,
          )
          ctx.onProgress?.(proposal.agent, `Pod created on ${gpuTypes[i]}: ${podId}`)
          break
        } catch (err) {
          const errStr = String(err)
          const isRetryable = errStr.includes('SUPPLY_CONSTRAINT') || errStr.includes('HTTP 5')
          if (isRetryable && i < gpuTypes.length - 1) {
            ctx.onProgress?.(proposal.agent, `${gpuTypes[i]} unavailable, trying fallback...`)
            continue
          }
          throw err
        }
      }

      if (!podId) throw new Error('No GPU available across all fallback types')

      ctx.onProgress?.(proposal.agent, `Waiting for RUNNING...`)

      await this.client.waitForRunning(podId, 120_000)
      ctx.onProgress?.(proposal.agent, 'Pod running, installing dependencies...')

      // Ensure PyTorch 2.5+ (needed for enable_gqa) and sentencepiece
      await this.client.executeCommand(
        podId,
        'pip install -q torch==2.5.1+cu124 --index-url https://download.pytorch.org/whl/cu124 && pip install -q sentencepiece',
        180_000,
      )
      ctx.onProgress?.(proposal.agent, 'Dependencies ready, uploading script...')

      await this.client.uploadScript(podId, proposal.modifiedSource, `/workspace/${tier3Config.trainScript}`)
      ctx.onProgress?.(proposal.agent, 'Script uploaded, starting training (8-GPU torchrun)...')

      const command = this.buildTrainCommand(ctx)
      const stdout = await this.client.executeCommand(podId, command, (tier3Config.maxWallclockSec + 300) * 1000)

      const metrics = parseMetrics(stdout)
      const patch = computeSimpleDiff(ctx.sourceCode, proposal.modifiedSource)

      run = {
        id: runId,
        proposalId: proposal.id,
        tier: 3,
        status: metrics.valBpb !== undefined ? 'passed' : 'failed',
        config: {
          iterations: 20000,
          trainBatchTokens: 524288,
          valBatchSize: 524288,
          maxWallclockSec: tier3Config.maxWallclockSec,
        },
        metrics: {
          trainLoss: metrics.trainLoss,
          valLoss: metrics.valLoss,
          valBpb: metrics.valBpb,
          artifactBytes: metrics.artifactBytes,
          wallclockSec: metrics.wallclockSec,
          stepLosses: metrics.stepLosses,
        },
        compliance: {
          artifactWithinLimit: metrics.artifactBytes !== undefined
            ? metrics.artifactBytes <= ctx.pgolf.maxArtifactBytes
            : false,
          noNetworkAccess: true,
          reproducible: false,
        },
        patch,
        stdout,
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
      }
    } catch (err) {
      ctx.onProgress?.(proposal.agent, `Tier 3 execution error: ${String(err)}`)

      if (!run) {
        run = {
          id: ulid(),
          proposalId: proposal.id,
          tier: 3,
          status: 'failed',
          config: {
            iterations: 20000,
            trainBatchTokens: 524288,
            valBatchSize: 524288,
            maxWallclockSec: tier3Config.maxWallclockSec,
          },
          metrics: {},
          compliance: { artifactWithinLimit: false, noNetworkAccess: true, reproducible: false },
          patch: '',
          stdout: String(err),
          startedAt: new Date().toISOString(),
          completedAt: new Date().toISOString(),
        }
      }
    } finally {
      // ALWAYS terminate pod if one was created
      if (podId) {
        try {
          await this.client.terminatePod(podId)
          ctx.onProgress?.(proposal.agent, `Pod ${podId} terminated`)
        } catch {
          ctx.onProgress?.(proposal.agent, `WARNING: Failed to terminate pod ${podId}`)
        }
        // Always charge cost when a pod was created — RunPod bills regardless of outcome
        this.costTracker.recordSpend(tier3Config.estimatedCostPerRun)
      }
    }

    // Analyze loss curve — pick tier-specific baseline if available
    const curveSignal = analyzeLossCurve(run.metrics.stepLosses ?? [])
    const effectiveBaseline = ctx.baselineCurves?.get(3) ?? ctx.baselineCurve
    const baselineComparison = effectiveBaseline
      ? compareToBaseline(curveSignal, effectiveBaseline.signal)
      : undefined

    // Post-gate
    const postGate = this.evaluatePostGate(run, ctx)

    return {
      tier: 3, proposal, preGate, run, curveSignal, baselineComparison,
      postGate, promotable: postGate.passed,
    }
  }

  private checkPreGate(ctx: TierRunnerContext): TierGateResult {
    const tier3Config = ctx.policy.tiers.tier3
    if (!tier3Config?.enabled) {
      return { passed: false, reason: 'Tier 3 not enabled' }
    }
    if (!process.env.RUNPOD_API_KEY) {
      return { passed: false, reason: 'RUNPOD_API_KEY not set' }
    }
    if (!this.costTracker.canAfford(tier3Config.estimatedCostPerRun)) {
      return {
        passed: false,
        reason: `Budget exceeded: $${this.costTracker.getRemaining().toFixed(2)} remaining, need $${tier3Config.estimatedCostPerRun.toFixed(2)}`,
      }
    }
    return { passed: true, reason: 'Pre-gate passed' }
  }

  private evaluatePostGate(run: ExperimentRun, ctx: TierRunnerContext): TierGateResult {
    if (run.status !== 'passed') {
      return { passed: false, reason: `Run status: ${run.status}`, riskScore: 1.0 }
    }
    if (run.metrics.valBpb === undefined) {
      return { passed: false, reason: 'No val_bpb metric captured', riskScore: 0.9 }
    }
    if (!run.compliance.artifactWithinLimit) {
      return { passed: false, reason: 'Artifact exceeds size limit', riskScore: 0.8 }
    }
    return {
      passed: true,
      reason: `Tier 3 passed: val_bpb=${run.metrics.valBpb.toFixed(4)}`,
      riskScore: 0.1,
    }
  }

  private buildTrainCommand(ctx: TierRunnerContext): string {
    const tier3 = ctx.policy.tiers.tier3!
    // Validate all config paths against safe characters to prevent shell injection
    const safePath = /^[a-zA-Z0-9_.\-\/]+$/
    for (const [name, value] of [['dataPath', tier3.dataPath], ['tokenizerPath', tier3.tokenizerPath], ['trainScript', tier3.trainScript]] as const) {
      if (!safePath.test(value)) {
        throw new Error(`Unsafe characters in tier3 config ${name}: ${value}`)
      }
    }
    const parts = [
      'cd /workspace &&',
      'PYTHONPATH=/workspace/site-packages',
      `MAX_WALLCLOCK_SECONDS=${Math.floor(tier3.maxWallclockSec)}`,
      `DATA_PATH='${tier3.dataPath}'`,
      `TOKENIZER_PATH='${tier3.tokenizerPath}'`,
      'TRAIN_LOG_EVERY=5',
      'VAL_LOSS_EVERY=0',
      `torchrun --standalone --nproc_per_node=${tier3.gpuCount} /workspace/${tier3.trainScript} 2>&1`,
    ]
    return parts.join(' ')
  }
}
