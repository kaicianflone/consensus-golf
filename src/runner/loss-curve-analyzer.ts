import type { StepLoss } from './metrics-parser.js'

export interface LossCurveSignal {
  descentRate: number       // OLS slope (negative = improving)
  r2: number                // goodness of fit (0-1)
  lossDrop: number          // firstLoss - lastLoss (positive = improving)
  lossDropFraction: number  // lossDrop / firstLoss
  stepCount: number
}

export interface BaselineComparison {
  relativeDescentRate: number  // candidate rate / baseline rate (>1 = faster descent)
  verdict: 'faster' | 'similar' | 'slower' | 'insufficient-data'
}

export function analyzeLossCurve(stepLosses: StepLoss[]): LossCurveSignal {
  if (stepLosses.length === 0) {
    return { descentRate: 0, r2: 0, lossDrop: 0, lossDropFraction: 0, stepCount: 0 }
  }
  if (stepLosses.length === 1) {
    return {
      descentRate: 0,
      r2: 0,
      lossDrop: 0,
      lossDropFraction: 0,
      stepCount: 1,
    }
  }

  const n = stepLosses.length
  const xs = stepLosses.map(s => s.step)
  const ys = stepLosses.map(s => s.trainLoss)

  // OLS linear regression: y = mx + b
  let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0
  for (let i = 0; i < n; i++) {
    sumX += xs[i]
    sumY += ys[i]
    sumXY += xs[i] * ys[i]
    sumX2 += xs[i] * xs[i]
  }

  const denom = n * sumX2 - sumX * sumX
  const slope = denom !== 0 ? (n * sumXY - sumX * sumY) / denom : 0

  // R-squared
  const meanY = sumY / n
  let ssTot = 0, ssRes = 0
  const intercept = denom !== 0 ? (sumY - slope * sumX) / n : meanY
  for (let i = 0; i < n; i++) {
    const predicted = intercept + slope * xs[i]
    ssTot += (ys[i] - meanY) ** 2
    ssRes += (ys[i] - predicted) ** 2
  }
  const r2 = ssTot > 0 ? 1 - ssRes / ssTot : 0

  const firstLoss = ys[0]
  const lastLoss = ys[n - 1]
  const lossDrop = firstLoss - lastLoss
  const lossDropFraction = firstLoss > 0 ? lossDrop / firstLoss : 0

  return {
    descentRate: slope,
    r2: Math.max(0, Math.min(1, r2)),
    lossDrop,
    lossDropFraction,
    stepCount: n,
  }
}

export function compareToBaseline(
  candidate: LossCurveSignal,
  baseline: LossCurveSignal,
): BaselineComparison {
  if (candidate.stepCount < 3 || baseline.stepCount < 3) {
    return { relativeDescentRate: 0, verdict: 'insufficient-data' }
  }
  if (baseline.descentRate === 0) {
    return { relativeDescentRate: 0, verdict: 'insufficient-data' }
  }

  // Both rates should be negative (descending). Ratio > 1 means candidate descends faster.
  const relativeDescentRate = candidate.descentRate / baseline.descentRate

  let verdict: BaselineComparison['verdict']
  if (relativeDescentRate > 1.1) {
    verdict = 'faster'
  } else if (relativeDescentRate < 0.8) {
    verdict = 'slower'
  } else {
    verdict = 'similar'
  }

  return { relativeDescentRate, verdict }
}
