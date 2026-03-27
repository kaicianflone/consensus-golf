import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, it, expect } from 'vitest'
import { analyzeLossCurve, compareToBaseline } from '../../src/runner/loss-curve-analyzer.js'
import { parseMetrics } from '../../src/runner/metrics-parser.js'
import type { StepLoss } from '../../src/runner/metrics-parser.js'

const FIXTURES_DIR = resolve(import.meta.dirname, '../fixtures')

function loadFixture(name: string): string {
  return readFileSync(resolve(FIXTURES_DIR, name), 'utf-8')
}

describe('analyzeLossCurve', () => {
  it('returns zeros for empty array', () => {
    const signal = analyzeLossCurve([])
    expect(signal.stepCount).toBe(0)
    expect(signal.descentRate).toBe(0)
    expect(signal.r2).toBe(0)
    expect(signal.lossDrop).toBe(0)
    expect(signal.lossDropFraction).toBe(0)
  })

  it('returns zeros for single point', () => {
    const signal = analyzeLossCurve([{ step: 1, totalSteps: 10, trainLoss: 5.0 }])
    expect(signal.stepCount).toBe(1)
    expect(signal.descentRate).toBe(0)
    expect(signal.r2).toBe(0)
    expect(signal.lossDrop).toBe(0)
    expect(signal.lossDropFraction).toBe(0)
  })

  it('computes negative slope and R² close to 1 for perfect linear descent', () => {
    const steps: StepLoss[] = [
      { step: 1, totalSteps: 10, trainLoss: 10 },
      { step: 10, totalSteps: 10, trainLoss: 1 },
    ]
    const signal = analyzeLossCurve(steps)
    expect(signal.descentRate).toBeLessThan(0)
    expect(signal.r2).toBeCloseTo(1.0, 5)
    expect(signal.lossDrop).toBe(9)
    expect(signal.lossDropFraction).toBeCloseTo(0.9, 5)
    expect(signal.stepCount).toBe(2)
  })

  it('returns slope near zero for flat curve', () => {
    const steps: StepLoss[] = [
      { step: 1, totalSteps: 10, trainLoss: 5.0 },
      { step: 5, totalSteps: 10, trainLoss: 5.0 },
      { step: 10, totalSteps: 10, trainLoss: 5.0 },
    ]
    const signal = analyzeLossCurve(steps)
    expect(signal.descentRate).toBeCloseTo(0, 10)
    expect(signal.lossDrop).toBe(0)
  })

  it('produces negative descentRate and positive lossDrop from smoke fixture', () => {
    const stdout = loadFixture('train-log-smoke.txt')
    const metrics = parseMetrics(stdout)
    const signal = analyzeLossCurve(metrics.stepLosses)

    expect(signal.descentRate).toBeLessThan(0)
    expect(signal.lossDrop).toBeGreaterThan(0)
    expect(signal.lossDropFraction).toBeGreaterThan(0)
    expect(signal.r2).toBeGreaterThan(0)
    expect(signal.stepCount).toBe(14)
  })
})

describe('compareToBaseline', () => {
  it('returns faster when candidate descends faster', () => {
    const baseline = analyzeLossCurve([
      { step: 1, totalSteps: 10, trainLoss: 10 },
      { step: 5, totalSteps: 10, trainLoss: 8 },
      { step: 10, totalSteps: 10, trainLoss: 6 },
    ])
    const candidate = analyzeLossCurve([
      { step: 1, totalSteps: 10, trainLoss: 10 },
      { step: 5, totalSteps: 10, trainLoss: 5 },
      { step: 10, totalSteps: 10, trainLoss: 1 },
    ])
    const comparison = compareToBaseline(candidate, baseline)
    expect(comparison.verdict).toBe('faster')
    expect(comparison.relativeDescentRate).toBeGreaterThan(1.1)
  })

  it('returns slower when candidate descends slower', () => {
    const baseline = analyzeLossCurve([
      { step: 1, totalSteps: 10, trainLoss: 10 },
      { step: 5, totalSteps: 10, trainLoss: 5 },
      { step: 10, totalSteps: 10, trainLoss: 1 },
    ])
    const candidate = analyzeLossCurve([
      { step: 1, totalSteps: 10, trainLoss: 10 },
      { step: 5, totalSteps: 10, trainLoss: 8 },
      { step: 10, totalSteps: 10, trainLoss: 6 },
    ])
    const comparison = compareToBaseline(candidate, baseline)
    expect(comparison.verdict).toBe('slower')
    expect(comparison.relativeDescentRate).toBeLessThan(0.8)
  })

  it('returns similar when rates are close', () => {
    const baseline = analyzeLossCurve([
      { step: 1, totalSteps: 10, trainLoss: 10 },
      { step: 5, totalSteps: 10, trainLoss: 7 },
      { step: 10, totalSteps: 10, trainLoss: 4 },
    ])
    const candidate = analyzeLossCurve([
      { step: 1, totalSteps: 10, trainLoss: 10 },
      { step: 5, totalSteps: 10, trainLoss: 6.8 },
      { step: 10, totalSteps: 10, trainLoss: 3.8 },
    ])
    const comparison = compareToBaseline(candidate, baseline)
    expect(comparison.verdict).toBe('similar')
  })

  it('returns insufficient-data when fewer than 3 points', () => {
    const baseline = analyzeLossCurve([
      { step: 1, totalSteps: 10, trainLoss: 10 },
      { step: 10, totalSteps: 10, trainLoss: 1 },
    ])
    const candidate = analyzeLossCurve([
      { step: 1, totalSteps: 10, trainLoss: 10 },
      { step: 5, totalSteps: 10, trainLoss: 5 },
      { step: 10, totalSteps: 10, trainLoss: 1 },
    ])
    const comparison = compareToBaseline(candidate, baseline)
    expect(comparison.verdict).toBe('insufficient-data')
  })
})
