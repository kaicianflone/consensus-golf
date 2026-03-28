import type { TierRunner, TierRunResult, TierRunnerContext, TierGateResult } from './tier-runner.js'
import type { Proposal } from '../schema/proposal.js'
import type { ExperimentRun } from '../schema/experiment.js'
import { RunPodsClient } from './runpods-client.js'
import { CostTracker } from './cost-tracker.js'
import { parseMetrics } from './metrics-parser.js'
import { analyzeLossCurve, compareToBaseline } from './loss-curve-analyzer.js'
import { computeSimpleDiff } from './sandbox.js'
import { ulid } from 'ulid'

export class Tier2Runner implements TierRunner {
  readonly tier = 2 as const

  constructor(
    private readonly client: RunPodsClient,
    private readonly costTracker: CostTracker,
  ) {}

  async run(proposal: Proposal, ctx: TierRunnerContext): Promise<TierRunResult> {
    // Pre-gate
    const preGate = this.checkPreGate(ctx)
    if (!preGate.passed) {
      return {
        tier: 2, proposal, preGate,
        postGate: preGate, promotable: false,
      }
    }

    // Execute
    let run: ExperimentRun | undefined
    const tier2Config = ctx.policy.tiers.tier2!
    let podId: string | null = null

    try {
      const runId = ulid()

      // Try GPU types in priority order — H100 is often sold out
      const gpuFallbacks = [
        tier2Config.gpuType,
        'NVIDIA A100 80GB PCIe',
        'NVIDIA A100-SXM4-80GB',
        'NVIDIA GeForce RTX 4090',
      ]
      // Deduplicate while preserving order
      const gpuTypes = [...new Set(gpuFallbacks)]

      for (let i = 0; i < gpuTypes.length; i++) {
        try {
          ctx.onProgress?.(proposal.agent, `Trying GPU: ${gpuTypes[i]}...`)
          podId = await this.client.createPod(
            {
              gpuType: gpuTypes[i],
              gpuCount: tier2Config.gpuCount,
              templateId: tier2Config.templateId,
              containerImage: tier2Config.containerImage,
              volumeId: tier2Config.volumeId,
            },
            `cgolf-${runId.slice(-8)}`,
          )
          ctx.onProgress?.(proposal.agent, `Pod created on ${gpuTypes[i]}: ${podId}`)
          break
        } catch (err) {
          const isSupplyConstraint = String(err).includes('SUPPLY_CONSTRAINT')
          if (isSupplyConstraint && i < gpuTypes.length - 1) {
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

      await this.client.uploadScript(podId, proposal.modifiedSource, `/workspace/${tier2Config.trainScript}`)
      ctx.onProgress?.(proposal.agent, 'Script uploaded, starting training...')

      const command = this.buildTrainCommand(ctx)
      const stdout = await this.client.executeCommand(podId, command, tier2Config.maxWallclockSec * 1000)

      const metrics = parseMetrics(stdout)
      const patch = computeSimpleDiff(ctx.sourceCode, proposal.modifiedSource)

      run = {
        id: runId,
        proposalId: proposal.id,
        tier: 2,
        status: metrics.valBpb !== undefined ? 'passed' : 'failed',
        config: {
          iterations: 20000,
          trainBatchTokens: 524288,
          valBatchSize: 524288,
          maxWallclockSec: tier2Config.maxWallclockSec,
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
      ctx.onProgress?.(proposal.agent, `Tier 2 execution error: ${String(err)}`)

      if (!run) {
        run = {
          id: ulid(),
          proposalId: proposal.id,
          tier: 2,
          status: 'failed',
          config: {
            iterations: 20000,
            trainBatchTokens: 524288,
            valBatchSize: 524288,
            maxWallclockSec: tier2Config.maxWallclockSec,
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
        // Only charge cost if a pod was actually created
        this.costTracker.recordSpend(tier2Config.estimatedCostPerRun)
      }
    }

    // Analyze loss curve
    const curveSignal = analyzeLossCurve(run.metrics.stepLosses ?? [])
    const baselineComparison = ctx.baselineCurve
      ? compareToBaseline(curveSignal, ctx.baselineCurve.signal)
      : undefined

    // Post-gate
    const postGate = this.evaluatePostGate(run, ctx)

    return {
      tier: 2, proposal, preGate, run, curveSignal, baselineComparison,
      postGate, promotable: postGate.passed,
    }
  }

  private checkPreGate(ctx: TierRunnerContext): TierGateResult {
    const tier2Config = ctx.policy.tiers.tier2
    if (!tier2Config?.enabled) {
      return { passed: false, reason: 'Tier 2 not enabled' }
    }
    if (!process.env.RUNPOD_API_KEY) {
      return { passed: false, reason: 'RUNPOD_API_KEY not set' }
    }
    if (!this.costTracker.canAfford(tier2Config.estimatedCostPerRun)) {
      return {
        passed: false,
        reason: `Budget exceeded: $${this.costTracker.getRemaining().toFixed(2)} remaining, need $${tier2Config.estimatedCostPerRun.toFixed(2)}`,
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
      reason: `Tier 2 passed: val_bpb=${run.metrics.valBpb.toFixed(4)}`,
      riskScore: 0.1,
    }
  }

  private buildTrainCommand(ctx: TierRunnerContext): string {
    const tier2 = ctx.policy.tiers.tier2!
    // Validate all config paths against safe characters to prevent shell injection
    const safePath = /^[a-zA-Z0-9_.\-\/]+$/
    for (const [name, value] of [['dataPath', tier2.dataPath], ['tokenizerPath', tier2.tokenizerPath], ['trainScript', tier2.trainScript]] as const) {
      if (!safePath.test(value)) {
        throw new Error(`Unsafe characters in tier2 config ${name}: ${value}`)
      }
    }
    const parts = [
      'cd /workspace &&',
      'LOCAL_RANK=0 RANK=0 WORLD_SIZE=1 MASTER_ADDR=localhost MASTER_PORT=29500',
      `MAX_WALLCLOCK_SECONDS=${Math.floor(tier2.maxWallclockSec)}`,
      `DATA_PATH='${tier2.dataPath}'`,
      `TOKENIZER_PATH='${tier2.tokenizerPath}'`,
      'TRAIN_LOG_EVERY=5',
      'VAL_LOSS_EVERY=0',
      `python3 '/workspace/${tier2.trainScript}' 2>&1`,
    ]
    return parts.join(' ')
  }
}
