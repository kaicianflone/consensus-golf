import { ulid } from 'ulid'
import type { LlmClient } from '../llm/client.js'
import { callLlmAndParse } from '../llm/client.js'
import { AgentProposalResponseSchema, type Proposal } from '../schema/proposal.js'
import type { Board } from '../schema/board.js'
import type { Precedent } from '../schema/precedent.js'
import type { AgentConfig } from '../schema/config.js'
import { buildAgentContext, buildAgentSystemPrompt } from './context.js'

const SYSTEM_PROMPT = buildAgentSystemPrompt(
  'CompressionAgent',
  'Parameter efficiency through SAFE changes to default values in the Hyperparameters dataclass. READ THE SOURCE CODE to find the exact field names and their current defaults. Focus on: aspect_ratio (controls model_dim = depth * aspect_ratio), n_kv_head for grouped query attention, depth/model_dim tradeoffs for parameter count. Do NOT add quantization code, new classes, or change the serialization pipeline. Do NOT change vocab_size (it must match the tokenizer).',
)

export async function compressionAgent(
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
    agent: 'compression',
    status: 'draft',
    createdAt: new Date().toISOString(),
  }
}
