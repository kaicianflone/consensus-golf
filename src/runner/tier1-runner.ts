import type { TierRunner, TierRunResult, TierRunnerContext, TierGateResult } from './tier-runner.js'
import type { Proposal } from '../schema/proposal.js'
import type { ExperimentRun } from '../schema/experiment.js'
import type { LossCurveSignal, BaselineComparison } from './loss-curve-analyzer.js'
import { runExperiment } from './sandbox.js'
import { analyzeLossCurve, compareToBaseline } from './loss-curve-analyzer.js'

export class Tier1Runner implements TierRunner {
  readonly tier = 1 as const

  async run(proposal: Proposal, ctx: TierRunnerContext): Promise<TierRunResult> {
    const preGate: TierGateResult = { passed: true, reason: 'Passed tier 0' }

    const run = await runExperiment(
      proposal,
      ctx.sourceCode,
      ctx.policy,
      ctx.pgolf,
      ctx.workDir,
      ctx.onProgress
        ? (line: string) => ctx.onProgress!(proposal.agent, line)
        : undefined,
    )

    const curveSignal = analyzeLossCurve(run.metrics.stepLosses ?? [])
    const baselineComparison = ctx.baselineCurve
      ? compareToBaseline(curveSignal, ctx.baselineCurve.signal)
      : undefined

    const postGate = this.evaluatePostGate(run, curveSignal, baselineComparison, ctx)

    return {
      tier: 1,
      proposal,
      preGate,
      run,
      curveSignal,
      baselineComparison,
      postGate,
      promotable: postGate.passed,
    }
  }

  private evaluatePostGate(
    run: ExperimentRun,
    signal: LossCurveSignal,
    comparison: BaselineComparison | undefined,
    ctx: TierRunnerContext,
  ): TierGateResult {
    if (run.status !== 'passed') {
      return { passed: false, reason: `Run status: ${run.status}`, riskScore: 1.0 }
    }

    if (!comparison || comparison.verdict === 'insufficient-data') {
      return { passed: true, reason: 'Smoke test passed (no baseline comparison available)', riskScore: 0.3 }
    }

    const threshold = ctx.policy.tiers?.tier1.descentRateThreshold ?? 0.8
    if (comparison.relativeDescentRate < threshold) {
      return {
        passed: false,
        reason: `Descent rate ${comparison.relativeDescentRate.toFixed(3)} below threshold ${threshold}`,
        riskScore: 0.8,
      }
    }

    return {
      passed: true,
      reason: `Smoke test passed: descent rate ${comparison.relativeDescentRate.toFixed(3)} (${comparison.verdict})`,
      riskScore: 0.1,
    }
  }
}
