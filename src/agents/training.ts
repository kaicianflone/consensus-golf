import { ulid } from 'ulid'
import type { LlmClient } from '../llm/client.js'
import { callLlmAndParse } from '../llm/client.js'
import { AgentProposalResponseSchema, type Proposal } from '../schema/proposal.js'
import type { Board } from '../schema/board.js'
import type { Precedent } from '../schema/precedent.js'
import type { AgentConfig } from '../schema/config.js'
import { buildAgentContext, buildAgentSystemPrompt } from './context.js'

const SYSTEM_PROMPT = buildAgentSystemPrompt(
  'TrainingAgent',
  'Training hyperparameter tuning via SAFE changes to existing constants. Focus on: EMBEDDING_LR, UNEMBEDDING_LR, MATRIX_LR, SCALAR_LR, WEIGHT_DECAY, ADAM_BETAS, WARMUP_RATIO, WARMDOWN_RATIO, TOTAL_BATCH_SIZE. Change the numeric values of existing constants — do NOT add new optimizer classes, new schedulers, or restructure the training loop. The existing optimizer is MuonAdamW — do NOT replace it.',
)

export async function trainingAgent(
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
    agent: 'training',
    status: 'draft',
    createdAt: new Date().toISOString(),
  }
}
