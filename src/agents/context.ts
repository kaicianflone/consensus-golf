import type { Board } from '../schema/board.js'
import type { Precedent } from '../schema/precedent.js'

export function buildAgentContext(
  board: Board,
  precedents: Precedent[],
  sourceCode: string,
): string {
  const sections: string[] = []

  // 1. Board state
  sections.push(
    [
      '## Board State',
      `Name: ${board.name}`,
      `Baseline val_bpb: ${board.baseline.valBpb}`,
      `Current best val_bpb: ${board.currentBest.valBpb}`,
      `Artifact bytes: ${board.currentBest.artifactBytes}`,
      `Active cycle: ${board.activeCycle}`,
    ].join('\n'),
  )

  // 2. Precedents
  if (precedents.length > 0) {
    const precedentLines = precedents.map((p) => {
      const deltaStr =
        p.metrics.delta !== undefined
          ? (p.metrics.delta >= 0 ? `+${p.metrics.delta.toFixed(4)}` : p.metrics.delta.toFixed(4))
          : 'N/A'
      return `[${p.outcome.toUpperCase()}] Family: ${p.family}. ${p.summary} (delta: ${deltaStr})`
    })
    sections.push(['## Prior Experiments', ...precedentLines].join('\n'))
  } else {
    sections.push('## Prior Experiments\nNo prior experiments.')
  }

  // 3. Challenge constraints
  sections.push(
    [
      '## Challenge Constraints',
      '- Maximum artifact size: 16MB',
      '- Maximum wallclock time: 10 minutes',
      '- Metric: val_bpb (lower is better)',
      '- Tokenizer: SentencePiece with vocab size 1024',
      '- Model must be a valid GPT-style architecture compatible with the train script',
      '- TRAIN_BATCH_TOKENS <= 4096',
    ].join('\n'),
  )

  // 4. Source code
  sections.push(`## Current train_gpt_mlx.py source:\n\n${sourceCode}`)

  return sections.join('\n\n')
}

export function buildAgentSystemPrompt(agentName: string, specialty: string): string {
  return `You are ${agentName}, an AI research agent specializing in: ${specialty}

You are proposing an experiment, not writing code for code's sake.

Your response must be a single JSON object matching this schema exactly:

{
  "title": string,           // Short descriptive title of the experiment
  "category": string,        // One of: "architecture", "training", "compression", "evaluation"
  "thesis": string,          // Why you believe this change will improve the metric
  "patchDescription": string, // Human-readable description of what changed and why
  "modifiedSource": string,  // The COMPLETE modified train_gpt_mlx.py file content
  "predictedImpact": {
    "valBpbDelta": number,   // Optional: expected change in val_bpb (negative = improvement)
    "artifactBytesDelta": number // Optional: expected change in artifact size
  },
  "risks": string[],         // Array of potential failure modes or risks
  "precedentRefs": string[]  // Array of precedent IDs that informed this proposal
}

Rules:
- Output ONLY JSON. No markdown fences, no explanation text outside the JSON.
- modifiedSource must be the COMPLETE file, not a diff or partial snippet.
- Reference relevant precedentRefs by their IDs to show what prior experiments informed your proposal.
- Propose exactly one hypothesis per response.
- TRAIN_BATCH_TOKENS must remain <= 4096.`
}
