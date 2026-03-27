import { z } from 'zod'

export const Tier0ConfigSchema = z.object({
  riskThreshold: z.number().min(0).max(1).default(0.7),
})
export type Tier0Config = z.infer<typeof Tier0ConfigSchema>

export const Tier1ConfigSchema = z.object({
  descentRateThreshold: z.number().default(0.8),
  maxPromotions: z.number().default(2),
})
export type Tier1Config = z.infer<typeof Tier1ConfigSchema>

export const TiersConfigSchema = z.object({
  tier0: Tier0ConfigSchema.default({}),
  tier1: Tier1ConfigSchema.default({}),
}).default({})

export const PolicyConfigSchema = z.object({
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
  tiers: TiersConfigSchema,
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
