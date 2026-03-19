import { z } from 'zod'

export const JudgeResponseSchema = z.object({
  scores: z.object({
    novelty: z.number().min(0).max(1),
    plausibility: z.number().min(0).max(1),
    expectedGain: z.number().min(0).max(1),
    compliance: z.number().min(0).max(1),
    simplicity: z.number().min(0).max(1),
  }),
  recommendation: z.enum(['approve', 'reject', 'revise']),
  reasoning: z.string(),
})
export type JudgeResponse = z.infer<typeof JudgeResponseSchema>

export const JudgmentSchema = JudgeResponseSchema.extend({
  id: z.string(),
  proposalId: z.string(),
  judgeId: z.string(),
  compositeScore: z.number(),
  createdAt: z.string(),
})
export type Judgment = z.infer<typeof JudgmentSchema>
