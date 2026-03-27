import type { TierRunner, TierRunResult, TierRunnerContext, TierGateResult } from './tier-runner.js'
import type { Proposal } from '../schema/proposal.js'
import { checkCompliance } from '../judges/compliance-check.js'

export class Tier0Runner implements TierRunner {
  readonly tier = 0 as const

  async run(proposal: Proposal, ctx: TierRunnerContext): Promise<TierRunResult> {
    const gate = await this.evaluate(proposal, ctx)
    return {
      tier: 0,
      proposal,
      preGate: gate,
      postGate: gate,
      promotable: gate.passed,
    }
  }

  private async evaluate(proposal: Proposal, ctx: TierRunnerContext): Promise<TierGateResult> {
    try {
      const compliance = await checkCompliance(proposal.modifiedSource, ctx.sourceCode)
      if (!compliance.syntaxValid) {
        return { passed: false, reason: `syntax error: ${compliance.syntaxError ?? 'unknown'}`, riskScore: 1.0 }
      }
      if (!compliance.securityScan.safe) {
        return { passed: false, reason: `security scan blocked: ${compliance.securityScan.blockedPatterns.join(', ')}`, riskScore: 1.0 }
      }
      return { passed: true, reason: 'compliance passed', riskScore: 0.0 }
    } catch (err) {
      return { passed: false, reason: `compliance check error: ${String(err)}`, riskScore: 1.0 }
    }
  }
}
