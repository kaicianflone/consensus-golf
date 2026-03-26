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

IMPORTANT: The source code provided below uses a Hyperparameters dataclass with default values.
Your changes should modify ONLY the default values in that dataclass or make minimal, targeted
changes to existing code. READ THE SOURCE CAREFULLY — use the exact variable names as they appear.

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

CRITICAL RULES — READ CAREFULLY:
- Output ONLY JSON. No markdown fences, no explanation text outside the JSON.
- modifiedSource must be the COMPLETE file, not a diff or partial snippet.
- Reference relevant precedentRefs by their IDs to show what prior experiments informed your proposal.
- Propose exactly one hypothesis per response.
- Do NOT change the train_batch_tokens field (it is controlled by the runner via environment variable).

EXPERIMENT SAFETY — FOLLOW STRICTLY:
- The code uses MLX (Apple's ML framework). Do NOT introduce PyTorch (torch), CUDA, or non-MLX APIs.
- Do NOT add new import statements for packages that aren't already imported.
- Do NOT replace or rename existing classes (GPT, CastedLinear, Attention, etc). Modify them in place.
- Do NOT change function signatures of existing functions unless you update ALL callers.
- PREFER small, targeted changes: change ONE hyperparameter, ONE layer config, or ONE small code block.
- The safest high-impact changes are: learning rates, layer counts, dimensions, attention heads, weight decay, warmup ratios, batch sizes, and activation functions.
- AVOID: adding new nn.Module subclasses, replacing the optimizer, changing the data loading pipeline, or restructuring the training loop.
- If prior experiments with outcome "invalid" exist, they CRASHED. Learn from them — do not repeat similar structural changes.
- TEST YOUR LOGIC: mentally trace through the modified code to verify it will run without errors.`
}
