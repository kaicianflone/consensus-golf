import { describe, it, expect } from 'vitest'
import { shouldMerge } from '../../src/policy/merge-policy.js'
import { Board } from '../../src/schema/board.js'

const baseBoard: Board = {
  id: 'board_01',
  name: 'Test Board',
  description: 'Testing merge policy',
  baseline: { valBpb: 1.2244, artifactBytes: 15_000_000, commitRef: 'abc123' },
  currentBest: {
    valBpb: 1.2244,
    artifactBytes: 15_000_000,
    commitRef: 'abc123',
    proposalId: '',
  },
  activeCycle: 1,
  status: 'active',
}

const config = {
  minBpbImprovement: 0.001,
  requireArtifactWithinLimit: true,
  archiveNegativeResults: true,
}

const maxArtifactBytes = 20_000_000

describe('shouldMerge', () => {
  it('approves when BPB improves by more than threshold', () => {
    const metrics = { valBpb: 1.2200, artifactBytes: 14_000_000 }
    expect(shouldMerge(metrics, baseBoard, config, maxArtifactBytes)).toBe(true)
  })

  it('rejects when BPB improvement is less than threshold', () => {
    const metrics = { valBpb: 1.2240, artifactBytes: 14_000_000 }
    // improvement = 1.2244 - 1.2240 = 0.0004 < 0.001
    expect(shouldMerge(metrics, baseBoard, config, maxArtifactBytes)).toBe(false)
  })

  it('rejects when BPB is equal to currentBest (no improvement)', () => {
    const metrics = { valBpb: 1.2244, artifactBytes: 14_000_000 }
    expect(shouldMerge(metrics, baseBoard, config, maxArtifactBytes)).toBe(false)
  })

  it('rejects when BPB is worse', () => {
    const metrics = { valBpb: 1.3000, artifactBytes: 14_000_000 }
    expect(shouldMerge(metrics, baseBoard, config, maxArtifactBytes)).toBe(false)
  })

  it('rejects when artifact exceeds limit and requireArtifactWithinLimit is true', () => {
    const metrics = { valBpb: 1.2000, artifactBytes: 25_000_000 }
    expect(shouldMerge(metrics, baseBoard, config, maxArtifactBytes)).toBe(false)
  })

  it('approves when artifact exceeds limit but requireArtifactWithinLimit is false', () => {
    const metrics = { valBpb: 1.2000, artifactBytes: 25_000_000 }
    const relaxedConfig = { ...config, requireArtifactWithinLimit: false }
    expect(shouldMerge(metrics, baseBoard, relaxedConfig, maxArtifactBytes)).toBe(true)
  })

  it('rejects when valBpb is undefined', () => {
    const metrics = { artifactBytes: 14_000_000 }
    expect(shouldMerge(metrics, baseBoard, config, maxArtifactBytes)).toBe(false)
  })

  it('approves when artifactBytes is undefined and requireArtifactWithinLimit is true', () => {
    // No artifactBytes provided => cannot exceed limit, so pass
    const metrics = { valBpb: 1.2000 }
    expect(shouldMerge(metrics, baseBoard, config, maxArtifactBytes)).toBe(true)
  })
})
