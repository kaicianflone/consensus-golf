import { describe, it, expect } from 'vitest'
import { ReputationTracker } from '../../src/policy/reputation.js'

describe('ReputationTracker', () => {
  it('starts all agents at 100', () => {
    const tracker = new ReputationTracker(['agent-a', 'agent-b'])
    expect(tracker.getScore('agent-a')).toBe(100)
    expect(tracker.getScore('agent-b')).toBe(100)
  })

  it('returns default 100 for unknown agent', () => {
    const tracker = new ReputationTracker([])
    expect(tracker.getScore('unknown')).toBe(100)
  })

  it('payout increases score', () => {
    const tracker = new ReputationTracker(['agent-a'])
    const result = tracker.payout('agent-a', 20, 'good work')
    expect(result.delta).toBe(20)
    expect(result.newScore).toBe(120)
    expect(tracker.getScore('agent-a')).toBe(120)
  })

  it('payout uses absolute value of amount', () => {
    const tracker = new ReputationTracker(['agent-a'])
    const result = tracker.payout('agent-a', -20, 'good work')
    expect(result.delta).toBe(20)
    expect(result.newScore).toBe(120)
  })

  it('slash decreases score', () => {
    const tracker = new ReputationTracker(['agent-a'])
    const result = tracker.slash('agent-a', 30, 'bad behavior')
    expect(result.delta).toBe(30)
    expect(result.newScore).toBe(70)
    expect(tracker.getScore('agent-a')).toBe(70)
  })

  it('slash clamps to floor of 10', () => {
    const tracker = new ReputationTracker(['agent-a'])
    const result = tracker.slash('agent-a', 200, 'severe violation')
    expect(result.newScore).toBe(10)
    expect(tracker.getScore('agent-a')).toBe(10)
  })

  it('slash uses absolute value of amount', () => {
    const tracker = new ReputationTracker(['agent-a'])
    const result = tracker.slash('agent-a', -30, 'bad behavior')
    expect(result.delta).toBe(30)
    expect(result.newScore).toBe(70)
  })

  it('tracks history across snapshots', () => {
    const tracker = new ReputationTracker(['agent-a'])
    tracker.recordSnapshot() // 100
    tracker.payout('agent-a', 20, 'reward')
    tracker.recordSnapshot() // 120
    tracker.slash('agent-a', 10, 'penalty')
    tracker.recordSnapshot() // 110
    const hist = tracker.getHistory('agent-a')
    expect(hist).toHaveLength(3)
    expect(hist).toEqual([100, 120, 110])
  })

  it('sparkline returns ascending chars for ascending values', () => {
    const tracker = new ReputationTracker(['agent-a'])
    tracker.recordSnapshot() // 100
    tracker.payout('agent-a', 50, 'reward')
    tracker.recordSnapshot() // 150
    tracker.payout('agent-a', 50, 'reward')
    tracker.recordSnapshot() // 200
    const line = tracker.sparkline('agent-a')
    expect(line).toHaveLength(3)
    // Chars should be non-decreasing (ascending values → higher block chars)
    expect(line.charCodeAt(0)).toBeLessThanOrEqual(line.charCodeAt(1))
    expect(line.charCodeAt(1)).toBeLessThanOrEqual(line.charCodeAt(2))
  })

  it('sparkline returns empty string with no history', () => {
    const tracker = new ReputationTracker(['agent-a'])
    expect(tracker.sparkline('agent-a')).toBe('')
  })

  it('sparkline returns all top chars when all values are equal', () => {
    const tracker = new ReputationTracker(['agent-a'])
    tracker.recordSnapshot()
    tracker.recordSnapshot()
    const line = tracker.sparkline('agent-a')
    expect(line).toHaveLength(2)
    expect(line[0]).toBe('\u2588')
    expect(line[1]).toBe('\u2588')
  })

  it('leaderboard is sorted by score descending', () => {
    const tracker = new ReputationTracker(['agent-a', 'agent-b', 'agent-c'])
    tracker.payout('agent-c', 50, 'top performer')
    tracker.slash('agent-a', 30, 'penalty')
    const board = tracker.getLeaderboard()
    expect(board[0].agentId).toBe('agent-c')
    expect(board[0].score).toBe(150)
    expect(board[1].agentId).toBe('agent-b')
    expect(board[1].score).toBe(100)
    expect(board[2].agentId).toBe('agent-a')
    expect(board[2].score).toBe(70)
  })

  it('toJSON returns current scores', () => {
    const tracker = new ReputationTracker(['agent-a', 'agent-b'])
    tracker.payout('agent-a', 10, 'reward')
    const json = tracker.toJSON()
    expect(json['agent-a']).toBe(110)
    expect(json['agent-b']).toBe(100)
  })

  it('loadFromJSON restores scores', () => {
    const tracker = new ReputationTracker(['agent-a'])
    tracker.loadFromJSON({ 'agent-a': 75, 'agent-z': 42 })
    expect(tracker.getScore('agent-a')).toBe(75)
    expect(tracker.getScore('agent-z')).toBe(42)
  })
})
