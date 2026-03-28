import { describe, it, expect, vi } from 'vitest'
import { Tier2Runner } from '../../src/runner/tier2-runner.js'
import { CostTracker } from '../../src/runner/cost-tracker.js'
import type { Proposal } from '../../src/schema/proposal.js'
import type { TierRunnerContext } from '../../src/runner/tier-runner.js'

const MOCK_TRAINING_OUTPUT = [
  'step:1/100 train_loss:6.94 train_time:100ms',
  'step:50/100 train_loss:4.50 train_time:5000ms',
  'step:100/100 train_loss:3.80 train_time:10000ms',
  'step:100/100 val_loss:2.07 val_bpb:1.22 train_time:10000ms',
  'final_int8_zlib_roundtrip val_loss:2.08 val_bpb:1.23 eval_time:5000ms',
  'final_int8_zlib_roundtrip_exact val_loss:2.08000000 val_bpb:1.23000000',
  'Total submission size int8+zlib: 15000000 bytes',
].join('\n')

function createMockClient() {
  return {
    createPod: vi.fn().mockResolvedValue('pod-test-123'),
    waitForRunning: vi.fn().mockResolvedValue({ id: 'pod-test-123', desiredStatus: 'RUNNING' }),
    uploadScript: vi.fn().mockResolvedValue(undefined),
    executeCommand: vi.fn().mockResolvedValue(MOCK_TRAINING_OUTPUT),
    terminatePod: vi.fn().mockResolvedValue(undefined),
  } as any
}

function createCtx(overrides?: Partial<TierRunnerContext>): TierRunnerContext {
  return {
    sourceCode: 'print("hello")',
    boardId: 'test',
    workDir: '/tmp/test',
    policy: {
      execution: { smokeIterations: 50, smokeBatchTokens: 8192, smokeMaxWallclockSec: 3600, valBatchSize: 8192, requireSmokeBeforeFull: true },
      merge: { minBpbImprovement: 0.001, requireArtifactWithinLimit: true, archiveNegativeResults: true },
      tiers: {
        tier0: { riskThreshold: 0.7 },
        tier1: { descentRateThreshold: 0.8, maxPromotions: 2 },
        tier2: {
          gpuType: 'NVIDIA H100',
          gpuCount: 1,
          templateId: 'tmpl-123',
          containerImage: 'runpod/pytorch',
          volumeId: 'vol-123',
          dataPath: '/workspace/data',
          tokenizerPath: '/workspace/tokenizer',
          trainScript: 'train_gpt.py',
          maxWallclockSec: 900,
          estimatedCostPerRun: 1.0,
          enabled: true,
        },
      },
    },
    pgolf: {
      repoPath: '.', trainScript: 'train.py', dataPath: '/data',
      tokenizerPath: '/tok', vocabSize: 1024, baselineValBpb: 1.2244,
      maxArtifactBytes: 16000000,
    },
    baselineCurve: null,
    ...overrides,
  }
}

function createProposal(): Proposal {
  return {
    id: 'prop-123', boardId: 'test', agent: 'architecture',
    status: 'approved', title: 'Test proposal', category: 'architecture',
    thesis: 'Test', patchDescription: 'Test', modifiedSource: 'print("modified")',
    predictedImpact: {}, risks: [], precedentRefs: [],
    createdAt: new Date().toISOString(),
  }
}

describe('Tier2Runner', () => {
  it('returns promotable: false when tier2 disabled', async () => {
    const ctx = createCtx()
    ctx.policy.tiers.tier2!.enabled = false
    const runner = new Tier2Runner(createMockClient(), new CostTracker(100))
    const result = await runner.run(createProposal(), ctx)
    expect(result.promotable).toBe(false)
    expect(result.preGate.reason).toContain('not enabled')
  })

  it('returns promotable: false when budget exceeded', async () => {
    const costTracker = new CostTracker(0.5) // only $0.50
    const runner = new Tier2Runner(createMockClient(), costTracker)
    process.env.RUNPOD_API_KEY = 'test-key'
    const result = await runner.run(createProposal(), createCtx())
    expect(result.promotable).toBe(false)
    expect(result.preGate.reason).toContain('Budget exceeded')
    delete process.env.RUNPOD_API_KEY
  })

  it('executes full pod lifecycle on success', async () => {
    const client = createMockClient()
    const costTracker = new CostTracker(100)
    const runner = new Tier2Runner(client, costTracker)
    process.env.RUNPOD_API_KEY = 'test-key'
    const result = await runner.run(createProposal(), createCtx())
    expect(client.createPod).toHaveBeenCalled()
    expect(client.waitForRunning).toHaveBeenCalled()
    expect(client.uploadScript).toHaveBeenCalled()
    expect(client.executeCommand).toHaveBeenCalled()
    expect(client.terminatePod).toHaveBeenCalled()
    expect(result.run).toBeDefined()
    expect(result.run?.metrics.valBpb).toBe(1.23)
    delete process.env.RUNPOD_API_KEY
  })

  it('terminates pod on execution error', async () => {
    const client = createMockClient()
    client.executeCommand.mockRejectedValue(new Error('SSH failed'))
    const runner = new Tier2Runner(client, new CostTracker(100))
    process.env.RUNPOD_API_KEY = 'test-key'
    const result = await runner.run(createProposal(), createCtx())
    expect(client.terminatePod).toHaveBeenCalled()
    expect(result.run?.status).toBe('failed')
    delete process.env.RUNPOD_API_KEY
  })

  it('records cost even on failure', async () => {
    const client = createMockClient()
    client.executeCommand.mockRejectedValue(new Error('failed'))
    const costTracker = new CostTracker(100)
    const runner = new Tier2Runner(client, costTracker)
    process.env.RUNPOD_API_KEY = 'test-key'
    await runner.run(createProposal(), createCtx())
    expect(costTracker.getSpent()).toBe(1.0) // estimatedCostPerRun
    delete process.env.RUNPOD_API_KEY
  })

  it('returns promotable: false when RUNPOD_API_KEY not set', async () => {
    delete process.env.RUNPOD_API_KEY
    const runner = new Tier2Runner(createMockClient(), new CostTracker(100))
    const result = await runner.run(createProposal(), createCtx())
    expect(result.promotable).toBe(false)
    expect(result.preGate.reason).toContain('RUNPOD_API_KEY')
  })
})
