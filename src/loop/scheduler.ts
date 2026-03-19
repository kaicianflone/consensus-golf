import path from 'node:path'
import type { CycleContext } from './context.js'
import { runCycle } from './cycle.js'
import { writeAtomicJson } from '../persistence/atomic-json.js'
import { getActiveChild, getActiveStdoutBuffer } from '../runner/sandbox.js'
import { parseMetrics } from '../runner/metrics-parser.js'

export async function runScheduled(
  ctx: CycleContext,
  options: { cycles: number; budgetSeconds?: number },
  boardId: string,
): Promise<void> {
  const { cycles, budgetSeconds } = options
  const startTime = Date.now()

  // 2. Register SIGINT handler
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
      // Avoid blocking process exit
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

    process.exit(130)
  }

  process.on('SIGINT', sigintHandler)

  try {
    // 3. Loop through cycles sequentially
    for (let i = 1; i <= cycles; i++) {
      // Check budget before each cycle
      if (budgetSeconds !== undefined) {
        const elapsedSec = (Date.now() - startTime) / 1000
        if (elapsedSec >= budgetSeconds) {
          ctx.progress.phase(`Budget of ${budgetSeconds}s exhausted after ${i - 1} cycle(s). Stopping.`)
          break
        }
      }

      await runCycle(ctx, i, cycles, boardId)
    }
  } finally {
    // 4. Remove SIGINT listener
    process.removeListener('SIGINT', sigintHandler)

    // 5. Save reputation to data/boards/{boardId}-reputation.json
    const reputationPath = path.join('data', 'boards', `${boardId}-reputation.json`)
    writeAtomicJson(reputationPath, ctx.reputation.toJSON())
  }
}
