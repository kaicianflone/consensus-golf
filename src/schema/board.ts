import { z } from 'zod'

export const BoardSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  baseline: z.object({
    valBpb: z.number(),
    artifactBytes: z.number(),
    commitRef: z.string(),
  }),
  currentBest: z.object({
    valBpb: z.number(),
    artifactBytes: z.number(),
    commitRef: z.string(),
    proposalId: z.string(),
  }),
  activeCycle: z.number(),
  status: z.enum(['active', 'paused', 'completed']),
})
export type Board = z.infer<typeof BoardSchema>
