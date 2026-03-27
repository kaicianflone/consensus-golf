import { describe, it, expect } from 'vitest'
import { getExplorerForCycle, buildExplorationDirective } from '../../src/agents/exploration.js'
import type { TaxonomyData } from '../../src/memory/technique-coverage.js'

describe('getExplorerForCycle', () => {
  it('returns 0 for cycle 0 with 3 agents', () => {
    expect(getExplorerForCycle(0, 3)).toBe(0)
  })

  it('returns 1 for cycle 1 with 3 agents', () => {
    expect(getExplorerForCycle(1, 3)).toBe(1)
  })

  it('returns 2 for cycle 2 with 3 agents', () => {
    expect(getExplorerForCycle(2, 3)).toBe(2)
  })

  it('wraps around: cycle 3 with 3 agents returns 0', () => {
    expect(getExplorerForCycle(3, 3)).toBe(0)
  })

  it('wraps correctly: cycle 7 with 3 agents returns 1', () => {
    expect(getExplorerForCycle(7, 3)).toBe(1)
  })
})

describe('buildExplorationDirective', () => {
  it('returns string containing target names and descriptions', () => {
    const taxonomy: TaxonomyData = {
      families: {
        'depth-scaling': { category: 'architecture', description: 'Increase/decrease layer count', tags: ['depth'] },
        'learning-rate': { category: 'training', description: 'Adjust learning rates', tags: ['lr'] },
      },
    }

    const result = buildExplorationDirective(['depth-scaling', 'learning-rate'], taxonomy)

    expect(result).toContain('EXPLORATION MODE')
    expect(result).toContain('depth-scaling')
    expect(result).toContain('Increase/decrease layer count')
    expect(result).toContain('learning-rate')
    expect(result).toContain('Adjust learning rates')
    expect(result).toContain('Prioritize novelty')
  })

  it('handles unknown targets gracefully', () => {
    const taxonomy: TaxonomyData = { families: {} }
    const result = buildExplorationDirective(['unknown-family'], taxonomy)

    expect(result).toContain('unknown-family')
    expect(result).toContain('no description available')
  })
})
