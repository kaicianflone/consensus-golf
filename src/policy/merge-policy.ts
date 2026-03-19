import { Board } from '../schema/board.js'

export function shouldMerge(
  metrics: { valBpb?: number; artifactBytes?: number },
  board: Board,
  config: {
    minBpbImprovement: number
    requireArtifactWithinLimit: boolean
    archiveNegativeResults: boolean
  },
  maxArtifactBytes: number,
): boolean {
  if (metrics.valBpb === undefined) return false

  const improvement = board.currentBest.valBpb - metrics.valBpb
  if (improvement < config.minBpbImprovement) return false

  if (
    config.requireArtifactWithinLimit &&
    metrics.artifactBytes !== undefined &&
    metrics.artifactBytes > maxArtifactBytes
  ) {
    return false
  }

  return true
}
