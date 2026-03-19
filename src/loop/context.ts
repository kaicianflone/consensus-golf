import type { LlmClient } from '../llm/client.js'
import type { PolicyConfig, PgolfConfig, AgentConfig } from '../schema/config.js'
import type { AuditWriter } from '../persistence/audit-writer.js'
import type { BoardManager } from '../persistence/board-manager.js'
import type { PrecedentStore } from '../memory/precedent-store.js'
import type { ReputationTracker } from '../policy/reputation.js'
import type { ProgressReporter } from './progress.js'

export interface CycleContext {
  config: {
    policy: PolicyConfig
    pgolf: PgolfConfig
    agents: AgentConfig
  }
  llm: LlmClient
  audit: AuditWriter
  precedents: PrecedentStore
  board: BoardManager
  reputation: ReputationTracker
  progress: ProgressReporter
  workDir: string
  dryRun: boolean
}
