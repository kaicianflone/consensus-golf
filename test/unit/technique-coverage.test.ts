import { describe, it, expect } from 'vitest'
import { TechniqueCoverageTracker, type TaxonomyData } from '../../src/memory/technique-coverage.js'
import type { Precedent } from '../../src/schema/precedent.js'

const makeTaxonomy = (): TaxonomyData => ({
  families: {
    'depth-scaling': { category: 'architecture', description: 'Increase/decrease layer count', tags: ['depth', 'num_layers', 'layer-count'] },
    'width-scaling': { category: 'architecture', description: 'Adjust model dimension', tags: ['model_dim', 'width', 'dimension'] },
    'attention-config': { category: 'architecture', description: 'Modify attention heads, KV heads, GQA', tags: ['num_heads', 'num_kv_heads', 'gqa', 'attention'] },
    'learning-rate': { category: 'training', description: 'Adjust learning rates', tags: ['matrix_lr', 'scalar_lr', 'learning_rate', 'lr'] },
  },
})

const makePrecedent = (
  id: string,
  family: string,
  tags: string[],
  outcome: 'positive' | 'negative' | 'invalid' | 'uncertain' = 'positive',
): Precedent => ({
  id,
  sourceProposalId: 'p1',
  category: 'architecture',
  family,
  summary: `Test ${id}`,
  outcome,
  metrics: { baselineValBpb: 1.2244 },
  tags,
  createdAt: new Date().toISOString(),
})

describe('TechniqueCoverageTracker', () => {
  it('returns all families as unexplored with empty precedents', () => {
    const tracker = new TechniqueCoverageTracker(makeTaxonomy())
    const map = tracker.buildCoverageMap([])

    expect(map.explored).toHaveLength(0)
    expect(map.unexplored).toHaveLength(4)
    expect(map.coveragePct).toBe(0)
  })

  it('matches a single precedent with depth tag to depth-scaling family', () => {
    const tracker = new TechniqueCoverageTracker(makeTaxonomy())
    const precedents = [makePrecedent('1', 'depth', ['depth', 'layers'])]
    const map = tracker.buildCoverageMap(precedents)

    const depthEntry = map.explored.find(e => e.family === 'depth-scaling')
    expect(depthEntry).toBeDefined()
    expect(depthEntry!.trialCount).toBe(1)
    expect(depthEntry!.outcomes.positive).toBe(1)
  })

  it('matches precedent to multiple families when tags overlap', () => {
    const tracker = new TechniqueCoverageTracker(makeTaxonomy())
    const precedents = [makePrecedent('1', 'attention', ['attention', 'num_kv_heads'])]
    const map = tracker.buildCoverageMap(precedents)

    const attentionEntry = map.explored.find(e => e.family === 'attention-config')
    expect(attentionEntry).toBeDefined()
    expect(attentionEntry!.trialCount).toBe(1)
  })

  it('formatForAgent returns markdown with unexplored and explored sections', () => {
    const tracker = new TechniqueCoverageTracker(makeTaxonomy())
    const precedents = [makePrecedent('1', 'depth', ['depth'], 'positive')]
    const map = tracker.buildCoverageMap(precedents)
    const markdown = tracker.formatForAgent(map)

    expect(markdown).toContain('## Technique Coverage')
    expect(markdown).toContain('### Unexplored')
    expect(markdown).toContain('### Explored')
    expect(markdown).toContain('depth-scaling')
    expect(markdown).toContain('1 trial')
    expect(markdown).toContain('1 positive')
  })

  it('getExplorationTargets returns unexplored families first up to limit', () => {
    const tracker = new TechniqueCoverageTracker(makeTaxonomy())
    const map = tracker.buildCoverageMap([])
    const targets = tracker.getExplorationTargets(map, 3)

    expect(targets).toHaveLength(3)
    // All should be from unexplored
    for (const t of targets) {
      expect(map.unexplored.map(u => u.family)).toContain(t)
    }
  })

  it('getExplorationTargets returns least-explored when all families are explored', () => {
    const tracker = new TechniqueCoverageTracker(makeTaxonomy())
    const precedents = [
      makePrecedent('1', 'depth', ['depth'], 'positive'),
      makePrecedent('2', 'depth', ['depth'], 'negative'),
      makePrecedent('3', 'depth', ['depth'], 'positive'),
      makePrecedent('4', 'width', ['model_dim'], 'positive'),
      makePrecedent('5', 'attention', ['attention'], 'negative'),
      makePrecedent('6', 'lr', ['learning_rate'], 'positive'),
      makePrecedent('7', 'lr', ['learning_rate'], 'positive'),
    ]
    const map = tracker.buildCoverageMap(precedents)
    const targets = tracker.getExplorationTargets(map, 2)

    expect(targets).toHaveLength(2)
    // Should be the least-explored families (attention-config and width-scaling both have 1 trial)
    expect(targets).toContain('attention-config')
    expect(targets).toContain('width-scaling')
  })
})
