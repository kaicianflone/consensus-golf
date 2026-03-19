import { describe, it, expect } from 'vitest'
import { computeCompositeScore, applyApprovalPolicy } from '../../src/policy/approval-policy.js'
import { Judgment } from '../../src/schema/judgment.js'

function makeJudgment(
  id: string,
  scores: Judgment['scores'],
  compositeScore: number,
): Judgment {
  return {
    id,
    proposalId: `prop_${id}`,
    judgeId: 'judge-01',
    compositeScore,
    createdAt: '2026-03-19T00:00:00.000Z',
    scores,
    recommendation: 'approve',
    reasoning: 'test',
  }
}

const allOnes: Judgment['scores'] = {
  novelty: 1.0,
  plausibility: 1.0,
  expectedGain: 1.0,
  compliance: 1.0,
  simplicity: 1.0,
}

const allHalves: Judgment['scores'] = {
  novelty: 0.5,
  plausibility: 0.5,
  expectedGain: 0.5,
  compliance: 0.5,
  simplicity: 0.5,
}

const allZeros: Judgment['scores'] = {
  novelty: 0,
  plausibility: 0,
  expectedGain: 0,
  compliance: 0,
  simplicity: 0,
}

describe('computeCompositeScore', () => {
  it('returns 1.0 when all scores are 1.0', () => {
    expect(computeCompositeScore(allOnes)).toBeCloseTo(1.0)
  })

  it('returns 0.5 when all scores are 0.5', () => {
    expect(computeCompositeScore(allHalves)).toBeCloseTo(0.5)
  })

  it('returns 0 when all scores are 0', () => {
    expect(computeCompositeScore(allZeros)).toBeCloseTo(0)
  })
})

describe('applyApprovalPolicy', () => {
  it('approves top N judgments above the composite score threshold', () => {
    const judgments: Judgment[] = [
      makeJudgment('a', { ...allOnes, compliance: 0.9 }, 0.95),
      makeJudgment('b', { ...allOnes, compliance: 0.9 }, 0.85),
      makeJudgment('c', { ...allOnes, compliance: 0.9 }, 0.75),
    ]
    const result = applyApprovalPolicy(judgments, {
      minCompositeScore: 0.7,
      minCompliance: 0.5,
      maxApprovedPerCycle: 2,
    })
    expect(result).toHaveLength(2)
    expect(result[0].id).toBe('a')
    expect(result[1].id).toBe('b')
  })

  it('rejects judgments below the compliance threshold', () => {
    const judgments: Judgment[] = [
      makeJudgment('a', { ...allOnes, compliance: 0.9 }, 0.9),
      makeJudgment('b', { ...allZeros, compliance: 0.1 }, 0.8),
    ]
    const result = applyApprovalPolicy(judgments, {
      minCompositeScore: 0.0,
      minCompliance: 0.5,
      maxApprovedPerCycle: 10,
    })
    expect(result).toHaveLength(1)
    expect(result[0].id).toBe('a')
  })

  it('limits output to maxApprovedPerCycle', () => {
    const judgments: Judgment[] = [
      makeJudgment('a', allOnes, 0.9),
      makeJudgment('b', allOnes, 0.85),
      makeJudgment('c', allOnes, 0.8),
      makeJudgment('d', allOnes, 0.75),
    ]
    const result = applyApprovalPolicy(judgments, {
      minCompositeScore: 0.0,
      minCompliance: 0.0,
      maxApprovedPerCycle: 2,
    })
    expect(result).toHaveLength(2)
  })

  it('returns empty array when no judgments pass threshold', () => {
    const judgments: Judgment[] = [
      makeJudgment('a', allZeros, 0.1),
    ]
    const result = applyApprovalPolicy(judgments, {
      minCompositeScore: 0.5,
      minCompliance: 0.5,
      maxApprovedPerCycle: 10,
    })
    expect(result).toHaveLength(0)
  })
})
