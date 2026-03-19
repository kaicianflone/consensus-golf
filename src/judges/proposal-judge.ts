import { LlmClient, callLlmAndParse } from '../llm/client.js'
import { JudgeResponseSchema, type Judgment } from '../schema/judgment.js'
import { type Proposal } from '../schema/proposal.js'
import { type Board } from '../schema/board.js'
import { type Precedent } from '../schema/precedent.js'
import { computeCompositeScore } from '../policy/approval-policy.js'
import { ulid } from 'ulid'

const SYSTEM_PROMPT = `You are an expert machine learning research judge evaluating proposals to improve a language model.

Score each dimension from 0 to 1 and output a JSON object with the following structure:
{
  "scores": {
    "novelty": <0-1>,
    "plausibility": <0-1>,
    "expectedGain": <0-1>,
    "compliance": <0-1>,
    "simplicity": <0-1>
  },
  "recommendation": "approve" | "reject" | "revise",
  "reasoning": "<explanation>"
}

Scoring guidelines:
- novelty: How novel is this approach relative to known techniques and precedents?
- plausibility: How plausible is it that this change would work as described?
- expectedGain: How much improvement is expected in validation bits-per-byte?
- compliance: Does the proposal follow safety and compliance guidelines?
- simplicity: How simple and clean is the proposed change?

Output only valid JSON.`

export async function judgeProposal(
  llm: LlmClient,
  proposal: Proposal,
  board: Board,
  precedents: Precedent[],
  maxTokens: number,
): Promise<Judgment> {
  const precedentSummaries = precedents.length > 0
    ? precedents
        .map(
          (p) =>
            `- [${p.outcome}] ${p.family}: ${p.summary} (delta: ${p.metrics.delta ?? 'N/A'})`,
        )
        .join('\n')
    : 'No relevant precedents.'

  const userMessage = `## Board State
Name: ${board.name}
Baseline valBpb: ${board.baseline.valBpb}
Current Best valBpb: ${board.currentBest.valBpb}

## Proposal
Title: ${proposal.title}
Agent: ${proposal.agent}
Category: ${proposal.category}
Thesis: ${proposal.thesis}
Patch Description: ${proposal.patchDescription}
Predicted Impact: ${JSON.stringify(proposal.predictedImpact)}
Risks: ${proposal.risks.join(', ')}

## Relevant Precedents
${precedentSummaries}

Please evaluate this proposal and return your judgment as JSON.`

  const judgeResponse = await callLlmAndParse(
    llm,
    SYSTEM_PROMPT,
    userMessage,
    maxTokens,
    JudgeResponseSchema,
  )

  const judgment: Judgment = {
    ...judgeResponse,
    id: ulid(),
    proposalId: proposal.id,
    judgeId: 'proposal-judge',
    compositeScore: computeCompositeScore(judgeResponse.scores),
    createdAt: new Date().toISOString(),
  }

  return judgment
}
