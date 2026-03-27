import type { Proposal } from '../schema/proposal.js'
import type { TierRunner, TierRunResult, TierRunnerContext, TierNumber } from './tier-runner.js'
import type { AuditWriter } from '../persistence/audit-writer.js'

export class PipelineOrchestrator {
  private readonly runnerMap: Map<TierNumber, TierRunner>

  constructor(
    runners: TierRunner[],
    private readonly audit?: AuditWriter,
  ) {
    this.runnerMap = new Map()
    for (const runner of runners) {
      this.runnerMap.set(runner.tier, runner)
    }
  }

  async runTier(
    tierNumber: TierNumber,
    proposals: Proposal[],
    ctx: TierRunnerContext,
    cycleNum: number,
  ): Promise<TierRunResult[]> {
    const runner = this.runnerMap.get(tierNumber)
    if (!runner) {
      return proposals.map(p => ({
        tier: tierNumber,
        proposal: p,
        preGate: { passed: false, reason: `No runner for tier ${tierNumber}` },
        postGate: { passed: false, reason: `No runner for tier ${tierNumber}` },
        promotable: false,
      }))
    }

    // Tier 0: parallel (instant, CPU-only)
    // Tier 1+: sequential (GPU-bound)
    let results: TierRunResult[]
    if (tierNumber === 0) {
      results = await Promise.all(proposals.map(p => runner.run(p, ctx)))
    } else {
      results = []
      for (const proposal of proposals) {
        const result = await runner.run(proposal, ctx)
        results.push(result)
      }
    }

    // Audit each result
    for (const result of results) {
      this.auditGate(cycleNum, result)
    }

    return results
  }

  getPromoted(tier1Results: TierRunResult[], maxPromotions: number): TierRunResult[] {
    return tier1Results
      .filter(r => r.promotable)
      .sort((a, b) => {
        const aRate = a.baselineComparison?.relativeDescentRate ?? 0
        const bRate = b.baselineComparison?.relativeDescentRate ?? 0
        return bRate - aRate
      })
      .slice(0, maxPromotions)
  }

  private auditGate(cycleNum: number, result: TierRunResult): void {
    if (!this.audit) return
    const eventType = result.promotable ? 'tier_gate_passed' : 'tier_gate_failed'
    this.audit.write(
      cycleNum,
      eventType,
      result.proposal.id,
      `Tier ${result.tier}: ${result.postGate.reason}`,
      {
        tier: result.tier,
        riskScore: result.postGate.riskScore,
        guardAuditId: result.postGate.guardAuditId,
        passed: result.promotable,
      },
      result.proposal.agent,
    )
  }
}
