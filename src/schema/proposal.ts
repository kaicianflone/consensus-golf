import { z } from 'zod'

export const AgentProposalResponseSchema = z.object({
  title: z.string(),
  category: z.enum(['architecture', 'training', 'compression', 'evaluation', 'baseline']),
  thesis: z.string(),
  patchDescription: z.string(),
  modifiedSource: z.string(),
  predictedImpact: z.object({
    valBpbDelta: z.number().optional(),
    artifactBytesDelta: z.number().optional(),
  }),
  risks: z.array(z.string()),
  precedentRefs: z.array(z.string()),
})
export type AgentProposalResponse = z.infer<typeof AgentProposalResponseSchema>

export const ProposalSchema = AgentProposalResponseSchema.extend({
  id: z.string(),
  boardId: z.string(),
  agent: z.string(),
  status: z.enum(['draft', 'voting', 'approved', 'rejected', 'executed', 'merged']),
  createdAt: z.string(),
})
export type Proposal = z.infer<typeof ProposalSchema>
