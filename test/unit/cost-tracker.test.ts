import { CostTracker } from '../../src/runner/cost-tracker.js'

describe('CostTracker', () => {
  it('canAfford returns true when within budget', () => {
    const tracker = new CostTracker(10)
    expect(tracker.canAfford(5)).toBe(true)
  })

  it('canAfford returns false when exceeds budget', () => {
    const tracker = new CostTracker(10)
    tracker.recordSpend(8)
    expect(tracker.canAfford(5)).toBe(false)
  })

  it('canAfford handles exact boundary', () => {
    const tracker = new CostTracker(10)
    tracker.recordSpend(5)
    expect(tracker.canAfford(5)).toBe(true)
    expect(tracker.canAfford(5.01)).toBe(false)
  })

  it('recordSpend accumulates correctly', () => {
    const tracker = new CostTracker(100)
    tracker.recordSpend(10)
    tracker.recordSpend(20)
    expect(tracker.getSpent()).toBe(30)
    expect(tracker.getRemaining()).toBe(70)
  })

  it('getSummary returns all fields', () => {
    const tracker = new CostTracker(50)
    tracker.recordSpend(15)
    const summary = tracker.getSummary()
    expect(summary.spent).toBe(15)
    expect(summary.budget).toBe(50)
    expect(summary.remaining).toBe(35)
  })
})
