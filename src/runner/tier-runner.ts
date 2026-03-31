import type { Proposal } from '../schema/proposal.js'
import type { ExperimentRun } from '../schema/experiment.js'
import type { PolicyConfig, PgolfConfig } from '../schema/config.js'
import type { LossCurveSignal, BaselineComparison } from './loss-curve-analyzer.js'
import type { BaselineCurve } from '../persistence/baseline-manager.js'

export type TierNumber = 0 | 1 | 2 | 3

export interface TierGateResult {
  passed: boolean
  reason: string
  riskScore?: number
  guardAuditId?: string
}

export interface TierRunResult {
  tier: TierNumber
  proposal: Proposal
  preGate: TierGateResult
  run?: ExperimentRun
  curveSignal?: LossCurveSignal
  baselineComparison?: BaselineComparison
  postGate: TierGateResult
  promotable: boolean
}

export interface TierRunnerContext {
  sourceCode: string
  boardId: string
  workDir: string
  policy: PolicyConfig
  pgolf: PgolfConfig
  baselineCurve: BaselineCurve | null
  baselineCurves?: Map<number, BaselineCurve>
  onProgress?: (agent: string, line: string) => void
}

export interface TierRunner {
  readonly tier: TierNumber
  run(proposal: Proposal, ctx: TierRunnerContext): Promise<TierRunResult>
}
