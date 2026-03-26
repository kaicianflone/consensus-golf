import type { LocalBoard } from '@consensus-tools/core'
import type { Proposal } from '../schema/proposal.js'
import type { Judgment } from '../schema/judgment.js'
import type { ConsensusConfig } from '../schema/config.js'

export class ConsensusBridge {
  private proposalJobs = new Map<string, { jobId: string; submissionId: string }>()

  constructor(
    private readonly board: LocalBoard,
    private readonly config: ConsensusConfig,
  ) {}

  async postProposalJob(cycleNumber: number, proposalId?: string): Promise<string> {
    const job = await this.board.engine.postJob('orchestrator', {
      title: `Cycle ${cycleNumber} proposal ${proposalId ?? 'evaluation'}`,
      description: `Evaluate proposal ${proposalId ?? '?'} in cycle ${cycleNumber}`,
      mode: 'VOTING',
      maxParticipants: 1,
      stakeRequired: this.config.stakeRequired,
      expiresSeconds: this.config.jobExpiresSeconds,
      consensusPolicy: {
        type: this.config.policy.type,
        quorum: this.config.policy.quorum,
        minScore: this.config.policy.minScore,
        minMargin: this.config.policy.minMargin,
        tieBreak: this.config.policy.tieBreak,
        approvalVote: {
          weightMode: this.config.policy.weightMode,
        },
      },
      tags: [`cycle-${cycleNumber}`],
    })
    return job.id
  }

  async submitProposal(agentId: string, jobId: string, proposal: Proposal, compositeScore: number): Promise<void> {
    await this.board.ledger.ensureInitialCredits(agentId)
    await this.board.engine.claimJob(agentId, jobId, {
      stakeAmount: this.config.stakeRequired,
      leaseSeconds: this.config.jobExpiresSeconds,
    })
    const submission = await this.board.engine.submitJob(agentId, jobId, {
      summary: `${proposal.title}: ${proposal.thesis}`,
      artifacts: { proposalId: proposal.id, agent: proposal.agent, title: proposal.title, category: proposal.category, compositeScore },
      confidence: compositeScore,
    })
    this.proposalJobs.set(proposal.id, { jobId, submissionId: submission.id })
  }

  async castJudgmentVote(judgeId: string, jobId: string, proposalId: string, judgment: Judgment): Promise<void> {
    const entry = this.proposalJobs.get(proposalId)
    if (!entry) throw new Error(`No submission found for proposal ${proposalId}`)
    await this.board.ledger.ensureInitialCredits(judgeId)
    await this.board.engine.vote(judgeId, jobId, {
      submissionId: entry.submissionId,
      score: judgment.recommendation === 'approve' ? 1 : judgment.recommendation === 'revise' ? 0 : -1,
      weight: judgment.compositeScore,
      rationale: judgment.reasoning,
    })
  }

  async resolveProposal(jobId: string, proposalId: string): Promise<boolean> {
    const resolution = await this.board.engine.resolveJob('orchestrator', jobId)
    return resolution.winningSubmissionIds.length > 0
  }

  async resolveAllProposals(): Promise<string[]> {
    const approved: string[] = []
    for (const [proposalId, { jobId }] of this.proposalJobs.entries()) {
      try {
        const isApproved = await this.resolveProposal(jobId, proposalId)
        if (isApproved) approved.push(proposalId)
      } catch { /* Resolution failed — treat as rejected */ }
    }
    return approved
  }

  clearCycleState(): void { this.proposalJobs.clear() }

  getJobIdForProposal(proposalId: string): string | undefined {
    return this.proposalJobs.get(proposalId)?.jobId
  }

  async rewardAgent(agentId: string, amount: number, reason: string): Promise<void> {
    await this.board.ledger.payout(agentId, amount, undefined)
  }

  async slashAgent(agentId: string, amount: number, reason: string): Promise<void> {
    await this.board.ledger.slash(agentId, amount, undefined, reason)
  }

  async getAgentBalance(agentId: string): Promise<number> {
    return this.board.ledger.getBalance(agentId)
  }

  async getAllBalances(): Promise<Record<string, number>> {
    const all = await this.board.ledger.getBalances()
    const agentSet = new Set(this.config.agents)
    const filtered: Record<string, number> = {}
    for (const [id, balance] of Object.entries(all)) {
      if (agentSet.has(id)) filtered[id] = balance
    }
    return filtered
  }

  async getJobStatus(jobId: string) {
    return this.board.engine.getStatus(jobId)
  }
}
