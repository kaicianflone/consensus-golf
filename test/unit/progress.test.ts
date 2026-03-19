import { describe, it, expect } from 'vitest'
import { formatMetricDelta, formatReputationLine } from '../../src/loop/progress.js'

const GREEN = '\x1b[32m'
const RED = '\x1b[31m'
const DIM = '\x1b[2m'

describe('formatMetricDelta', () => {
  it('improvement (candidate < baseline) shows negative delta in green', () => {
    const result = formatMetricDelta(1.2200, 1.2244)
    expect(result).toContain('-0.0044')
    expect(result).toContain(GREEN)
  })

  it('regression (candidate > baseline) shows positive delta in red', () => {
    const result = formatMetricDelta(1.2300, 1.2244)
    expect(result).toContain('+0.0056')
    expect(result).toContain(RED)
  })

  it('zero delta shows 0.0000', () => {
    const result = formatMetricDelta(1.2244, 1.2244)
    expect(result).toContain('0.0000')
  })

  it('zero delta uses dim color', () => {
    const result = formatMetricDelta(1.0, 1.0)
    expect(result).toContain(DIM)
  })
})

describe('formatReputationLine', () => {
  it('contains agent name, score, and delta with sign', () => {
    const result = formatReputationLine('agentA', 120, 20, '▄▆█')
    expect(result).toContain('agentA')
    expect(result).toContain('120')
    expect(result).toContain('+20')
    expect(result).toContain('▄▆█')
  })

  it('shows negative delta without extra plus sign', () => {
    const result = formatReputationLine('agentB', 80, -20, '▆▄▂')
    expect(result).toContain('agentB')
    expect(result).toContain('80')
    expect(result).toContain('-20')
  })

  it('pads agentId to 6 characters', () => {
    const result = formatReputationLine('ab', 100, 0, '')
    expect(result).toContain('ab    ')
  })
})
