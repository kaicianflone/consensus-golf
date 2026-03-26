import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import os from 'node:os'
import { LocalBoard, createStorage } from '@consensus-tools/core'
import { ConsensusBridge } from '../../src/adapter/consensus-bridge.js'
import { buildConsensusToolsConfig } from '../../src/adapter/consensus-config.js'
import type { Proposal } from '../../src/schema/proposal.js'
import type { Judgment } from '../../src/schema/judgment.js'

function makeTempConfig() {
  const tmpDir = mkdtempSync(join(os.tmpdir(), 'ct-test-'))
  return {
    storagePath: join(tmpDir, 'board.json'),
    agents: ['architecture', 'compression', 'training'],
    initialCredits: 100,
    stakeRequired: 1,
    jobExpiresSeconds: 3600,
    policy: {
      type: 'APPROVAL_VOTE',
      quorum: 2,
      minScore: 1,
      minMargin: 0,
      weightMode: 'equal',
      tieBreak: 'confidence',
    },
    rewards: { merge: 5, usefulResult: 2, penalizeInvalid: 4, penalizeNoncompliant: 8 },
    judges: ['judge-conservative', 'judge-innovative', 'judge-efficiency'],
  }
}

function makeProposal(id: string, agent: string): Proposal {
  return {
    id, boardId: 'test-board', agent, title: `Proposal ${id}`,
    category: 'architecture', thesis: 'test thesis', patchDescription: 'test patch',
    modifiedSource: 'print("hello")', predictedImpact: {}, risks: [], precedentRefs: [],
    status: 'voting', createdAt: new Date().toISOString(),
  }
}

function makeJudgment(proposalId: string, compositeScore: number, judgeId: string): Judgment {
  return {
    id: `j-${proposalId}-${judgeId}`, proposalId, judgeId, compositeScore,
    createdAt: new Date().toISOString(),
    scores: { novelty: compositeScore, plausibility: compositeScore, expectedGain: compositeScore, compliance: compositeScore, simplicity: compositeScore },
    recommendation: compositeScore > 0.5 ? 'approve' : 'reject',
    reasoning: 'test',
  }
}

describe('ConsensusBridge', () => {
  let bridge: ConsensusBridge

  beforeEach(async () => {
    const testConfig = makeTempConfig()
    const ctConfig = buildConsensusToolsConfig(testConfig)
    const storage = await createStorage(ctConfig)
    const board = new LocalBoard(ctConfig, storage)
    await board.init()
    for (const id of [...testConfig.agents, ...testConfig.judges]) {
      await board.ledger.ensureInitialCredits(id)
    }
    bridge = new ConsensusBridge(board, testConfig)
  })

  it('posts a proposal job and returns job ID', async () => {
    const jobId = await bridge.postProposalJob(1, 'p1')
    expect(jobId).toBeTruthy()
    expect(typeof jobId).toBe('string')
  })

  it('submits a proposal to its job', async () => {
    const jobId = await bridge.postProposalJob(1, 'p1')
    const proposal = makeProposal('p1', 'architecture')
    await bridge.submitProposal('architecture', jobId, proposal, 0.85)
  })

  it('casts judgment votes from judges', async () => {
    const jobId = await bridge.postProposalJob(1, 'p1')
    const proposal = makeProposal('p1', 'architecture')
    await bridge.submitProposal('architecture', jobId, proposal, 0.85)
    const judgment = makeJudgment('p1', 0.85, 'judge-conservative')
    await bridge.castJudgmentVote('judge-conservative', jobId, 'p1', judgment)
  })

  it('resolves a proposal as approved when judges vote approve', async () => {
    const config = makeTempConfig()
    const jobId = await bridge.postProposalJob(1, 'p1')
    const p1 = makeProposal('p1', 'architecture')
    await bridge.submitProposal('architecture', jobId, p1, 0.9)
    for (const judgeId of config.judges) {
      await bridge.castJudgmentVote(judgeId, jobId, 'p1', makeJudgment('p1', 0.9, judgeId))
    }
    const isApproved = await bridge.resolveProposal(jobId, 'p1')
    expect(isApproved).toBe(true)
  })

  it('resolves multiple proposals independently via resolveAllProposals', async () => {
    const config = makeTempConfig()
    const jobId1 = await bridge.postProposalJob(1, 'p1')
    const jobId2 = await bridge.postProposalJob(1, 'p2')
    const p1 = makeProposal('p1', 'architecture')
    const p2 = makeProposal('p2', 'compression')
    await bridge.submitProposal('architecture', jobId1, p1, 0.9)
    await bridge.submitProposal('compression', jobId2, p2, 0.7)
    for (const judgeId of config.judges) {
      await bridge.castJudgmentVote(judgeId, jobId1, 'p1', makeJudgment('p1', 0.9, judgeId))
      await bridge.castJudgmentVote(judgeId, jobId2, 'p2', makeJudgment('p2', 0.7, judgeId))
    }
    const approved = await bridge.resolveAllProposals()
    expect(approved).toContain('p1')
    expect(approved).toContain('p2')
  })

  it('rewards an agent via ledger', async () => {
    const balanceBefore = await bridge.getAgentBalance('architecture')
    await bridge.rewardAgent('architecture', 5, 'merge')
    const balanceAfter = await bridge.getAgentBalance('architecture')
    expect(balanceAfter).toBe(balanceBefore + 5)
  })

  it('slashes an agent via ledger', async () => {
    const balanceBefore = await bridge.getAgentBalance('architecture')
    await bridge.slashAgent('architecture', 4, 'invalid result')
    const balanceAfter = await bridge.getAgentBalance('architecture')
    expect(balanceAfter).toBe(balanceBefore - 4)
  })

  it('returns all agent balances for leaderboard', async () => {
    const balances = await bridge.getAllBalances()
    expect(Object.keys(balances)).toEqual(['architecture', 'compression', 'training'])
    expect(balances['architecture']).toBe(100)
  })
})
