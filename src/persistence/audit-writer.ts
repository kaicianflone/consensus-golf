import { ulid } from 'ulid'
import { appendJsonl } from './jsonl.js'
import { type AuditEvent, AuditEventSchema } from '../schema/audit.js'

export class AuditWriter {
  constructor(private readonly filePath: string) {}

  write(
    cycle: number,
    eventType: AuditEvent['eventType'],
    entityId: string,
    summary: string,
    data?: Record<string, unknown>,
    agentId?: string,
  ): AuditEvent {
    const event: AuditEvent = AuditEventSchema.parse({
      id: ulid(),
      timestamp: new Date().toISOString(),
      cycle,
      eventType,
      entityId,
      summary,
      data: data ?? {},
      ...(agentId !== undefined ? { agentId } : {}),
    })

    appendJsonl(this.filePath, event)
    return event
  }
}
