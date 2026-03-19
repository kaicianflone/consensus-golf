import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, it, expect } from 'vitest'
import { parseMetrics, detectNaN } from '../../src/runner/metrics-parser.js'

const FIXTURES_DIR = resolve(import.meta.dirname, '../fixtures')

function loadFixture(name: string): string {
  return readFileSync(resolve(FIXTURES_DIR, name), 'utf-8')
}

describe('parseMetrics', () => {
  it('parses full baseline train.log with final_int8_zlib_roundtrip_exact values', () => {
    const stdout = loadFixture('train-log-baseline.txt')
    const metrics = parseMetrics(stdout)

    expect(metrics.valBpb).toBeCloseTo(1.2244, 3)
    expect(metrics.valLoss).toBeCloseTo(2.0727, 3)
    expect(metrics.artifactBytes).toBe(15863489)
    expect(metrics.stoppedEarly).toBe('wallclock_cap')
  })

  it('parses partial output falling back to step-level val metrics', () => {
    const stdout = loadFixture('train-log-partial.txt')
    const metrics = parseMetrics(stdout)

    expect(metrics.valBpb).toBeCloseTo(1.89, 2)
    expect(metrics.valLoss).toBeCloseTo(3.2, 1)
    expect(metrics.artifactBytes).toBeUndefined()
  })

  it('returns empty metrics for empty string', () => {
    const metrics = parseMetrics('')

    expect(metrics.valLoss).toBeUndefined()
    expect(metrics.valBpb).toBeUndefined()
    expect(metrics.trainLoss).toBeUndefined()
    expect(metrics.artifactBytes).toBeUndefined()
    expect(metrics.wallclockSec).toBeUndefined()
    expect(metrics.stoppedEarly).toBeUndefined()
    expect(metrics.lastStep).toBeUndefined()
    expect(metrics.totalSteps).toBeUndefined()
  })

  it('extracts wallclockSec from last train_time in baseline', () => {
    const stdout = loadFixture('train-log-baseline.txt')
    const metrics = parseMetrics(stdout)

    expect(metrics.wallclockSec).toBeGreaterThan(0)
  })

  it('extracts lastStep and totalSteps from partial log', () => {
    const stdout = loadFixture('train-log-partial.txt')
    const metrics = parseMetrics(stdout)

    expect(metrics.lastStep).toBe(50)
    expect(metrics.totalSteps).toBe(100)
  })
})

describe('detectNaN', () => {
  it('returns true for NaN fixture', () => {
    const stdout = loadFixture('train-log-nan.txt')
    expect(detectNaN(stdout)).toBe(true)
  })

  it('returns false for baseline fixture', () => {
    const stdout = loadFixture('train-log-baseline.txt')
    expect(detectNaN(stdout)).toBe(false)
  })
})
