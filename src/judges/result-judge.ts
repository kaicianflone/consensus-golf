import { z } from 'zod'
import { LlmClient, callLlmAndParse } from '../llm/client.js'
import { type Proposal } from '../schema/proposal.js'
import { type ExperimentRun } from '../schema/experiment.js'
import { type Precedent } from '../schema/precedent.js'
import { type Board } from '../schema/board.js'
import { ulid } from 'ulid'

const ResultJudgeResponseSchema = z.object({
  family: z.string(),
  summary: z.string(),
  outcome: z.enum(['positive', 'negative', 'invalid', 'uncertain']),
  tags: z.array(z.string()),
})

const SYSTEM_PROMPT = `You are an expert machine learning research analyst evaluating completed experiment runs.

Given a proposal and its run results, classify the experiment and provide a summary.

Output a JSON object with the following structure:
{
  "family": "<technique family, e.g. 'attention-optimization', 'quantization', 'regularization'>",
  "summary": "<concise summary of what was tried and what happened>",
  "outcome": "positive" | "negative" | "invalid" | "uncertain",
  "tags": ["<tag1>", "<tag2>", ...]
}

Outcome definitions:
- positive: The experiment improved validation bits-per-byte
- negative: The experiment was valid but did not improve metrics
- invalid: The experiment failed to run or produced invalid results
- uncertain: Results are ambiguous or inconclusive

Output only valid JSON.`

export async function judgeResult(
  llm: LlmClient,
  proposal: Proposal,
  run: ExperimentRun,
  board: Board,
  maxTokens: number,
): Promise<Precedent> {
  const delta =
    run.metrics.valBpb !== undefined
      ? run.metrics.valBpb - board.baseline.valBpb
      : undefined

  const userMessage = `## Proposal
Title: ${proposal.title}
Agent: ${proposal.agent}
Category: ${proposal.category}
Thesis: ${proposal.thesis}
Patch Description: ${proposal.patchDescription}

## Run Result
Status: ${run.status}
Val BPB: ${run.metrics.valBpb ?? 'N/A'}
Val Loss: ${run.metrics.valLoss ?? 'N/A'}
Artifact Bytes: ${run.metrics.artifactBytes ?? 'N/A'}

## Baseline
Baseline valBpb: ${board.baseline.valBpb}
Delta (candidate - baseline): ${delta !== undefined ? delta.toFixed(6) : 'N/A'}

Please evaluate this completed run and return your assessment as JSON.`

  const judgeResponse = await callLlmAndParse(
    llm,
    SYSTEM_PROMPT,
    userMessage,
    maxTokens,
    ResultJudgeResponseSchema,
  )

  const precedent: Precedent = {
    id: ulid(),
    sourceProposalId: proposal.id,
    sourceRunId: run.id,
    category: proposal.category,
    family: judgeResponse.family,
    summary: judgeResponse.summary,
    outcome: judgeResponse.outcome,
    metrics: {
      baselineValBpb: board.baseline.valBpb,
      candidateValBpb: run.metrics.valBpb,
      delta,
    },
    tags: judgeResponse.tags,
    createdAt: new Date().toISOString(),
  }

  return precedent
}
