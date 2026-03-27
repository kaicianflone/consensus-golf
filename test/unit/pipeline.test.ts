import { describe, it, expect } from 'vitest'
import { PipelineOrchestrator } from '../../src/runner/pipeline.js'
import type { TierRunner, TierRunResult, TierRunnerContext } from '../../src/runner/tier-runner.js'
import type { Proposal } from '../../src/schema/proposal.js'
import type { PolicyConfig, PgolfConfig } from '../../src/schema/config.js'

function makeProposal(id: string, agent: string = 'agent-1'): Proposal {
  return {
    id,
    boardId: 'board-1',
    agent,
    status: 'draft',
    createdAt: new Date().toISOString(),
    title: `Proposal ${id}`,
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

function makeMockRunner(tier: 0 | 1 | 2, resultFn: (p: Proposal) => TierRunResult): TierRunner {
  return {
    tier,
    run: async (proposal: Proposal, _ctx: TierRunnerContext) => resultFn(proposal),
  }
}

function makeResult(proposal: Proposal, tier: 0 | 1 | 2, promotable: boolean, descentRate?: number): TierRunResult {
  return {
    tier,
    proposal,
    preGate: { passed: true, reason: 'ok' },
    postGate: { passed: promotable, reason: promotable ? 'passed' : 'failed' },
    promotable,
    ...(descentRate !== undefined ? { baselineComparison: { relativeDescentRate: descentRate, verdict: 'faster' as const } } : {}),
  }
}

describe('PipelineOrchestrator', () => {
  it('runTier(0) runs all proposals and returns results', async () => {
    const proposals = [makeProposal('p1'), makeProposal('p2'), makeProposal('p3')]

    const tier0Runner = makeMockRunner(0, (p) =>
      makeResult(p, 0, p.id !== 'p2'),
    )

    const pipeline = new PipelineOrchestrator([tier0Runner])
    const results = await pipeline.runTier(0, proposals, makeContext(), 1)

    expect(results).toHaveLength(3)
    expect(results.filter(r => r.promotable)).toHaveLength(2)
    expect(results.find(r => r.proposal.id === 'p2')!.promotable).toBe(false)
  })

  it('runTier(1) runs proposals sequentially and returns results', async () => {
    const proposals = [makeProposal('p1'), makeProposal('p2')]
    const callOrder: string[] = []

    const tier1Runner: TierRunner = {
      tier: 1,
      run: async (proposal: Proposal, _ctx: TierRunnerContext) => {
        callOrder.push(proposal.id)
        return makeResult(proposal, 1, true, 1.5)
      },
    }

    const pipeline = new PipelineOrchestrator([tier1Runner])
    const results = await pipeline.runTier(1, proposals, makeContext(), 1)

    expect(results).toHaveLength(2)
    expect(results.every(r => r.promotable)).toBe(true)
    expect(callOrder).toEqual(['p1', 'p2'])
  })

  it('getPromoted returns top N by descent rate', () => {
    const p1 = makeProposal('p1')
    const p2 = makeProposal('p2')
    const p3 = makeProposal('p3')

    const results: TierRunResult[] = [
      makeResult(p1, 1, true, 1.2),
      makeResult(p2, 1, true, 1.8),
      makeResult(p3, 1, false, 2.0),  // not promotable
    ]

    const pipeline = new PipelineOrchestrator([])
    const promoted = pipeline.getPromoted(results, 1)

    expect(promoted).toHaveLength(1)
    expect(promoted[0].proposal.id).toBe('p2')
  })

  it('returns all promotable: false when runner is missing', async () => {
    const proposals = [makeProposal('p1'), makeProposal('p2')]
    const pipeline = new PipelineOrchestrator([])

    const results = await pipeline.runTier(0, proposals, makeContext(), 1)

    expect(results).toHaveLength(2)
    expect(results.every(r => !r.promotable)).toBe(true)
    expect(results[0].postGate.reason).toContain('No runner for tier 0')
  })

  it('runTier(0) runs all proposals (parallel execution)', async () => {
    const proposals = [makeProposal('p1'), makeProposal('p2'), makeProposal('p3')]
    let concurrentCount = 0
    let maxConcurrent = 0

    const tier0Runner: TierRunner = {
      tier: 0,
      run: async (proposal: Proposal, _ctx: TierRunnerContext) => {
        concurrentCount++
        if (concurrentCount > maxConcurrent) maxConcurrent = concurrentCount
        // Yield to allow other concurrent calls to start
        await new Promise(resolve => setTimeout(resolve, 10))
        concurrentCount--
        return makeResult(proposal, 0, true)
      },
    }

    const pipeline = new PipelineOrchestrator([tier0Runner])
    const results = await pipeline.runTier(0, proposals, makeContext(), 1)

    expect(results).toHaveLength(3)
    // All 3 should have started concurrently via Promise.all
    expect(maxConcurrent).toBe(3)
  })
})
