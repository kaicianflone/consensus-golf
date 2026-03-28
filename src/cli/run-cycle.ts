import fs from 'node:fs'
import { PolicyConfigSchema, PgolfConfigSchema, AgentConfigSchema, ConsensusConfigSchema } from '../schema/config.js'
import { AnthropicLlmClient } from '../llm/anthropic.js'
import { AuditWriter } from '../persistence/audit-writer.js'
import { BoardManager } from '../persistence/board-manager.js'
import { PrecedentStore } from '../memory/precedent-store.js'
import { ProgressReporter } from '../loop/progress.js'
import { runScheduled } from '../loop/scheduler.js'
import { LocalBoard, createStorage } from '@consensus-tools/core'
import { ConsensusBridge } from '../adapter/consensus-bridge.js'
import { buildConsensusToolsConfig } from '../adapter/consensus-config.js'
import { BaselineManager } from '../persistence/baseline-manager.js'
import { TechniqueCoverageTracker } from '../memory/technique-coverage.js'
import type { TaxonomyData } from '../memory/technique-coverage.js'
import { CostTracker } from '../runner/cost-tracker.js'
import type { CycleContext } from '../loop/context.js'

function parseArgs(): { cycles: number; boardId: string; dryRun: boolean; budgetSeconds?: number; enableTier2: boolean; gpuBudget?: number; overnight: boolean } {
  const argv = process.argv.slice(2)
  let cycles = 1
  let boardId = 'pgolf-main'
  let dryRun = false
  let budgetSeconds: number | undefined
  let enableTier2 = false
  let gpuBudget: number | undefined
  let overnight = false

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
    } else if (arg === '--tier2') {
      enableTier2 = true
    } else if (arg === '--gpu-budget' && argv[i + 1] !== undefined) {
      gpuBudget = parseFloat(argv[++i])
    } else if (arg === '--overnight') {
      overnight = true
    }
  }

  // Overnight mode validation
  if (overnight) {
    if (gpuBudget === undefined) {
      console.error('Error: --overnight requires --gpu-budget (refuse to run unattended without a spending cap)')
      process.exit(1)
    }
    if (!Number.isFinite(gpuBudget) || gpuBudget <= 0) {
      console.error('Error: --gpu-budget must be a positive number')
      process.exit(1)
    }
    enableTier2 = true
    if (cycles === 1) cycles = 999
    // Default wall-clock cap of 12 hours for overnight runs if not explicitly set
    if (budgetSeconds === undefined) budgetSeconds = 43200
  }

  return { cycles, boardId, dryRun, budgetSeconds, enableTier2, gpuBudget, overnight }
}

async function main(): Promise<void> {
  const { cycles, boardId, dryRun, budgetSeconds, enableTier2, gpuBudget, overnight } = parseArgs()

  const policyRaw = JSON.parse(fs.readFileSync('config/default-policy.json', 'utf8'))
  const pgolfRaw = JSON.parse(fs.readFileSync('config/pgolf.json', 'utf8'))
  const agentsRaw = JSON.parse(fs.readFileSync('config/agents.json', 'utf8'))
  const consensusRaw = JSON.parse(fs.readFileSync('config/consensus.json', 'utf8'))

  const policy = PolicyConfigSchema.parse(policyRaw)
  const pgolf = PgolfConfigSchema.parse(pgolfRaw)
  const agents = AgentConfigSchema.parse(agentsRaw)
  const consensusConfig = ConsensusConfigSchema.parse(consensusRaw)

  const llm = new AnthropicLlmClient(agents.model, agents.temperature)

  // Create consensus-tools LocalBoard
  const ctConfig = buildConsensusToolsConfig(consensusConfig)
  const storage = await createStorage(ctConfig)
  const localBoard = new LocalBoard(ctConfig, storage)
  await localBoard.init()

  // Seed agent and judge credits
  for (const agentId of consensusConfig.agents) {
    await localBoard.ledger.ensureInitialCredits(agentId)
  }
  for (const judgeId of consensusConfig.judges) {
    await localBoard.ledger.ensureInitialCredits(judgeId)
  }

  const consensus = new ConsensusBridge(localBoard, consensusConfig)

  const audit = new AuditWriter('data/audit.jsonl')
  const board = new BoardManager('data/boards')
  const precedents = new PrecedentStore('data/precedents.jsonl')
  const progress = new ProgressReporter()

  fs.mkdirSync('data/work', { recursive: true })
  fs.mkdirSync('data/consensus', { recursive: true })
  fs.mkdirSync('data/baselines', { recursive: true })

  // Load technique taxonomy and create coverage tracker
  const taxonomyRaw = JSON.parse(fs.readFileSync('config/technique-taxonomy.json', 'utf8'))
  const taxonomy: TaxonomyData = taxonomyRaw
  const coverageTracker = new TechniqueCoverageTracker(taxonomy)
  const baseline = new BaselineManager('data/baselines')

  const costTracker = enableTier2 && gpuBudget !== undefined
    ? new CostTracker(gpuBudget)
    : undefined

  const ctx: CycleContext = {
    config: { policy, pgolf, agents, consensus: consensusConfig },
    llm,
    audit,
    precedents,
    board,
    consensus,
    progress,
    baseline,
    coverageTracker,
    workDir: 'data/work',
    dryRun,
    costTracker,
  }

  await runScheduled(ctx, { cycles, budgetSeconds, overnight }, boardId)
}

main().catch((err) => {
  console.error('Fatal error:', err)
  process.exit(1)
})
