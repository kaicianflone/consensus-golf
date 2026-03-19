import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, it, expect } from 'vitest'
import { ProposalSchema, AgentProposalResponseSchema } from '../../src/schema/proposal.js'
import { JudgmentSchema } from '../../src/schema/judgment.js'
import { ExperimentRunSchema } from '../../src/schema/experiment.js'
import { PrecedentSchema } from '../../src/schema/precedent.js'
import { BoardSchema } from '../../src/schema/board.js'
import { AuditEventSchema } from '../../src/schema/audit.js'
import { PolicyConfigSchema, PgolfConfigSchema, AgentConfigSchema } from '../../src/schema/config.js'

const CONFIG_DIR = resolve(import.meta.dirname, '../../config')

describe('ProposalSchema', () => {
  const validProposal = {
    id: 'prop_01',
    boardId: 'board_01',
    agent: 'agent-architecture',
    status: 'draft' as const,
    createdAt: '2026-03-19T00:00:00.000Z',
    title: 'Reduce embedding dimension',
    category: 'architecture' as const,
    thesis: 'Smaller embeddings reduce parameter count with minimal loss.',
    patchDescription: 'Change embed_dim from 256 to 128.',
    modifiedSource: 'def model(): pass',
    predictedImpact: { valBpbDelta: -0.01, artifactBytesDelta: -500000 },
    risks: ['Underfitting on long sequences'],
    precedentRefs: [],
  }

  it('validates a complete Proposal with all fields', () => {
    const result = ProposalSchema.safeParse(validProposal)
    expect(result.success).toBe(true)
  })

  it('rejects an invalid category', () => {
    const result = ProposalSchema.safeParse({ ...validProposal, category: 'invalid-category' })
    expect(result.success).toBe(false)
  })

  it('validates AgentProposalResponseSchema (subset without id/status/createdAt)', () => {
    const { id, boardId, agent, status, createdAt, ...agentResponse } = validProposal
    const result = AgentProposalResponseSchema.safeParse(agentResponse)
    expect(result.success).toBe(true)
  })

  it('rejects a Proposal missing required fields', () => {
    const { title, ...incomplete } = validProposal
    const result = ProposalSchema.safeParse(incomplete)
    expect(result.success).toBe(false)
  })
})

describe('JudgmentSchema', () => {
  const validJudgment = {
    id: 'judg_01',
    proposalId: 'prop_01',
    judgeId: 'judge-novelty',
    compositeScore: 0.72,
    createdAt: '2026-03-19T00:00:00.000Z',
    scores: {
      novelty: 0.8,
      plausibility: 0.7,
      expectedGain: 0.65,
      compliance: 0.9,
      simplicity: 0.6,
    },
    recommendation: 'approve' as const,
    reasoning: 'Well-reasoned proposal with clear impact.',
  }

  it('validates a Judgment with scores in 0-1 range', () => {
    const result = JudgmentSchema.safeParse(validJudgment)
    expect(result.success).toBe(true)
  })

  it('rejects scores above 1', () => {
    const result = JudgmentSchema.safeParse({
      ...validJudgment,
      scores: { ...validJudgment.scores, novelty: 1.5 },
    })
    expect(result.success).toBe(false)
  })

  it('rejects scores below 0', () => {
    const result = JudgmentSchema.safeParse({
      ...validJudgment,
      scores: { ...validJudgment.scores, plausibility: -0.1 },
    })
    expect(result.success).toBe(false)
  })
})

describe('ExperimentRunSchema', () => {
  it('validates a completed ExperimentRun', () => {
    const validRun = {
      id: 'run_01',
      proposalId: 'prop_01',
      tier: 0 as const,
      status: 'passed' as const,
      config: {
        iterations: 100,
        trainBatchTokens: 4096,
        valBatchSize: 4096,
        maxWallclockSec: 120,
      },
      metrics: {
        trainLoss: 2.1,
        valLoss: 2.3,
        valBpb: 1.21,
        artifactBytes: 14000000,
        wallclockSec: 95,
      },
      compliance: {
        artifactWithinLimit: true,
        noNetworkAccess: true,
        reproducible: true,
      },
      patch: '--- a/model.py\n+++ b/model.py\n@@ -1 +1 @@\n-embed_dim = 256\n+embed_dim = 128',
      stdout: 'Training complete.',
      startedAt: '2026-03-19T00:00:00.000Z',
      completedAt: '2026-03-19T00:01:35.000Z',
    }
    const result = ExperimentRunSchema.safeParse(validRun)
    expect(result.success).toBe(true)
  })

  it('validates a cancelled ExperimentRun without completedAt', () => {
    const cancelledRun = {
      id: 'run_02',
      proposalId: 'prop_02',
      tier: 1 as const,
      status: 'cancelled' as const,
      config: { iterations: 1000, trainBatchTokens: 8192, valBatchSize: 4096, maxWallclockSec: 3600 },
      metrics: {},
      compliance: { artifactWithinLimit: false, noNetworkAccess: true, reproducible: false },
      patch: '',
      stdout: '',
      startedAt: '2026-03-19T00:00:00.000Z',
    }
    const result = ExperimentRunSchema.safeParse(cancelledRun)
    expect(result.success).toBe(true)
  })
})

describe('PrecedentSchema', () => {
  it('validates a negative Precedent', () => {
    const validPrecedent = {
      id: 'prec_01',
      sourceProposalId: 'prop_01',
      sourceRunId: 'run_01',
      category: 'architecture',
      family: 'embedding-reduction',
      summary: 'Reducing embed_dim below 128 caused underfitting.',
      outcome: 'negative' as const,
      metrics: {
        baselineValBpb: 1.2244,
        candidateValBpb: 1.31,
        delta: 0.0856,
      },
      tags: ['embedding', 'underfitting'],
      createdAt: '2026-03-19T00:00:00.000Z',
    }
    const result = PrecedentSchema.safeParse(validPrecedent)
    expect(result.success).toBe(true)
  })
})

describe('BoardSchema', () => {
  it('validates a Board with baseline copied to currentBest (proposalId: empty string)', () => {
    const validBoard = {
      id: 'board_01',
      name: 'Parameter Golf Run 1',
      description: 'Minimize val BPB on fineweb10B.',
      baseline: {
        valBpb: 1.2244,
        artifactBytes: 15000000,
        commitRef: 'abc123',
      },
      currentBest: {
        valBpb: 1.2244,
        artifactBytes: 15000000,
        commitRef: 'abc123',
        proposalId: '',
      },
      activeCycle: 0,
      status: 'active' as const,
    }
    const result = BoardSchema.safeParse(validBoard)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.currentBest.proposalId).toBe('')
    }
  })
})

describe('AuditEventSchema', () => {
  it('validates a proposal_created AuditEvent', () => {
    const validEvent = {
      id: 'audit_01',
      timestamp: '2026-03-19T00:00:00.000Z',
      cycle: 1,
      eventType: 'proposal_created' as const,
      entityId: 'prop_01',
      agentId: 'agent-architecture',
      summary: 'Proposal created by agent-architecture.',
      data: { title: 'Reduce embedding dimension' },
    }
    const result = AuditEventSchema.safeParse(validEvent)
    expect(result.success).toBe(true)
  })

  it('validates an AuditEvent without optional agentId', () => {
    const event = {
      id: 'audit_02',
      timestamp: '2026-03-19T00:00:00.000Z',
      cycle: 1,
      eventType: 'policy_changed' as const,
      entityId: 'board_01',
      summary: 'Policy updated.',
      data: {},
    }
    const result = AuditEventSchema.safeParse(event)
    expect(result.success).toBe(true)
  })
})

describe('Config schemas parse actual config files', () => {
  it('PolicyConfigSchema parses config/default-policy.json', () => {
    const raw = JSON.parse(readFileSync(resolve(CONFIG_DIR, 'default-policy.json'), 'utf-8'))
    const result = PolicyConfigSchema.safeParse(raw)
    expect(result.success).toBe(true)
  })

  it('AgentConfigSchema parses config/agents.json', () => {
    const raw = JSON.parse(readFileSync(resolve(CONFIG_DIR, 'agents.json'), 'utf-8'))
    const result = AgentConfigSchema.safeParse(raw)
    expect(result.success).toBe(true)
  })

  it('PgolfConfigSchema parses config/pgolf.json', () => {
    const raw = JSON.parse(readFileSync(resolve(CONFIG_DIR, 'pgolf.json'), 'utf-8'))
    const result = PgolfConfigSchema.safeParse(raw)
    expect(result.success).toBe(true)
  })
})
