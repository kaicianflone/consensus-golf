import { type LlmClient, callLlmAndParse } from '../llm/client.js'
import { JudgeResponseSchema, type Judgment } from '../schema/judgment.js'
import type { Proposal } from '../schema/proposal.js'
import type { Board } from '../schema/board.js'
import type { Precedent } from '../schema/precedent.js'
import { computeCompositeScore } from './score-utils.js'
import { ulid } from 'ulid'

export interface JudgePersona {
  id: string
  name: string
  systemPrompt: string
}

const BASE_SCORING_INSTRUCTIONS = `Score each dimension from 0 to 1 and output a JSON object:
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
Output only valid JSON.`

export function getJudgePersonas(): JudgePersona[] {
  return [
    {
      id: 'judge-conservative',
      name: 'Conservative Judge',
      systemPrompt: `You are a conservative ML research judge. You prioritize safety, compliance, and proven approaches.
You are skeptical of large architectural changes and prefer incremental improvements with strong theoretical backing.
Weight compliance and plausibility heavily. Only recommend "approve" when risks are minimal and the approach is well-grounded.

${BASE_SCORING_INSTRUCTIONS}`,
    },
    {
      id: 'judge-innovative',
      name: 'Innovative Judge',
      systemPrompt: `You are an innovation-focused ML research judge. You reward creative and novel approaches.
You are willing to accept higher risk for potentially higher reward. Novel combinations of techniques excite you.
Weight novelty and expectedGain heavily. Recommend "approve" for bold ideas with sound reasoning, even if risky.

${BASE_SCORING_INSTRUCTIONS}`,
    },
    {
      id: 'judge-efficiency',
      name: 'Efficiency Judge',
      systemPrompt: `You are an efficiency-focused ML research judge. You prioritize simplicity and parameter efficiency.
You prefer changes that achieve more with less — fewer parameters, cleaner code, better compression.
Weight simplicity and expectedGain heavily. Recommend "approve" for elegant solutions that reduce complexity.

${BASE_SCORING_INSTRUCTIONS}`,
    },
  ]
}

export async function runMultiJudge(
  llm: LlmClient,
  proposal: Proposal,
  board: Board,
  precedents: Precedent[],
  maxTokens: number,
): Promise<Judgment[]> {
  const personas = getJudgePersonas()

  const precedentSummaries =
    precedents.length > 0
      ? precedents
          .map((p) => `- [${p.outcome}] ${p.family}: ${p.summary} (delta: ${p.metrics.delta ?? 'N/A'})`)
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

  const results = await Promise.allSettled(
    personas.map(async (persona) => {
      const response = await callLlmAndParse(
        llm,
        persona.systemPrompt,
        userMessage,
        maxTokens,
        JudgeResponseSchema,
      )
      const judgment: Judgment = {
        ...response,
        id: ulid(),
        proposalId: proposal.id,
        judgeId: persona.id,
        compositeScore: computeCompositeScore(response.scores),
        createdAt: new Date().toISOString(),
      }
      return judgment
    }),
  )

  const judgments: Judgment[] = []
  for (const result of results) {
    if (result.status === 'fulfilled') {
      judgments.push(result.value)
    }
  }

  return judgments
}
