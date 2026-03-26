import type { LlmClient } from '../llm/client.js'
import type { PolicyConfig, PgolfConfig, AgentConfig, ConsensusConfig } from '../schema/config.js'
import type { AuditWriter } from '../persistence/audit-writer.js'
import type { BoardManager } from '../persistence/board-manager.js'
import type { PrecedentStore } from '../memory/precedent-store.js'
import type { ProgressReporter } from './progress.js'
import type { ConsensusBridge } from '../adapter/consensus-bridge.js'

export interface CycleContext {
  config: {
    policy: PolicyConfig
    pgolf: PgolfConfig
    agents: AgentConfig
    consensus: ConsensusConfig
  }
  llm: LlmClient
  audit: AuditWriter
  precedents: PrecedentStore
  board: BoardManager
  consensus: ConsensusBridge
  progress: ProgressReporter
  workDir: string
  dryRun: boolean
}
