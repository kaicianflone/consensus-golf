import { describe, it, expect } from 'vitest'
import { Tier2Runner } from '../../src/runner/tier2-runner.js'
import type { Proposal } from '../../src/schema/proposal.js'
import type { TierRunnerContext } from '../../src/runner/tier-runner.js'
import type { PolicyConfig, PgolfConfig } from '../../src/schema/config.js'

function makeProposal(): Proposal {
  return {
    id: 'test-proposal-1',
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

function makeContext(): TierRunnerContext {
  return {
    sourceCode: 'print("baseline")',
    policy: {
      execution: {
        smokeIterations: 10,
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
}

describe('Tier2Runner', () => {
  it('always returns promotable: false', async () => {
    const runner = new Tier2Runner()
    const result = await runner.run(makeProposal(), makeContext())

    expect(result.promotable).toBe(false)
    expect(result.tier).toBe(2)
    expect(result.preGate.passed).toBe(false)
    expect(result.postGate.passed).toBe(false)
    expect(result.postGate.reason).toContain('not available yet')
  })
})
