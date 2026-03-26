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
  'Training hyperparameter tuning via SAFE changes to default values in the Hyperparameters dataclass. READ THE SOURCE CODE to find the exact field names and their current defaults. Change ONLY the default values of existing fields — do NOT add new fields, new optimizer classes, new schedulers, or restructure the training loop. Focus on learning rates (tied_embed_lr, matrix_lr, scalar_lr), weight_decay, adam_betas, warmup/cooldown ratios, and batch sizes. The existing optimizer is MuonAdamW — do NOT replace it.',
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
