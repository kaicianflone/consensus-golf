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
  'Model structure changes: layer count, dimension, attention head config, weight tying strategies, recurrence, depth sharing, low-rank decompositions. Biased toward parameter efficiency.',
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
