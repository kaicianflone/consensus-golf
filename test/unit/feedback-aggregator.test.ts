import { describe, it, expect } from 'vitest'
import { FeedbackAggregator } from '../../src/memory/feedback-aggregator.js'
import type { Precedent } from '../../src/schema/precedent.js'

const makePrecedent = (
  id: string,
  family: string,
  outcome: 'positive' | 'negative' | 'invalid' | 'uncertain',
  category = 'architecture',
  delta?: number,
): Precedent => ({
  id,
  sourceProposalId: 'p1',
  category,
  family,
  summary: `Test ${id}`,
  outcome,
  metrics: { baselineValBpb: 1.2244, delta },
  tags: [family],
  createdAt: new Date().toISOString(),
})

describe('FeedbackAggregator', () => {
  const aggregator = new FeedbackAggregator()

  it('returns empty feedback for empty precedents', () => {
    const result = aggregator.aggregate([], [])

    expect(result.highImpactFamilies).toEqual([])
    expect(result.avoidFamilies).toEqual([])
    expect(result.agentStats).toEqual({})
    expect(result.suggestedDirections).toEqual([])
  })

  it('single family with 3 positive outcomes appears in highImpact', () => {
    const precedents = [
      makePrecedent('1', 'depth-scaling', 'positive', 'architecture', -0.005),
      makePrecedent('2', 'depth-scaling', 'positive', 'architecture', -0.003),
      makePrecedent('3', 'depth-scaling', 'positive', 'architecture', -0.004),
    ]

    const result = aggregator.aggregate(precedents, [])

    expect(result.highImpactFamilies).toHaveLength(1)
    expect(result.highImpactFamilies[0].family).toBe('depth-scaling')
    expect(result.highImpactFamilies[0].positiveRate).toBe(1)
    expect(result.highImpactFamilies[0].avgPositiveDelta).toBeLessThan(-0.001)
  })

  it('family with 80% negative rate appears in avoid', () => {
    const precedents = [
      makePrecedent('1', 'bad-family', 'negative', 'training', 0.01),
      makePrecedent('2', 'bad-family', 'negative', 'training', 0.02),
      makePrecedent('3', 'bad-family', 'negative', 'training', 0.03),
      makePrecedent('4', 'bad-family', 'negative', 'training', 0.015),
      makePrecedent('5', 'bad-family', 'positive', 'training', -0.001),
    ]

    const result = aggregator.aggregate(precedents, [])

    expect(result.avoidFamilies).toHaveLength(1)
    expect(result.avoidFamilies[0].family).toBe('bad-family')
    expect(result.avoidFamilies[0].negativeRate).toBe(0.8)
  })

  it('computes agent stats correctly from categories', () => {
    const precedents = [
      makePrecedent('1', 'fam-a', 'positive', 'architecture', -0.005),
      makePrecedent('2', 'fam-b', 'negative', 'architecture', 0.01),
      makePrecedent('3', 'fam-c', 'positive', 'training', -0.003),
      makePrecedent('4', 'fam-d', 'invalid', 'training'),
    ]

    const result = aggregator.aggregate(precedents, [])

    expect(result.agentStats['architecture']).toBeDefined()
    expect(result.agentStats['architecture'].trials).toBe(2)
    expect(result.agentStats['architecture'].positiveRate).toBe(0.5)
    expect(result.agentStats['architecture'].negativeRate).toBe(0.5)

    expect(result.agentStats['training']).toBeDefined()
    expect(result.agentStats['training'].trials).toBe(2)
    expect(result.agentStats['training'].positiveRate).toBe(0.5)
    expect(result.agentStats['training'].invalidRate).toBe(0.5)
  })

  it('generates suggested directions from high-impact and unexplored families', () => {
    const precedents = [
      makePrecedent('1', 'depth-scaling', 'positive', 'architecture', -0.005),
      makePrecedent('2', 'depth-scaling', 'positive', 'architecture', -0.003),
    ]

    const result = aggregator.aggregate(precedents, ['width-scaling', 'attention-config'])

    expect(result.suggestedDirections.length).toBeGreaterThan(0)
    expect(result.suggestedDirections.length).toBeLessThanOrEqual(5)
    // Should include a "Continue exploring" suggestion
    expect(result.suggestedDirections.some(s => s.includes('Continue exploring depth-scaling'))).toBe(true)
    // Should include a "Try combining" suggestion
    expect(result.suggestedDirections.some(s => s.includes('Try combining'))).toBe(true)
  })

  it('excludes families with fewer than 2 trials from stats', () => {
    const precedents = [
      makePrecedent('1', 'single-trial', 'positive', 'architecture', -0.01),
    ]

    const stats = aggregator.computeFamilyStats(precedents)

    expect(stats).toHaveLength(0)
  })
})
