import { z } from 'zod'

export const PrecedentSchema = z.object({
  id: z.string(),
  sourceProposalId: z.string(),
  sourceRunId: z.string().optional(),
  category: z.string(),
  family: z.string(),
  summary: z.string(),
  outcome: z.enum(['positive', 'negative', 'invalid', 'uncertain']),
  metrics: z.object({
    baselineValBpb: z.number(),
    candidateValBpb: z.number().optional(),
    delta: z.number().optional(),
  }),
  tags: z.array(z.string()),
  createdAt: z.string(),
})
export type Precedent = z.infer<typeof PrecedentSchema>
