import { z } from 'zod'

export const AuditEventSchema = z.object({
  id: z.string(),
  timestamp: z.string(),
  cycle: z.number(),
  eventType: z.enum([
    'proposal_created', 'judgment_issued', 'proposal_approved', 'proposal_rejected',
    'run_started', 'run_completed', 'run_failed', 'run_cancelled',
    'precedent_created', 'baseline_updated', 'policy_changed',
    'tier_gate_passed', 'tier_gate_failed',
  ]),
  entityId: z.string(),
  agentId: z.string().optional(),
  summary: z.string(),
  data: z.record(z.string(), z.unknown()),
})
export type AuditEvent = z.infer<typeof AuditEventSchema>
