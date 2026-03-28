import fs from 'node:fs'
import type { CycleContext } from './context.js'
import { runCycle } from './cycle.js'
import { getActiveChild, getActiveStdoutBuffer } from '../runner/sandbox.js'
import { parseMetrics } from '../runner/metrics-parser.js'
import { generateSummary, formatSummaryMarkdown, formatSummaryConsole } from './summary-report.js'
import type { CycleResult, OvernightSummary } from './summary-report.js'

export async function runScheduled(
  ctx: CycleContext,
  options: { cycles: number; budgetSeconds?: number; overnight?: boolean },
  boardId: string,
): Promise<void> {
  const { cycles, budgetSeconds, overnight } = options
  const startTime = Date.now()
  const results: CycleResult[] = []
  let stopReason: OvernightSummary['reason'] = 'cycles_complete'

  const sigintHandler = (): void => {
    const child = getActiveChild()
    if (child !== null) {
      child.kill('SIGTERM')
      const killTimer = setTimeout(() => {
        const c = getActiveChild()
        if (c !== null) {
          c.kill('SIGKILL')
        }
      }, 5000)
      if (killTimer.unref) killTimer.unref()
    }

    const stdoutBuffer = getActiveStdoutBuffer()
    const partialMetrics = parseMetrics(stdoutBuffer)

    ctx.audit.write(
      0,
      'run_cancelled',
      boardId,
      'Run cancelled by SIGINT',
      {
        partialMetrics: partialMetrics as Record<string, unknown>,
        elapsedSec: (Date.now() - startTime) / 1000,
      },
    )

    // Generate summary before exit if in overnight mode
    if (overnight && results.length > 0) {
      stopReason = 'sigint'
      try {
        const board = ctx.board.load(boardId)
        const summary = generateSummary(results, boardId, ctx.costTracker, board, startTime, stopReason)
        console.log('\n' + formatSummaryConsole(summary))
        fs.mkdirSync('data/reports', { recursive: true })
        const reportPath = `data/reports/${boardId}-${new Date().toISOString().replace(/[:.]/g, '-')}.md`
        fs.writeFileSync(reportPath, formatSummaryMarkdown(summary))
        console.log(`Report saved: ${reportPath}`)
      } catch (err) {
        console.error('[SIGINT] Failed to generate summary:', err)
      }
    }

    process.exit(130)
  }

  process.on('SIGINT', sigintHandler)

  try {
    for (let i = 1; i <= cycles; i++) {
      if (budgetSeconds !== undefined) {
        const elapsedSec = (Date.now() - startTime) / 1000
        if (elapsedSec >= budgetSeconds) {
          ctx.progress.phase(`Budget of ${budgetSeconds}s exhausted after ${i - 1} cycle(s). Stopping.`)
          stopReason = 'wall_clock'
          break
        }
      }

      const result = await runCycle(ctx, i, cycles, boardId)
      results.push(result)

      // In overnight mode, check if GPU budget is exhausted
      if (overnight && ctx.costTracker && ctx.costTracker.getRemaining() <= 0) {
        ctx.progress.phase('GPU budget exhausted. Continuing tier 0+1 only (no more tier 2 promotion).')
        stopReason = 'budget_exhausted'
        // Don't break — tier 0+1 cycles are still useful for generating precedents
      }
    }
  } finally {
    process.removeListener('SIGINT', sigintHandler)
  }

  // Generate summary report (overnight mode or multi-cycle runs)
  if ((overnight || results.length > 1) && results.length > 0) {
    const board = ctx.board.load(boardId)
    const summary = generateSummary(results, boardId, ctx.costTracker, board, startTime, stopReason)

    ctx.progress.blank()
    ctx.progress.phase(formatSummaryConsole(summary))

    fs.mkdirSync('data/reports', { recursive: true })
    const reportPath = `data/reports/${boardId}-${new Date().toISOString().replace(/[:.]/g, '-')}.md`
    fs.writeFileSync(reportPath, formatSummaryMarkdown(summary))
    ctx.progress.phase(`Report saved: ${reportPath}`)
  }
}
