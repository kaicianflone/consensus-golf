import type { Board } from '../schema/board.js'
import type { CostTracker } from '../runner/cost-tracker.js'

export interface CycleResult {
  cycleNumber: number
  proposalsGenerated: number
  tier0Passed: number
  tier1Passed: number
  tier2Attempted: number
  tier2Passed: number
  bestValBpb?: number
  bestTechnique?: string
  bestProposalId?: string
  wallclockSec: number
}

export interface OvernightSummary {
  boardId: string
  startedAt: string
  completedAt: string
  reason: 'budget_exhausted' | 'cycles_complete' | 'sigint' | 'wall_clock'
  cyclesCompleted: number
  totalProposals: number
  tier0Passed: number
  tier1Passed: number
  tier2Attempted: number
  tier2Passed: number
  bestResult?: {
    technique: string
    valBpb: number
    delta: number
    proposalId: string
  }
  gpuSpend: { spent: number; budget: number }
  wallclockMinutes: number
  boardState: { baselineValBpb: number; currentBestValBpb: number }
}

export function generateSummary(
  cycles: CycleResult[],
  boardId: string,
  costTracker: CostTracker | undefined,
  board: Board | null,
  startTime: number,
  reason: OvernightSummary['reason'],
): OvernightSummary {
  const now = Date.now()
  const wallclockMinutes = (now - startTime) / 60_000

  const totalProposals = cycles.reduce((s, c) => s + c.proposalsGenerated, 0)
  const tier0Passed = cycles.reduce((s, c) => s + c.tier0Passed, 0)
  const tier1Passed = cycles.reduce((s, c) => s + c.tier1Passed, 0)
  const tier2Attempted = cycles.reduce((s, c) => s + c.tier2Attempted, 0)
  const tier2Passed = cycles.reduce((s, c) => s + c.tier2Passed, 0)

  // Find best result across all cycles
  let bestResult: OvernightSummary['bestResult'] | undefined
  const baselineValBpb = board?.baseline.valBpb ?? 0
  for (const cycle of cycles) {
    if (cycle.bestValBpb !== undefined && cycle.bestTechnique) {
      const delta = cycle.bestValBpb - baselineValBpb
      if (!bestResult || cycle.bestValBpb < bestResult.valBpb) {
        bestResult = {
          technique: cycle.bestTechnique,
          valBpb: cycle.bestValBpb,
          delta,
          proposalId: cycle.bestProposalId ?? '',
        }
      }
    }
  }

  const gpuSummary = costTracker?.getSummary() ?? { spent: 0, budget: 0, remaining: 0 }

  return {
    boardId,
    startedAt: new Date(startTime).toISOString(),
    completedAt: new Date(now).toISOString(),
    reason,
    cyclesCompleted: cycles.length,
    totalProposals,
    tier0Passed,
    tier1Passed,
    tier2Attempted,
    tier2Passed,
    bestResult,
    gpuSpend: { spent: gpuSummary.spent, budget: gpuSummary.budget },
    wallclockMinutes,
    boardState: {
      baselineValBpb: board?.baseline.valBpb ?? 0,
      currentBestValBpb: board?.currentBest.valBpb ?? 0,
    },
  }
}

export function formatSummaryMarkdown(summary: OvernightSummary): string {
  const dur = formatDuration(summary.wallclockMinutes)
  const lines = [
    '# Overnight Run Summary',
    '',
    `**Board:** ${summary.boardId}`,
    `**Duration:** ${dur} | **Cycles:** ${summary.cyclesCompleted} | **Reason:** ${summary.reason}`,
    `**Started:** ${summary.startedAt} | **Completed:** ${summary.completedAt}`,
    '',
    '## Results',
    `- Proposals generated: ${summary.totalProposals}`,
    `- Tier 0 passed (compliance): ${summary.tier0Passed}`,
    `- Tier 1 passed (smoke test): ${summary.tier1Passed}`,
    `- Tier 2 attempted (GPU): ${summary.tier2Attempted}`,
    `- Tier 2 passed: ${summary.tier2Passed}`,
    '',
  ]

  if (summary.bestResult) {
    lines.push(
      '## Best Result',
      `**Technique:** ${summary.bestResult.technique}`,
      `**val_bpb:** ${summary.bestResult.valBpb.toFixed(4)} (delta: ${summary.bestResult.delta >= 0 ? '+' : ''}${summary.bestResult.delta.toFixed(4)} from baseline ${summary.boardState.baselineValBpb.toFixed(4)})`,
      '',
    )
  } else {
    lines.push('## Best Result', 'No improvements found.', '')
  }

  lines.push(
    '## GPU Spend',
    `$${summary.gpuSpend.spent.toFixed(2)} / $${summary.gpuSpend.budget.toFixed(2)} budget`,
    '',
    '## Board State',
    `Baseline: ${summary.boardState.baselineValBpb.toFixed(4)} → Current best: ${summary.boardState.currentBestValBpb.toFixed(4)}`,
    '',
  )

  return lines.join('\n')
}

export function formatSummaryConsole(summary: OvernightSummary): string {
  const dur = formatDuration(summary.wallclockMinutes)
  const lines = [
    `=== OVERNIGHT SUMMARY ===`,
    `Board: ${summary.boardId} | Duration: ${dur} | Cycles: ${summary.cyclesCompleted} | Reason: ${summary.reason}`,
    `Proposals: ${summary.totalProposals} | T0: ${summary.tier0Passed} | T1: ${summary.tier1Passed} | T2: ${summary.tier2Attempted}/${summary.tier2Passed}`,
    `GPU: $${summary.gpuSpend.spent.toFixed(2)}/$${summary.gpuSpend.budget.toFixed(2)}`,
  ]

  if (summary.bestResult) {
    lines.push(`Best: ${summary.bestResult.technique} val_bpb=${summary.bestResult.valBpb.toFixed(4)} (${summary.bestResult.delta >= 0 ? '+' : ''}${summary.bestResult.delta.toFixed(4)})`)
  } else {
    lines.push('Best: no improvements')
  }

  lines.push(`Board: ${summary.boardState.baselineValBpb.toFixed(4)} → ${summary.boardState.currentBestValBpb.toFixed(4)}`)

  return lines.join('\n')
}

function formatDuration(minutes: number): string {
  if (minutes < 60) return `${Math.round(minutes)}m`
  const h = Math.floor(minutes / 60)
  const m = Math.round(minutes % 60)
  return `${h}h ${m}m`
}
