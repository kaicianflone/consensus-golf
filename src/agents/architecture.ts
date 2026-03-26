import { ulid } from 'ulid'
import type { LlmClient } from '../llm/client.js'
import { callLlmAndParse } from '../llm/client.js'
import { AgentProposalResponseSchema, type Proposal } from '../schema/proposal.js'
import type { Board } from '../schema/board.js'
import type { Precedent } from '../schema/precedent.js'
import type { AgentConfig } from '../schema/config.js'
import { buildAgentContext, buildAgentSystemPrompt } from './context.js'

const SYSTEM_PROMPT = buildAgentSystemPrompt(
  'ArchitectureAgent',
  'Model architecture tuning via SAFE changes to default values in the Hyperparameters dataclass. READ THE SOURCE CODE to find the exact field names and their current defaults. Focus on: depth (layer count), model_dim, n_head, n_kv_head, head_dim, window_pattern, train_seq_len. Change ONLY the default values — do NOT add new classes, modules, or layers. Small changes to these values can have big impact on val_bpb.',
)

export async function architectureAgent(
  llm: LlmClient,
  board: Board,
  precedents: Precedent[],
  sourceCode: string,
  config: AgentConfig,
): Promise<Proposal> {
  const context = buildAgentContext(board, precedents, sourceCode)
  const response = await callLlmAndParse(
    llm,
    SYSTEM_PROMPT,
    context,
    config.agentMaxTokens,
    AgentProposalResponseSchema,
  )
  return {
    ...response,
    id: ulid(),
    boardId: board.id,
    agent: 'architecture',
    status: 'draft',
    createdAt: new Date().toISOString(),
  }
}
