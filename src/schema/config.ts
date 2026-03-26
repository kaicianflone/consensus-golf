import { z } from 'zod'

export const PolicyConfigSchema = z.object({
  approval: z.object({
    minCompositeScore: z.number(),
    minCompliance: z.number(),
    maxProposalsPerCycle: z.number(),
    maxApprovedPerCycle: z.number(),
  }),
  execution: z.object({
    smokeIterations: z.number(),
    smokeBatchTokens: z.number(),
    smokeMaxWallclockSec: z.number(),
    valBatchSize: z.number(),
    requireSmokeBeforeFull: z.boolean(),
  }),
  merge: z.object({
    minBpbImprovement: z.number(),
    requireArtifactWithinLimit: z.boolean(),
    archiveNegativeResults: z.boolean(),
  }),
  reputation: z.object({
    rewardMerge: z.number(),
    rewardUsefulNegative: z.number(),
    penalizeInvalid: z.number(),
    penalizeNoncompliant: z.number(),
  }),
})
export type PolicyConfig = z.infer<typeof PolicyConfigSchema>

export const PgolfConfigSchema = z.object({
  repoPath: z.string(),
  trainScript: z.string(),
  dataPath: z.string(),
  tokenizerPath: z.string(),
  vocabSize: z.number(),
  baselineValBpb: z.number(),
  maxArtifactBytes: z.number(),
})
export type PgolfConfig = z.infer<typeof PgolfConfigSchema>

export const AgentConfigSchema = z.object({
  backend: z.enum(['anthropic', 'ollama']),
  model: z.string(),
  agentMaxTokens: z.number(),
  judgeMaxTokens: z.number(),
  temperature: z.number(),
})
export type AgentConfig = z.infer<typeof AgentConfigSchema>

export const ConsensusConfigSchema = z.object({
  storagePath: z.string(),
  agents: z.array(z.string()),
  initialCredits: z.number(),
  stakeRequired: z.number(),
  jobExpiresSeconds: z.number(),
  policy: z.object({
    type: z.string(),
    quorum: z.number(),
    minScore: z.number(),
    minMargin: z.number(),
    weightMode: z.string(),
    tieBreak: z.string(),
  }),
  rewards: z.object({
    merge: z.number(),
    usefulResult: z.number(),
    penalizeInvalid: z.number(),
    penalizeNoncompliant: z.number(),
  }),
  judges: z.array(z.string()),
})
export type ConsensusConfig = z.infer<typeof ConsensusConfigSchema>
