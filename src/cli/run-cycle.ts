import fs from 'node:fs'
import path from 'node:path'
import { PolicyConfigSchema, PgolfConfigSchema, AgentConfigSchema } from '../schema/config.js'
import { AnthropicLlmClient } from '../llm/anthropic.js'
import { AuditWriter } from '../persistence/audit-writer.js'
import { BoardManager } from '../persistence/board-manager.js'
import { PrecedentStore } from '../memory/precedent-store.js'
import { ReputationTracker } from '../policy/reputation.js'
import { ProgressReporter } from '../loop/progress.js'
import { runScheduled } from '../loop/scheduler.js'
import { readAtomicJson } from '../persistence/atomic-json.js'
import type { CycleContext } from '../loop/context.js'

function parseArgs(): { cycles: number; boardId: string; dryRun: boolean; budgetSeconds?: number } {
  const argv = process.argv.slice(2)
  let cycles = 1
  let boardId = 'pgolf-main'
  let dryRun = false
  let budgetSeconds: number | undefined

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--cycles' && argv[i + 1] !== undefined) {
      cycles = parseInt(argv[++i], 10)
    } else if (arg === '--board' && argv[i + 1] !== undefined) {
      boardId = argv[++i]
    } else if (arg === '--dry-run') {
      dryRun = true
    } else if (arg === '--budget-seconds' && argv[i + 1] !== undefined) {
      budgetSeconds = parseInt(argv[++i], 10)
    }
  }

  return { cycles, boardId, dryRun, budgetSeconds }
}

async function main(): Promise<void> {
  const { cycles, boardId, dryRun, budgetSeconds } = parseArgs()

  // Load and validate configs
  const policyRaw = JSON.parse(fs.readFileSync('config/default-policy.json', 'utf8'))
  const pgolfRaw = JSON.parse(fs.readFileSync('config/pgolf.json', 'utf8'))
  const agentsRaw = JSON.parse(fs.readFileSync('config/agents.json', 'utf8'))

  const policy = PolicyConfigSchema.parse(policyRaw)
  const pgolf = PgolfConfigSchema.parse(pgolfRaw)
  const agents = AgentConfigSchema.parse(agentsRaw)

  // Create dependencies
  const llm = new AnthropicLlmClient(agents.model, agents.temperature)
  const audit = new AuditWriter('data/audit.jsonl')
  const board = new BoardManager('data/boards')
  const precedents = new PrecedentStore('data/precedents.jsonl')
  const reputation = new ReputationTracker(['architecture', 'compression', 'training'])

  // Load existing reputation if available
  const reputationPath = path.join('data', 'boards', `${boardId}-reputation.json`)
  const existingReputation = readAtomicJson<Record<string, number>>(reputationPath)
  if (existingReputation !== null) {
    reputation.loadFromJSON(existingReputation)
  }

  const progress = new ProgressReporter()

  // Ensure data/work directory exists
  fs.mkdirSync('data/work', { recursive: true })

  // Build CycleContext
  const ctx: CycleContext = {
    config: { policy, pgolf, agents },
    llm,
    audit,
    precedents,
    board,
    reputation,
    progress,
    workDir: 'data/work',
    dryRun,
  }

  await runScheduled(ctx, { cycles, budgetSeconds }, boardId)
}

main().catch((err) => {
  console.error('Fatal error:', err)
  process.exit(1)
})
