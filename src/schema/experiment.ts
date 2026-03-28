import { z } from 'zod'

export const ExperimentRunSchema = z.object({
  id: z.string(),
  proposalId: z.string(),
  tier: z.union([z.literal(0), z.literal(1), z.literal(2)]),
  status: z.enum(['queued', 'running', 'passed', 'failed', 'invalid', 'cancelled']),
  config: z.object({
    iterations: z.number(),
    trainBatchTokens: z.number(),
    valBatchSize: z.number(),
    maxWallclockSec: z.number(),
  }),
  metrics: z.object({
    trainLoss: z.number().optional(),
    valLoss: z.number().optional(),
    valBpb: z.number().optional(),
    artifactBytes: z.number().optional(),
    wallclockSec: z.number().optional(),
    stepLosses: z.array(z.object({
      step: z.number(),
      totalSteps: z.number(),
      trainLoss: z.number(),
    })).optional(),
  }),
  compliance: z.object({
    artifactWithinLimit: z.boolean(),
    noNetworkAccess: z.boolean(),
    reproducible: z.boolean(),
  }),
  patch: z.string(),
  stdout: z.string(),
  startedAt: z.string(),
  completedAt: z.string().optional(),
})
export type ExperimentRun = z.infer<typeof ExperimentRunSchema>
