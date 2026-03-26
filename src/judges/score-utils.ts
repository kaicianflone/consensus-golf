import type { Judgment } from '../schema/judgment.js'

const WEIGHTS = {
  novelty: 0.15,
  plausibility: 0.25,
  expectedGain: 0.30,
  compliance: 0.20,
  simplicity: 0.10,
}

export function computeCompositeScore(scores: Judgment['scores']): number {
  return (
    scores.novelty * WEIGHTS.novelty +
    scores.plausibility * WEIGHTS.plausibility +
    scores.expectedGain * WEIGHTS.expectedGain +
    scores.compliance * WEIGHTS.compliance +
    scores.simplicity * WEIGHTS.simplicity
  )
}
