import { describe, it, expect } from 'vitest'
import { Tier0Runner } from '../../src/runner/tier0-runner.js'
import type { Proposal } from '../../src/schema/proposal.js'
import type { TierRunnerContext } from '../../src/runner/tier-runner.js'
import type { PolicyConfig, PgolfConfig } from '../../src/schema/config.js'

function makeProposal(modifiedSource: string): Proposal {
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
    modifiedSource,
    predictedImpact: {},
    risks: [],
    precedentRefs: [],
  }
}

function makeContext(sourceCode: string): TierRunnerContext {
  return {
    sourceCode,
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

describe('Tier0Runner', () => {
  const runner = new Tier0Runner()
  const baseline = 'print("baseline")'

  it('passes valid Python source', async () => {
    const proposal = makeProposal('print("hello")')
    const ctx = makeContext(baseline)
    const result = await runner.run(proposal, ctx)

    expect(result.promotable).toBe(true)
    expect(result.postGate.passed).toBe(true)
    expect(result.postGate.riskScore).toBe(0.0)
    expect(result.postGate.reason).toBe('compliance passed')
    expect(result.tier).toBe(0)
  })

  it('fails on Python syntax error', async () => {
    const proposal = makeProposal('def foo(:')
    const ctx = makeContext(baseline)
    const result = await runner.run(proposal, ctx)

    expect(result.promotable).toBe(false)
    expect(result.postGate.passed).toBe(false)
    expect(result.postGate.reason).toContain('syntax error')
  })

  it('fails on blocked security pattern', async () => {
    const proposal = makeProposal('import subprocess\nsubprocess.run(["ls"])')
    const ctx = makeContext(baseline)
    const result = await runner.run(proposal, ctx)

    expect(result.promotable).toBe(false)
    expect(result.postGate.passed).toBe(false)
    expect(result.postGate.reason).toContain('security scan blocked')
  })

  it('handles compliance check error gracefully', async () => {
    // Pass an object that will cause checkCompliance to throw
    const proposal = makeProposal('print("hello")')
    const ctx = makeContext(baseline)
    // Override sourceCode with something that triggers an error path
    // by mocking the proposal's modifiedSource to undefined via type escape
    const badProposal = { ...proposal, modifiedSource: undefined as unknown as string }
    const result = await runner.run(badProposal, ctx)

    expect(result.promotable).toBe(false)
    expect(result.postGate.passed).toBe(false)
    expect(result.postGate.reason).toContain('compliance check error')
  })
})
