import { describe, it, expect } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import os from 'node:os'
import { LocalBoard, createStorage } from '@consensus-tools/core'
import { ConsensusBridge } from '../../src/adapter/consensus-bridge.js'
import { buildConsensusToolsConfig } from '../../src/adapter/consensus-config.js'

describe('Consensus lifecycle integration', () => {
  it('full post → submit → vote → resolve cycle', async () => {
    const tmpDir = mkdtempSync(join(os.tmpdir(), 'ct-integ-'))

    const config = {
      storagePath: join(tmpDir, 'board.json'),
      agents: ['architecture', 'compression'],
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

    const ctConfig = buildConsensusToolsConfig(config)
    const storage = await createStorage(ctConfig)
    const localBoard = new LocalBoard(ctConfig, storage)
    await localBoard.init()

    for (const id of [...config.agents, ...config.judges]) {
      await localBoard.ledger.ensureInitialCredits(id)
    }

    const bridge = new ConsensusBridge(localBoard, config)

    // Post separate jobs for 2 proposals (one job per proposal)
    const jobId1 = await bridge.postProposalJob(1, 'p1')
    const jobId2 = await bridge.postProposalJob(1, 'p2')
    expect(jobId1).toBeTruthy()
    expect(jobId2).toBeTruthy()

    const p1 = {
      id: 'p1', boardId: 'test', agent: 'architecture', title: 'Depth increase',
      category: 'architecture' as const, thesis: 'More layers', patchDescription: 'add layers',
      modifiedSource: 'print("hello")', predictedImpact: {}, risks: [], precedentRefs: [],
      status: 'voting' as const, createdAt: new Date().toISOString(),
    }
    const p2 = {
      id: 'p2', boardId: 'test', agent: 'compression', title: 'Weight pruning',
      category: 'compression' as const, thesis: 'Remove weights', patchDescription: 'prune',
      modifiedSource: 'print("hello")', predictedImpact: {}, risks: [], precedentRefs: [],
      status: 'voting' as const, createdAt: new Date().toISOString(),
    }

    await bridge.submitProposal('architecture', jobId1, p1, 0.85)
    await bridge.submitProposal('compression', jobId2, p2, 0.65)

    const makeJudgment = (pid: string, score: number, jid: string) => ({
      id: `j-${pid}-${jid}`, proposalId: pid, judgeId: jid, compositeScore: score,
      createdAt: new Date().toISOString(),
      scores: { novelty: score, plausibility: score, expectedGain: score, compliance: score, simplicity: score },
      recommendation: (score > 0.5 ? 'approve' : 'reject') as 'approve' | 'reject',
      reasoning: 'test',
    })

    for (const jid of config.judges) {
      await bridge.castJudgmentVote(jid, jobId1, 'p1', makeJudgment('p1', 0.85, jid))
      await bridge.castJudgmentVote(jid, jobId2, 'p2', makeJudgment('p2', 0.65, jid))
    }

    const approved = await bridge.resolveAllProposals()
    expect(approved).toContain('p1')
    expect(approved).toContain('p2')

    await bridge.rewardAgent('architecture', 5, 'merge')
    await bridge.slashAgent('compression', 4, 'invalid')

    const archBalance = await bridge.getAgentBalance('architecture')
    const compBalance = await bridge.getAgentBalance('compression')
    expect(archBalance).toBeGreaterThan(compBalance)

    // Verify storage persisted
    const state = await storage.getState()
    expect(state.jobs.length).toBe(2)
    expect(state.submissions.length).toBe(2)
    expect(state.votes.length).toBe(6)
    expect(state.resolutions.length).toBe(2)
  })
})
