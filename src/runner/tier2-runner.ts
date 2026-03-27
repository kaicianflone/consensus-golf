import type { TierRunner, TierRunResult, TierRunnerContext } from './tier-runner.js'
import type { Proposal } from '../schema/proposal.js'

export class Tier2Runner implements TierRunner {
  readonly tier = 2 as const

  async run(proposal: Proposal, _ctx: TierRunnerContext): Promise<TierRunResult> {
    return {
      tier: 2,
      proposal,
      preGate: { passed: false, reason: 'Tier 2 (RunPods) not available yet' },
      postGate: { passed: false, reason: 'Tier 2 (RunPods) not available yet' },
      promotable: false,
    }
  }
}
