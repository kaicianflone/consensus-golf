import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { BaselineManager } from '../../src/persistence/baseline-manager.js'
import type { BaselineCurve } from '../../src/persistence/baseline-manager.js'

let tmpDir: string
let manager: BaselineManager

const SAMPLE_CURVE: BaselineCurve = {
  boardId: 'test-board',
  capturedAt: '2026-03-27T00:00:00Z',
  config: { iterations: 50, batchTokens: 8192 },
  stepLosses: [
    { step: 1, totalSteps: 50, trainLoss: 6.94 },
    { step: 5, totalSteps: 50, trainLoss: 7.58 },
    { step: 10, totalSteps: 50, trainLoss: 6.49 },
    { step: 50, totalSteps: 50, trainLoss: 4.97 },
  ],
  signal: {
    descentRate: -0.035,
    r2: 0.72,
    lossDrop: 1.97,
    lossDropFraction: 0.284,
    stepCount: 4,
  },
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'baseline-manager-test-'))
  manager = new BaselineManager(tmpDir)
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

describe('BaselineManager', () => {
  it('returns false for exists() when no baseline saved', () => {
    expect(manager.exists('test-board')).toBe(false)
  })

  it('returns null for load() when no baseline saved', () => {
    expect(manager.load('test-board')).toBeNull()
  })

  it('round-trips save/load correctly', () => {
    manager.save(SAMPLE_CURVE)

    expect(manager.exists('test-board')).toBe(true)

    const loaded = manager.load('test-board')
    expect(loaded).not.toBeNull()
    expect(loaded!.boardId).toBe('test-board')
    expect(loaded!.config.iterations).toBe(50)
    expect(loaded!.stepLosses).toHaveLength(4)
    expect(loaded!.signal.descentRate).toBe(-0.035)
  })

  it('isStale returns true when no baseline exists', () => {
    expect(manager.isStale('test-board', { iterations: 50, batchTokens: 8192 })).toBe(true)
  })

  it('isStale returns false when config matches', () => {
    manager.save(SAMPLE_CURVE)
    expect(manager.isStale('test-board', { iterations: 50, batchTokens: 8192 })).toBe(false)
  })

  it('isStale returns true when iterations changed', () => {
    manager.save(SAMPLE_CURVE)
    expect(manager.isStale('test-board', { iterations: 100, batchTokens: 8192 })).toBe(true)
  })

  it('isStale returns true when batchTokens changed', () => {
    manager.save(SAMPLE_CURVE)
    expect(manager.isStale('test-board', { iterations: 50, batchTokens: 4096 })).toBe(true)
  })
})
