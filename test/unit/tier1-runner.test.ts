import { describe, it, expect, vi } from 'vitest'
import type { Proposal } from '../../src/schema/proposal.js'
import type { ExperimentRun } from '../../src/schema/experiment.js'
import type { TierRunnerContext } from '../../src/runner/tier-runner.js'
import type { PolicyConfig, PgolfConfig } from '../../src/schema/config.js'
import type { LossCurveSignal } from '../../src/runner/loss-curve-analyzer.js'

vi.mock('../../src/runner/sandbox.js', () => ({
  runExperiment: vi.fn(),
}))

import { Tier1Runner } from '../../src/runner/tier1-runner.js'
import { runExperiment } from '../../src/runner/sandbox.js'

const mockedRunExperiment = vi.mocked(runExperiment)

function makeProposal(id: string = 'p1'): Proposal {
  return {
    id,
    boardId: 'board-1',
    agent: 'test-agent',
    status: 'draft',
    createdAt: new Date().toISOString(),
    title: 'Test proposal',
    category: 'training',
    thesis: 'Test thesis',
    patchDescription: 'Test patch',
    modifiedSource: 'print("hello")',
    predictedImpact: {},
    risks: [],
    precedentRefs: [],
  }
}

function makeRun(overrides: Partial<ExperimentRun> = {}): ExperimentRun {
  return {
    id: 'run-1',
    proposalId: 'p1',
    tier: 1,
    status: 'passed',
    config: {
      iterations: 50,
      trainBatchTokens: 1024,
      valBatchSize: 4,
      maxWallclockSec: 60,
    },
    metrics: {
      stepLosses: [
        { step: 1, totalSteps: 10, trainLoss: 10.0 },
        { step: 5, totalSteps: 10, trainLoss: 7.0 },
        { step: 10, totalSteps: 10, trainLoss: 4.0 },
      ],
    },
    compliance: {
      artifactWithinLimit: true,
      noNetworkAccess: true,
      reproducible: false,
    },
    patch: '',
    stdout: '',
    startedAt: new Date().toISOString(),
    ...overrides,
  }
}

function makeBaselineSignal(): LossCurveSignal {
  // Baseline with a moderate descent: slope ~ -0.667 per step
  return {
    descentRate: -0.667,
    r2: 0.99,
    lossDrop: 6,
    lossDropFraction: 0.6,
    stepCount: 3,
  }
}

function makeContext(opts: { withBaseline?: boolean; threshold?: number } = {}): TierRunnerContext {
  const ctx: TierRunnerContext = {
    sourceCode: 'print("baseline")',
    policy: {
      execution: {
        smokeIterations: 50,
        smokeBatchTokens: 1024,
        smokeMaxWallclockSec: 60,
        valBatchSize: 4,
        requireSmokeBeforeFull: true,
      },
      merge: {
        minBpbImprovement: 0.01,
        requireArtifactWithinLimit: true,
        archiveNegativeResults: true,
      },
      tiers: {
        tier1: {
          descentRateThreshold: opts.threshold ?? 0.8,
        },
      },
    } as PolicyConfig,
    pgolf: {
      repoPath: '/tmp',
      trainScript: 'train.py',
      dataPath: '/tmp/data',
      tokenizerPath: '/tmp/tokenizer',
      vocabSize: 50257,
      baselineValBpb: 3.0,
      maxArtifactBytes: 10_000_000,
    } as PgolfConfig,
    workDir: '/tmp/work',
  }

  if (opts.withBaseline) {
    ctx.baselineCurve = { signal: makeBaselineSignal() }
  }

  return ctx
}

describe('Tier1Runner', () => {
  const runner = new Tier1Runner()

  it('promotes passed run with good descent rate vs baseline', async () => {
    // Candidate descends faster than baseline
    const run = makeRun({
      metrics: {
        stepLosses: [
          { step: 1, totalSteps: 10, trainLoss: 10.0 },
          { step: 5, totalSteps: 10, trainLoss: 5.0 },
          { step: 10, totalSteps: 10, trainLoss: 1.0 },
        ],
      },
    })
    mockedRunExperiment.mockResolvedValueOnce(run)

    const result = await runner.run(makeProposal(), makeContext({ withBaseline: true }))

    expect(result.promotable).toBe(true)
    expect(result.postGate.passed).toBe(true)
    expect(result.tier).toBe(1)
    expect(result.curveSignal).toBeDefined()
    expect(result.baselineComparison).toBeDefined()
    expect(result.run).toBe(run)
  })

  it('rejects passed run with poor descent rate', async () => {
    // Candidate descends much slower than baseline
    const run = makeRun({
      metrics: {
        stepLosses: [
          { step: 1, totalSteps: 10, trainLoss: 10.0 },
          { step: 5, totalSteps: 10, trainLoss: 9.5 },
          { step: 10, totalSteps: 10, trainLoss: 9.0 },
        ],
      },
    })
    mockedRunExperiment.mockResolvedValueOnce(run)

    const result = await runner.run(makeProposal(), makeContext({ withBaseline: true }))

    expect(result.promotable).toBe(false)
    expect(result.postGate.passed).toBe(false)
    expect(result.postGate.reason).toContain('Descent rate')
    expect(result.postGate.reason).toContain('below threshold')
  })

  it('rejects failed run status', async () => {
    const run = makeRun({ status: 'failed' })
    mockedRunExperiment.mockResolvedValueOnce(run)

    const result = await runner.run(makeProposal(), makeContext({ withBaseline: true }))

    expect(result.promotable).toBe(false)
    expect(result.postGate.passed).toBe(false)
    expect(result.postGate.reason).toContain('Run status: failed')
  })

  it('promotes when no baseline curve is provided', async () => {
    const run = makeRun()
    mockedRunExperiment.mockResolvedValueOnce(run)

    const result = await runner.run(makeProposal(), makeContext({ withBaseline: false }))

    expect(result.promotable).toBe(true)
    expect(result.postGate.passed).toBe(true)
    expect(result.postGate.reason).toContain('no baseline comparison available')
    expect(result.baselineComparison).toBeUndefined()
  })
})
