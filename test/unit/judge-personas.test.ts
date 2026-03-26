import { describe, it, expect, vi } from 'vitest'
import { getJudgePersonas, runMultiJudge } from '../../src/judges/judge-personas.js'
import type { LlmClient } from '../../src/llm/client.js'
import type { Proposal } from '../../src/schema/proposal.js'
import type { Board } from '../../src/schema/board.js'

describe('getJudgePersonas', () => {
  it('returns 3 personas with distinct IDs and system prompts', () => {
    const personas = getJudgePersonas()
    expect(personas).toHaveLength(3)
    const ids = personas.map((p) => p.id)
    expect(new Set(ids).size).toBe(3)
    const prompts = personas.map((p) => p.systemPrompt)
    expect(new Set(prompts).size).toBe(3)
  })
})

describe('runMultiJudge', () => {
  it('returns one judgment per persona', async () => {
    const mockLlm: LlmClient = {
      call: vi.fn().mockResolvedValue(JSON.stringify({
        scores: { novelty: 0.8, plausibility: 0.7, expectedGain: 0.6, compliance: 0.9, simplicity: 0.5 },
        recommendation: 'approve',
        reasoning: 'looks good',
      })),
    }

    const proposal: Proposal = {
      id: 'p1', boardId: 'test', agent: 'architecture', title: 'Test',
      category: 'architecture', thesis: 'test', patchDescription: 'test',
      modifiedSource: 'print("hello")', predictedImpact: {}, risks: [],
      precedentRefs: [], status: 'voting', createdAt: new Date().toISOString(),
    }

    const board: Board = {
      id: 'test-board', name: 'Test Board', description: 'test',
      baseline: { valBpb: 1.2, artifactBytes: 1000000, commitRef: 'abc' },
      currentBest: { valBpb: 1.1, artifactBytes: 1000000, commitRef: 'def', proposalId: 'p0' },
      activeCycle: 1, status: 'active',
    }

    const judgments = await runMultiJudge(mockLlm, proposal, board, [], 2048)
    expect(judgments).toHaveLength(3)
    expect(mockLlm.call).toHaveBeenCalledTimes(3)
    const judgeIds = judgments.map((j) => j.judgeId)
    expect(new Set(judgeIds).size).toBe(3)
  })
})
