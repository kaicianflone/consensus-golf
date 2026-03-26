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
  'Model architecture tuning via SAFE changes to existing config values. Focus on: DEPTH (layer count), model dimension (n_embd), number of attention heads (n_head, n_kv_head), MLP ratio, window pattern (WINDOW_PATTERN). Change constants at the top of the file — do NOT restructure classes or add new modules. Example: try DEPTH=10 instead of 9, or change HEAD_DIM. Small changes, big impact.',
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
