import { generateSummary, formatSummaryMarkdown, formatSummaryConsole } from '../../src/loop/summary-report.js'
import type { CycleResult } from '../../src/loop/summary-report.js'
import type { Board } from '../../src/schema/board.js'

const MOCK_BOARD: Board = {
  id: 'test-board',
  name: 'test-board',
  description: '',
  baseline: { valBpb: 1.2244, artifactBytes: 16000000, commitRef: 'initial' },
  currentBest: { valBpb: 1.2180, artifactBytes: 15800000, commitRef: 'run-1', proposalId: 'prop-1' },
  activeCycle: 3,
  status: 'active',
}

function makeCycleResult(overrides?: Partial<CycleResult>): CycleResult {
  return {
    cycleNumber: 1,
    proposalsGenerated: 3,
    tier0Passed: 2,
    tier1Passed: 1,
    tier2Attempted: 1,
    tier2Passed: 0,
    wallclockSec: 5400,
    ...overrides,
  }
}

const MOCK_COST_TRACKER = {
  getSummary: () => ({ spent: 15, budget: 50, remaining: 35 }),
  canAfford: () => true,
  recordSpend: () => {},
  getRemaining: () => 35,
  getSpent: () => 15,
}

describe('generateSummary', () => {
  it('aggregates multiple cycle results', () => {
    const cycles = [
      makeCycleResult({ cycleNumber: 1, proposalsGenerated: 3, tier1Passed: 2, tier2Attempted: 2, tier2Passed: 1 }),
      makeCycleResult({ cycleNumber: 2, proposalsGenerated: 3, tier1Passed: 1, tier2Attempted: 1, tier2Passed: 0 }),
      makeCycleResult({ cycleNumber: 3, proposalsGenerated: 3, tier1Passed: 1, tier2Attempted: 0, tier2Passed: 0 }),
    ]

    const summary = generateSummary(cycles, 'test-board', MOCK_COST_TRACKER as any, MOCK_BOARD, Date.now() - 3600000, 'cycles_complete')

    expect(summary.cyclesCompleted).toBe(3)
    expect(summary.totalProposals).toBe(9)
    expect(summary.tier1Passed).toBe(4)
    expect(summary.tier2Attempted).toBe(3)
    expect(summary.tier2Passed).toBe(1)
    expect(summary.reason).toBe('cycles_complete')
    expect(summary.gpuSpend.spent).toBe(15)
    expect(summary.gpuSpend.budget).toBe(50)
  })

  it('finds best result across cycles', () => {
    const cycles = [
      makeCycleResult({ bestValBpb: 1.22, bestTechnique: 'LR tuning', bestProposalId: 'p1' }),
      makeCycleResult({ bestValBpb: 1.21, bestTechnique: 'MLP expansion', bestProposalId: 'p2' }),
      makeCycleResult({ bestValBpb: 1.23, bestTechnique: 'Depth scaling', bestProposalId: 'p3' }),
    ]

    const summary = generateSummary(cycles, 'test-board', MOCK_COST_TRACKER as any, MOCK_BOARD, Date.now() - 1800000, 'budget_exhausted')

    expect(summary.bestResult).toBeDefined()
    expect(summary.bestResult!.valBpb).toBe(1.21)
    expect(summary.bestResult!.technique).toBe('MLP expansion')
    expect(summary.reason).toBe('budget_exhausted')
  })

  it('handles empty cycles array', () => {
    const summary = generateSummary([], 'test-board', undefined, MOCK_BOARD, Date.now(), 'sigint')

    expect(summary.cyclesCompleted).toBe(0)
    expect(summary.totalProposals).toBe(0)
    expect(summary.bestResult).toBeUndefined()
    expect(summary.reason).toBe('sigint')
    expect(summary.gpuSpend.spent).toBe(0)
  })
})

describe('formatSummaryMarkdown', () => {
  it('produces valid markdown with all sections', () => {
    const summary = generateSummary(
      [makeCycleResult({ bestValBpb: 1.21, bestTechnique: 'MLP 3x' })],
      'test-board', MOCK_COST_TRACKER as any, MOCK_BOARD, Date.now() - 3600000, 'cycles_complete',
    )

    const md = formatSummaryMarkdown(summary)
    expect(md).toContain('# Overnight Run Summary')
    expect(md).toContain('test-board')
    expect(md).toContain('## Results')
    expect(md).toContain('## Best Result')
    expect(md).toContain('MLP 3x')
    expect(md).toContain('## GPU Spend')
    expect(md).toContain('$15.00 / $50.00')
    expect(md).toContain('## Board State')
  })

  it('handles no improvements', () => {
    const summary = generateSummary(
      [makeCycleResult()], 'test-board', undefined, MOCK_BOARD, Date.now(), 'cycles_complete',
    )

    const md = formatSummaryMarkdown(summary)
    expect(md).toContain('No improvements found')
  })
})

describe('formatSummaryConsole', () => {
  it('produces concise console output', () => {
    const summary = generateSummary(
      [makeCycleResult({ bestValBpb: 1.21, bestTechnique: 'LR boost' })],
      'test-board', MOCK_COST_TRACKER as any, MOCK_BOARD, Date.now() - 7200000, 'budget_exhausted',
    )

    const console = formatSummaryConsole(summary)
    expect(console).toContain('OVERNIGHT SUMMARY')
    expect(console).toContain('budget_exhausted')
    expect(console).toContain('LR boost')
    expect(console).toContain('$15.00/$50.00')
  })
})
