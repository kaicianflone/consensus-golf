import fs from 'node:fs'
import path from 'node:path'
import type { CycleContext } from './context.js'
import type { Proposal } from '../schema/proposal.js'
import type { Board } from '../schema/board.js'
import type { Judgment } from '../schema/judgment.js'
import { architectureAgent } from '../agents/architecture.js'
import { compressionAgent } from '../agents/compression.js'
import { trainingAgent } from '../agents/training.js'
import { runMultiJudge } from '../judges/judge-personas.js'
import { judgeResult } from '../judges/result-judge.js'
import { shouldMerge } from '../policy/merge-policy.js'
import { runExperiment, computeSimpleDiff } from '../runner/sandbox.js'
import { parseMetrics } from '../runner/metrics-parser.js'
import { analyzeLossCurve, compareToBaseline } from '../runner/loss-curve-analyzer.js'
import { Tier0Runner } from '../runner/tier0-runner.js'
import { Tier1Runner } from '../runner/tier1-runner.js'
import { Tier2Runner } from '../runner/tier2-runner.js'
import { Tier3Runner } from '../runner/tier3-runner.js'
import { RunPodsClient } from '../runner/runpods-client.js'
import { CostTracker } from '../runner/cost-tracker.js'
import { PipelineOrchestrator } from '../runner/pipeline.js'
import type { TierRunner, TierRunnerContext, TierRunResult } from '../runner/tier-runner.js'
import type { BaselineCurve } from '../persistence/baseline-manager.js'
import { getExplorerForCycle } from '../agents/exploration.js'
import type { AgentContextOptions } from '../agents/context.js'
import { FeedbackAggregator } from '../memory/feedback-aggregator.js'
import { PromotionQueue } from './promotion-queue.js'
import type { QueueEntry } from './promotion-queue.js'
import { PodSession } from '../runner/pod-session.js'
import { ulid } from 'ulid'
import type { ExperimentRun } from '../schema/experiment.js'
import type { CycleResult } from './summary-report.js'

export async function runCycle(
  ctx: CycleContext,
  cycleNumber: number,
  totalCycles: number,
  boardId: string,
): Promise<CycleResult> {
  const cycleStartTime = Date.now()
  const { config, llm, audit, precedents, board, consensus, progress, baseline, coverageTracker, workDir, dryRun } = ctx

  // Track cycle results for overnight summary
  const cycleStats = {
    proposalsGenerated: 0,
    tier0Passed: 0,
    tier1Passed: 0,
    tier2Attempted: 0,
    tier2Passed: 0,
    tier3Attempted: 0,
    tier3Passed: 0,
    bestValBpb: undefined as number | undefined,
    bestTechnique: undefined as string | undefined,
    bestProposalId: undefined as string | undefined,
  }

  function buildCycleResult(): CycleResult {
    return {
      cycleNumber,
      ...cycleStats,
      wallclockSec: (Date.now() - cycleStartTime) / 1000,
    }
  }

  progress.phase(`=== Cycle ${cycleNumber}/${totalCycles} ===`)
  progress.blank()

  // 1. Load board
  const boardState = board.loadOrCreate(boardId, {
    baselineValBpb: config.pgolf.baselineValBpb,
    baselineArtifactBytes: config.pgolf.maxArtifactBytes,
    commitRef: 'initial',
  })

  // 2. Increment cycle
  const cycleNum = board.incrementCycle(boardId)

  // 3. Read source code
  const sourceCodePath = path.join(config.pgolf.repoPath, config.pgolf.trainScript)
  const sourceCode = fs.readFileSync(sourceCodePath, 'utf-8')

  // 4. Load precedents for each agent
  const agentNames = ['architecture', 'compression', 'training']
  const archPrecedents = precedents.readForAgent('architecture')
  const compPrecedents = precedents.readForAgent('compression')
  const trainPrecedents = precedents.readForAgent('training')

  // Capture balances before cycle
  const agentIds = config.consensus.agents
  const balancesBefore = new Map<string, number>()
  for (const id of agentIds) {
    try {
      balancesBefore.set(id, await consensus.getAgentBalance(id))
    } catch {
      balancesBefore.set(id, config.consensus.initialCredits)
    }
  }

  // ─── PHASE 0.5: Baseline capture + coverage map + exploration ────
  const smokeConfig = {
    iterations: config.policy.execution.smokeIterations,
    batchTokens: config.policy.execution.smokeBatchTokens,
  }

  if (!baseline.exists(boardId) || baseline.isStale(boardId, smokeConfig)) {
    progress.phase('Capturing baseline loss curve...')
    try {
      const baselineProposal: Proposal = {
        id: `baseline-${boardId}-${cycleNum}`,
        boardId,
        agent: 'baseline',
        status: 'draft',
        title: 'Baseline capture',
        category: 'baseline',
        thesis: 'Capture unmodified training curve for comparison',
        patchDescription: 'No changes — unmodified source',
        modifiedSource: sourceCode,
        predictedImpact: {},
        risks: [],
        precedentRefs: [],
        createdAt: new Date().toISOString(),
      }
      const baselineRun = await runExperiment(
        baselineProposal, sourceCode, config.policy, config.pgolf, workDir,
        (line: string) => { progress.agent('baseline', line) },
      )
      const baselineSignal = analyzeLossCurve(baselineRun.metrics.stepLosses ?? [])
      baseline.save({
        boardId,
        capturedAt: new Date().toISOString(),
        config: smokeConfig,
        stepLosses: baselineRun.metrics.stepLosses ?? [],
        signal: baselineSignal,
      })
      progress.phase(`Baseline captured: descent_rate=${baselineSignal.descentRate.toFixed(6)}, loss_drop=${baselineSignal.lossDrop.toFixed(4)}`)
    } catch (err) {
      const errMsg = err instanceof Error ? err.stack ?? err.message : String(err)
      console.error('[BASELINE ERROR]', errMsg)
      progress.phase(`Baseline capture failed: ${errMsg} — continuing without baseline`)
    }
    progress.blank()
  }

  // Build coverage map and determine exploration agent
  const allPrecedentsForCoverage = precedents.readAll()
  const coverageMap = coverageTracker.buildCoverageMap(allPrecedentsForCoverage)
  const coverageMarkdown = coverageTracker.formatForAgent(coverageMap)
  const explorationTargets = coverageTracker.getExplorationTargets(coverageMap, 3)
  const explorerIndex = getExplorerForCycle(cycleNum, agentNames.length)
  const explorerName = agentNames[explorerIndex]

  const baselineCurve = baseline.load(boardId)
  const baselineSignalForAgents = baselineCurve
    ? { descentRate: baselineCurve.signal.descentRate, lossDrop: baselineCurve.signal.lossDrop }
    : undefined

  // Build RL feedback from precedents
  const feedbackAggregator = new FeedbackAggregator()
  const rlFeedback = feedbackAggregator.aggregate(allPrecedentsForCoverage, coverageMap.unexplored.map(e => e.family))

  function agentContextOptions(agentName: string): AgentContextOptions {
    return {
      coverageMarkdown,
      explorationMode: agentName === explorerName,
      explorationTargets: agentName === explorerName ? explorationTargets : undefined,
      baselineSignal: baselineSignalForAgents,
      rlFeedback,
    }
  }

  if (explorationTargets.length > 0) {
    progress.phase(`Explorer this cycle: ${explorerName} → targeting: ${explorationTargets.join(', ')}`)
  }
  progress.phase(`Technique coverage: ${coverageMap.coveragePct.toFixed(0)}% (${coverageMap.explored.length}/${coverageMap.explored.length + coverageMap.unexplored.length} families)`)
  progress.blank()

  // ─── PHASE 1: Generate proposals ─────────────────────────────────
  progress.phase('Generating proposals...')
  progress.pushIndent()

  const proposalResults = await Promise.allSettled([
    architectureAgent(llm, boardState, archPrecedents, sourceCode, config.agents, agentContextOptions('architecture')),
    compressionAgent(llm, boardState, compPrecedents, sourceCode, config.agents, agentContextOptions('compression')),
    trainingAgent(llm, boardState, trainPrecedents, sourceCode, config.agents, agentContextOptions('training')),
  ])

  const validProposals: Proposal[] = []

  for (let i = 0; i < proposalResults.length; i++) {
    const result = proposalResults[i]
    const agentName = agentNames[i]
    if (result.status === 'fulfilled') {
      progress.agentResult(agentName, `proposal generated: ${result.value.title}`, true)
      audit.write(cycleNum, 'proposal_created', result.value.id, `${agentName} generated proposal: ${result.value.title}`, { title: result.value.title, category: result.value.category }, agentName)
      validProposals.push(result.value)
      cycleStats.proposalsGenerated++
    } else {
      progress.agentResult(agentName, `failed: ${String(result.reason)}`, false)
      try {
        await consensus.slashAgent(agentName, config.consensus.rewards.penalizeInvalid, 'proposal generation failed')
      } catch (err) {
        progress.agentResult(agentName, `ledger slash failed: ${String(err)}`, false)
      }
      audit.write(cycleNum, 'proposal_rejected', `${agentName}-cycle-${cycleNum}`, `${agentName} failed to generate proposal: ${String(result.reason)}`, { error: String(result.reason) }, agentName)
    }
  }

  progress.popIndent()
  progress.blank()

  // ─── PHASE 2: Tier 0 compliance gate ────────────────────────────
  progress.phase('Checking compliance (Tier 0)...')
  progress.pushIndent()

  const tier0 = new Tier0Runner()
  const tier1 = new Tier1Runner()
  const runners: TierRunner[] = [tier0, tier1]
  const rpApiKey = process.env.RUNPOD_API_KEY
  if (rpApiKey) {
    const rpClient = new RunPodsClient(rpApiKey)
    const costTracker = ctx.costTracker ?? new CostTracker(50)
    if (config.policy.tiers.tier2?.enabled) {
      runners.push(new Tier2Runner(rpClient, costTracker))
    }
    if (config.policy.tiers.tier3?.enabled) {
      runners.push(new Tier3Runner(rpClient, costTracker))
    }
  }
  const pipeline = new PipelineOrchestrator(runners, audit)

  const baselineCurves = new Map<number, BaselineCurve>()
  const tier1Baseline = baseline.load(boardId)
  if (tier1Baseline) baselineCurves.set(1, tier1Baseline)
  const tier2Baseline = baseline.loadForTier(boardId, 2)
  if (tier2Baseline) baselineCurves.set(2, tier2Baseline)
  const tier3Baseline = baseline.loadForTier(boardId, 3)
  if (tier3Baseline) baselineCurves.set(3, tier3Baseline)

  const tierCtx: TierRunnerContext = {
    sourceCode,
    boardId,
    workDir,
    policy: config.policy,
    pgolf: config.pgolf,
    baselineCurve: baseline.load(boardId),
    baselineCurves,
    onProgress: (agent: string, line: string) => progress.agent(agent, line),
  }

  const tier0Results = await pipeline.runTier(0, validProposals, tierCtx, cycleNum)

  const compliantProposals: Proposal[] = []
  for (const result of tier0Results) {
    if (result.promotable) {
      progress.agentResult(result.proposal.agent, `compliance passed (risk: ${result.postGate.riskScore?.toFixed(2) ?? 'N/A'})`, true)
      compliantProposals.push(result.proposal)
      cycleStats.tier0Passed++
    } else {
      progress.agentResult(result.proposal.agent, `compliance failed: ${result.postGate.reason}`, false)
      try {
        await consensus.slashAgent(result.proposal.agent, config.consensus.rewards.penalizeNoncompliant, 'compliance failure')
      } catch (err) {
        progress.agentResult(result.proposal.agent, `ledger slash failed: ${String(err)}`, false)
      }
      audit.write(cycleNum, 'proposal_rejected', result.proposal.id, `Proposal ${result.proposal.id} rejected: ${result.postGate.reason}`, { reason: result.postGate.reason, riskScore: result.postGate.riskScore }, result.proposal.agent)
    }
  }

  progress.popIndent()
  progress.blank()

  if (compliantProposals.length === 0) {
    progress.phase('No compliant proposals. Ending cycle.')
    await printBalanceReport(ctx, agentIds, balancesBefore, cycleNumber, totalCycles)
    return buildCycleResult()
  }

  // ─── PHASE 3: Post jobs + submit + judge + vote (one job per proposal) ─
  progress.phase('Evaluating proposals (1 job per proposal, 3 judges each)...')
  progress.pushIndent()

  consensus.clearCycleState()
  const allPrecedents = precedents.readAll()

  for (const proposal of compliantProposals) {
    try {
      const jobId = await consensus.postProposalJob(cycleNum, proposal.id)

      const judgments = await runMultiJudge(llm, proposal, boardState, allPrecedents, config.agents.judgeMaxTokens)

      if (judgments.length === 0) {
        progress.agentResult(proposal.agent, 'all judges failed', false)
        continue
      }

      const avgScore = judgments.reduce((sum, j) => sum + j.compositeScore, 0) / judgments.length

      await consensus.submitProposal(proposal.agent, jobId, proposal, avgScore)

      for (const judgment of judgments) {
        try {
          await consensus.castJudgmentVote(judgment.judgeId, jobId, proposal.id, judgment)
        } catch (err) {
          progress.agentResult(judgment.judgeId, `vote failed: ${String(err)}`, false)
        }
      }

      const recommendations = judgments.map((j) => `${j.judgeId}:${j.recommendation}`).join(', ')
      progress.agentResult(proposal.agent, `avg score: ${avgScore.toFixed(3)} [${recommendations}]`, avgScore > 0.5)

      for (const judgment of judgments) {
        audit.write(cycleNum, 'judgment_issued', judgment.id, `${judgment.judgeId} judged ${proposal.id}: ${judgment.recommendation} (${judgment.compositeScore.toFixed(3)})`, { proposalId: proposal.id, judgeId: judgment.judgeId, compositeScore: judgment.compositeScore, recommendation: judgment.recommendation }, proposal.agent)
      }
    } catch (err) {
      progress.agentResult(proposal.agent, `submission/judging failed: ${String(err)}`, false)
    }
  }

  progress.popIndent()
  progress.blank()

  // ─── PHASE 4: Resolve all proposal jobs ──────────────────────────
  progress.phase('Resolving consensus...')
  progress.pushIndent()

  const approvedProposalIds = await consensus.resolveAllProposals()
  const approvedProposals = compliantProposals.filter((p) => approvedProposalIds.includes(p.id))

  for (const proposal of compliantProposals) {
    if (approvedProposalIds.includes(proposal.id)) {
      progress.agentResult(proposal.agent, `approved: ${proposal.title}`, true)
      audit.write(cycleNum, 'proposal_approved', proposal.id, `Proposal ${proposal.id} approved by consensus`, {}, proposal.agent)
    } else {
      progress.agentResult(proposal.agent, `rejected: ${proposal.title}`, false)
      audit.write(cycleNum, 'proposal_rejected', proposal.id, `Proposal ${proposal.id} rejected by consensus`, {}, proposal.agent)
    }
  }

  progress.popIndent()
  progress.blank()

  // ─── PHASE 5: Execute via Tier 1 pipeline ───────────────────────
  if (approvedProposals.length === 0 || dryRun) {
    if (dryRun) {
      progress.phase('[DRY RUN] Skipping execution of approved proposals.')
    } else {
      progress.phase('No proposals approved for execution.')
    }
    await printBalanceReport(ctx, agentIds, balancesBefore, cycleNumber, totalCycles)
    return buildCycleResult()
  }

  progress.phase('Executing approved proposals (Tier 1)...')

  const tier1Results = await pipeline.runTier(1, approvedProposals, tierCtx, cycleNum)
  const promoted = pipeline.getPromoted(tier1Results, config.policy.tiers.tier1.maxPromotions)
  const updatedBoard = board.load(boardId) ?? boardState

  await handleTierResults(tier1Results, 'Tier 1', {
    llm, audit, precedents, board, consensus, progress, config, cycleStats, updatedBoard, boardId, cycleNum,
  })

  // ─── GPU TIERS: PodSession with availability check + promotion queue ──
  if (promoted.length > 0 && pipeline.hasTier(2)) {
    const promoQueue = new PromotionQueue(path.join(workDir, '..'), boardId)
    const rpApiKey = process.env.RUNPOD_API_KEY
    const tier2Config = config.policy.tiers.tier2!
    const gpuTypes = [...new Set([tier2Config.gpuType, 'NVIDIA A100 80GB PCIe', 'NVIDIA A100-SXM4-80GB', 'NVIDIA GeForce RTX 4090'])]
    const volumes = tier2Config.volumeIds?.length ? tier2Config.volumeIds : [tier2Config.volumeId]

    // Check GPU availability before attempting (one lightweight API call)
    let gpusAvailable = false
    if (rpApiKey) {
      const rpCheck = new RunPodsClient(rpApiKey)
      const available = await rpCheck.getAvailableGpuTypes(gpuTypes)
      gpusAvailable = available.length > 0
      if (gpusAvailable) {
        progress.phase(`GPUs available: ${available.join(', ')}`)
      }
    }

    if (gpusAvailable && rpApiKey) {
      // Drain queued proposals first, then run current promotions
      const queued = promoQueue.getForTier(2)
      const allTier2Proposals = [
        ...queued.map(e => e.proposal),
        ...promoted.map(r => r.proposal),
      ]
      if (queued.length > 0) {
        progress.phase(`Draining ${queued.length} queued proposal(s) + ${promoted.length} new promotion(s)`)
      }

      // Run each proposal through Tier 2, reusing pod session for Tier 3
      for (const proposal of allTier2Proposals) {
        const session = new PodSession(
          new RunPodsClient(rpApiKey),
          ctx.costTracker ?? new CostTracker(50),
          (agent, line) => progress.agent(agent, line),
        )

        try {
          // Acquire pod across all volumes
          progress.blank()
          progress.phase(`  Tier 2: ${proposal.title} [${proposal.agent}]`)
          const acquired = await session.acquire(gpuTypes, volumes, {
            gpuCount: tier2Config.gpuCount,
            templateId: tier2Config.templateId,
            containerImage: tier2Config.containerImage,
          }, `cgolf-${proposal.id.slice(-8)}`)

          if (!acquired) {
            progress.agentResult(proposal.agent, 'No GPU available, re-queuing', false)
            promoQueue.enqueue([{
              proposal, sourceTier: 1, targetTier: 2,
              queuedAt: new Date().toISOString(), cycleNum,
            }])
            continue
          }

          await session.waitReady()
          await session.ensureDeps()
          await session.ensureData(tier2Config.dataPath, tier2Config.tokenizerPath)
          session.recordCost(tier2Config.estimatedCostPerRun)

          // Upload and train (Tier 2)
          await session.uploadScript(proposal.modifiedSource, `/workspace/${tier2Config.trainScript}`)
          progress.agent(proposal.agent, 'Training (Tier 2)...')

          const t2Command = buildGpuTrainCommand(tier2Config, 'LOCAL_RANK=0 RANK=0 WORLD_SIZE=1 MASTER_ADDR=localhost MASTER_PORT=29500 python3')
          const t2Stdout = await session.executeTraining(t2Command, (tier2Config.maxWallclockSec + 300) * 1000)
          const t2Metrics = parseMetrics(t2Stdout)
          const t2Patch = computeSimpleDiff(sourceCode, proposal.modifiedSource)

          const t2Run: ExperimentRun = {
            id: ulid(), proposalId: proposal.id, tier: 2,
            status: t2Metrics.valBpb !== undefined ? 'passed' : 'failed',
            config: { iterations: 20000, trainBatchTokens: 524288, valBatchSize: 524288, maxWallclockSec: tier2Config.maxWallclockSec },
            metrics: { trainLoss: t2Metrics.trainLoss, valLoss: t2Metrics.valLoss, valBpb: t2Metrics.valBpb, artifactBytes: t2Metrics.artifactBytes, wallclockSec: t2Metrics.wallclockSec, stepLosses: t2Metrics.stepLosses },
            compliance: { artifactWithinLimit: t2Metrics.artifactBytes !== undefined ? t2Metrics.artifactBytes <= ctx.config.pgolf.maxArtifactBytes : false, noNetworkAccess: true, reproducible: false },
            patch: t2Patch, stdout: t2Stdout, startedAt: new Date().toISOString(), completedAt: new Date().toISOString(),
          }

          const t2CurveSignal = analyzeLossCurve(t2Run.metrics.stepLosses ?? [])
          const t2Baseline = baselineCurves.get(2) ?? baselineCurve
          const t2Comparison = t2Baseline ? compareToBaseline(t2CurveSignal, t2Baseline.signal) : undefined
          const t2Passed = t2Run.status === 'passed' && t2Run.metrics.valBpb !== undefined

          // Log Tier 2 result
          if (t2Run.metrics.valBpb !== undefined) {
            progress.metric('val_bpb', t2Run.metrics.valBpb, updatedBoard.baseline.valBpb)
          }
          progress.agentResult(proposal.agent, `tier 2 gate: ${t2Passed ? 'PASSED' : 'FAILED'} — ${t2Passed ? `val_bpb=${t2Run.metrics.valBpb?.toFixed(4)}` : `status: ${t2Run.status}`}`, t2Passed)
          if (t2Passed) cycleStats.tier2Passed++
          cycleStats.tier2Attempted++

          // Judge + precedent for Tier 2
          try {
            const currentBoard = board.load(boardId) ?? updatedBoard
            const precedent = await judgeResult(llm, proposal, t2Run, currentBoard, config.agents.judgeMaxTokens)
            precedents.append(precedent)
            audit.write(cycleNum, 'precedent_created', precedent.id, `Precedent created: [${precedent.outcome}] ${precedent.summary}`, { outcome: precedent.outcome, family: precedent.family, delta: precedent.metrics.delta, tier: 2 }, proposal.agent)
          } catch (err) {
            progress.agentResult(proposal.agent, `result judging failed: ${String(err)}`, false)
          }

          // Tier 3 on same session if promoted
          const tier3Config = config.policy.tiers.tier3
          if (t2Passed && pipeline.hasTier(3) && tier3Config?.enabled && (ctx.costTracker ?? new CostTracker(50)).canAfford(tier3Config.estimatedCostPerRun)) {
            progress.agent(proposal.agent, 'Promoted to Tier 3 — reusing GPU session...')

            // Tier 3 needs 8 GPUs — terminate current 1-GPU pod, create 8-GPU in same volume
            const tier3GpuTypes = [...new Set([tier3Config.gpuType, 'NVIDIA H100 80GB HBM3', 'NVIDIA H100 SXM'])]
            const t3Vol = session.activeVolumeId ? [session.activeVolumeId, ...volumes.filter(v => v !== session.activeVolumeId)] : volumes

            await session.terminate() // release 1-GPU pod

            const t3Session = new PodSession(
              new RunPodsClient(rpApiKey),
              ctx.costTracker ?? new CostTracker(50),
              (agent, line) => progress.agent(agent, line),
            )
            try {
              const t3Acquired = await t3Session.acquire(tier3GpuTypes, t3Vol, {
                gpuCount: tier3Config.gpuCount,
                templateId: tier3Config.templateId,
                containerImage: tier3Config.containerImage,
              }, `cgolf-t3-${proposal.id.slice(-8)}`)

              if (t3Acquired) {
                await t3Session.waitReady()
                await t3Session.ensureDeps()
                await t3Session.ensureData(tier3Config.dataPath, tier3Config.tokenizerPath)
                t3Session.recordCost(tier3Config.estimatedCostPerRun)

                await t3Session.uploadScript(proposal.modifiedSource, `/workspace/${tier3Config.trainScript}`)
                progress.agent(proposal.agent, 'Training (Tier 3, 8-GPU torchrun)...')

                const t3Command = buildGpuTrainCommand(tier3Config, `torchrun --standalone --nproc_per_node=${tier3Config.gpuCount}`)
                const t3Stdout = await t3Session.executeTraining(t3Command, (tier3Config.maxWallclockSec + 300) * 1000)
                const t3Metrics = parseMetrics(t3Stdout)

                const t3Run: ExperimentRun = {
                  id: ulid(), proposalId: proposal.id, tier: 3,
                  status: t3Metrics.valBpb !== undefined ? 'passed' : 'failed',
                  config: { iterations: 20000, trainBatchTokens: 524288, valBatchSize: 524288, maxWallclockSec: tier3Config.maxWallclockSec },
                  metrics: { trainLoss: t3Metrics.trainLoss, valLoss: t3Metrics.valLoss, valBpb: t3Metrics.valBpb, artifactBytes: t3Metrics.artifactBytes, wallclockSec: t3Metrics.wallclockSec, stepLosses: t3Metrics.stepLosses },
                  compliance: { artifactWithinLimit: t3Metrics.artifactBytes !== undefined ? t3Metrics.artifactBytes <= ctx.config.pgolf.maxArtifactBytes : false, noNetworkAccess: true, reproducible: false },
                  patch: t2Patch, stdout: t3Stdout, startedAt: new Date().toISOString(), completedAt: new Date().toISOString(),
                }

                const t3Passed = t3Run.status === 'passed' && t3Run.metrics.valBpb !== undefined
                if (t3Run.metrics.valBpb !== undefined) {
                  progress.metric('val_bpb', t3Run.metrics.valBpb, updatedBoard.baseline.valBpb)
                }
                progress.agentResult(proposal.agent, `tier 3 gate: ${t3Passed ? 'PASSED' : 'FAILED'} — ${t3Passed ? `val_bpb=${t3Run.metrics.valBpb?.toFixed(4)}` : `status: ${t3Run.status}`}`, t3Passed)
                if (t3Passed) cycleStats.tier3Passed++
                cycleStats.tier3Attempted++

                // Judge + merge for Tier 3
                try {
                  const currentBoard = board.load(boardId) ?? updatedBoard
                  const precedent = await judgeResult(llm, proposal, t3Run, currentBoard, config.agents.judgeMaxTokens)
                  precedents.append(precedent)
                  audit.write(cycleNum, 'precedent_created', precedent.id, `Precedent created: [${precedent.outcome}] ${precedent.summary}`, { outcome: precedent.outcome, family: precedent.family, delta: precedent.metrics.delta, tier: 3 }, proposal.agent)

                  if (t3Passed && shouldMerge(t3Run.metrics, currentBoard, config.policy.merge, config.pgolf.maxArtifactBytes)) {
                    board.updateBest(boardId, {
                      valBpb: t3Run.metrics.valBpb!, artifactBytes: t3Run.metrics.artifactBytes ?? currentBoard.currentBest.artifactBytes,
                      commitRef: t3Run.id, proposalId: proposal.id,
                    })
                    progress.agentResult(proposal.agent, 'MERGED from Tier 3: new best result!', true)
                    if (t3Run.metrics.valBpb !== undefined && (cycleStats.bestValBpb === undefined || t3Run.metrics.valBpb < cycleStats.bestValBpb)) {
                      cycleStats.bestValBpb = t3Run.metrics.valBpb
                      cycleStats.bestTechnique = proposal.title
                      cycleStats.bestProposalId = proposal.id
                    }
                    try { await consensus.rewardAgent(proposal.agent, config.consensus.rewards.merge, 'tier 3 merge') } catch {}
                  }
                } catch (err) {
                  progress.agentResult(proposal.agent, `Tier 3 judging failed: ${String(err)}`, false)
                }
              } else {
                progress.agentResult(proposal.agent, 'No 8-GPU pod available for Tier 3', false)
              }
            } finally {
              await t3Session.terminate()
            }
          } else if (!pipeline.hasTier(3) && t2Passed) {
            // No Tier 3 — merge from Tier 2
            try {
              const currentBoard = board.load(boardId) ?? updatedBoard
              if (shouldMerge(t2Run.metrics, currentBoard, config.policy.merge, config.pgolf.maxArtifactBytes)) {
                board.updateBest(boardId, {
                  valBpb: t2Run.metrics.valBpb!, artifactBytes: t2Run.metrics.artifactBytes ?? currentBoard.currentBest.artifactBytes,
                  commitRef: t2Run.id, proposalId: proposal.id,
                })
                progress.agentResult(proposal.agent, 'MERGED from Tier 2: new best result!', true)
                try { await consensus.rewardAgent(proposal.agent, config.consensus.rewards.merge, 'tier 2 merge') } catch {}
              }
            } catch {}
          }
        } catch (err) {
          progress.agentResult(proposal.agent, `GPU execution error: ${String(err)}`, false)
        } finally {
          await session.terminate()
        }
      }

      // Dequeue everything we attempted
      promoQueue.dequeue(allTier2Proposals.map(p => p.id))

      // Report cost
      if (ctx.costTracker) {
        const summary = ctx.costTracker.getSummary()
        progress.phase(`GPU spend: $${summary.spent.toFixed(2)} / $${summary.budget.toFixed(2)} budget`)
      }
    } else {
      // No GPUs available — queue Tier 1 winners for later
      const newEntries: QueueEntry[] = promoted.map(r => ({
        proposal: r.proposal,
        sourceTier: 1,
        targetTier: 2,
        queuedAt: new Date().toISOString(),
        cycleNum,
        relativeDescentRate: r.baselineComparison?.relativeDescentRate,
      }))
      promoQueue.enqueue(newEntries)
      const sizes = promoQueue.size()
      progress.phase(`No GPUs available — queued ${promoted.length} proposal(s) (queue: ${sizes[2] ?? 0} for Tier 2)`)
    }
  } else if (promoted.length > 0) {
    progress.phase(`Tier 1 promoted ${promoted.length} proposal(s) (Tier 2 not enabled)`)
  }

  progress.blank()
  await printBalanceReport(ctx, agentIds, balancesBefore, cycleNumber, totalCycles)
  return buildCycleResult()
}

interface HandleTierContext {
  llm: CycleContext['llm']
  audit: CycleContext['audit']
  precedents: CycleContext['precedents']
  board: CycleContext['board']
  consensus: CycleContext['consensus']
  progress: CycleContext['progress']
  config: CycleContext['config']
  cycleStats: {
    tier1Passed: number
    tier2Passed: number
    tier3Passed: number
    bestValBpb: number | undefined
    bestTechnique: string | undefined
    bestProposalId: string | undefined
  }
  updatedBoard: Board
  boardId: string
  cycleNum: number
  skipMerge?: boolean  // true when results will be promoted to a higher tier
}

async function handleTierResults(
  tierResults: TierRunResult[],
  tierLabel: string,
  hctx: HandleTierContext,
): Promise<void> {
  const { llm, audit, precedents, board, consensus, progress, config, cycleStats, updatedBoard, boardId, cycleNum } = hctx
  const tierPassedMap: Record<string, 'tier1Passed' | 'tier2Passed' | 'tier3Passed'> = {
    'Tier 1': 'tier1Passed', 'Tier 2': 'tier2Passed', 'Tier 3': 'tier3Passed',
  }
  const passedKey = tierPassedMap[tierLabel]

  for (const tierResult of tierResults) {
    const { proposal, run, curveSignal, baselineComparison, postGate } = tierResult
    progress.blank()
    progress.phase(`  ${tierLabel} Result: ${proposal.title} [${proposal.agent}]`)
    progress.pushIndent()

    if (run) {
      audit.write(cycleNum, run.status === 'passed' ? 'run_completed' : 'run_failed', run.id, `Run ${run.status} for proposal ${proposal.id}`, { proposalId: proposal.id, status: run.status, valBpb: run.metrics.valBpb }, proposal.agent)

      // Log curve analysis
      if (curveSignal && curveSignal.stepCount >= 2) {
        progress.agent(proposal.agent, `descent_rate: ${curveSignal.descentRate.toFixed(6)} loss_drop: ${curveSignal.lossDrop.toFixed(4)} (${curveSignal.lossDropFraction > 0 ? '+' : ''}${(curveSignal.lossDropFraction * 100).toFixed(1)}%)`)
        if (baselineComparison) {
          progress.agent(proposal.agent, `vs baseline: ${baselineComparison.verdict} (relative: ${baselineComparison.relativeDescentRate.toFixed(3)})`)
        }
      }

      if (run.metrics.valBpb !== undefined) {
        progress.metric('val_bpb', run.metrics.valBpb, updatedBoard.baseline.valBpb)
      }
      if (run.metrics.valLoss !== undefined) {
        progress.metric('val_loss', run.metrics.valLoss, updatedBoard.baseline.valBpb)
      }

      // Gate result
      progress.agentResult(proposal.agent, `${tierLabel.toLowerCase()} gate: ${postGate.passed ? 'PASSED' : 'FAILED'} — ${postGate.reason}`, postGate.passed)
      if (postGate.passed) {
        if (passedKey) cycleStats[passedKey]++
      }
    }

    // Result judging + merge decision (only for runs that completed)
    if (run) {
      try {
        const currentBoard = board.load(boardId) ?? updatedBoard
        const precedent = await judgeResult(llm, proposal, run, currentBoard, config.agents.judgeMaxTokens)
        precedents.append(precedent)
        audit.write(cycleNum, 'precedent_created', precedent.id, `Precedent created: [${precedent.outcome}] ${precedent.summary}`, { outcome: precedent.outcome, family: precedent.family, delta: precedent.metrics.delta, tier: tierResult.tier }, proposal.agent)

        const currentBoardState = board.load(boardId) ?? currentBoard
        if (!hctx.skipMerge && postGate.passed && run.status === 'passed' && shouldMerge(run.metrics, currentBoardState, config.policy.merge, config.pgolf.maxArtifactBytes)) {
          board.updateBest(boardId, {
            valBpb: run.metrics.valBpb!,
            artifactBytes: run.metrics.artifactBytes ?? currentBoardState.currentBest.artifactBytes,
            commitRef: run.id,
            proposalId: proposal.id,
          })
          progress.agentResult(proposal.agent, `MERGED from ${tierLabel}: new best result!`, true)
          if (run.metrics.valBpb !== undefined && (cycleStats.bestValBpb === undefined || run.metrics.valBpb < cycleStats.bestValBpb)) {
            cycleStats.bestValBpb = run.metrics.valBpb
            cycleStats.bestTechnique = proposal.title
            cycleStats.bestProposalId = proposal.id
          }
          audit.write(cycleNum, 'baseline_updated', boardId, `Board updated from ${tierLabel} proposal ${proposal.id}`, { valBpb: run.metrics.valBpb, artifactBytes: run.metrics.artifactBytes, proposalId: proposal.id, tier: tierResult.tier }, proposal.agent)

          try {
            await consensus.rewardAgent(proposal.agent, config.consensus.rewards.merge, `${tierLabel.toLowerCase()} merge accepted`)
          } catch (err) {
            progress.agentResult(proposal.agent, `ledger reward failed: ${String(err)}`, false)
          }
        } else {
          try {
            if (precedent.outcome === 'positive' || precedent.outcome === 'negative') {
              await consensus.rewardAgent(proposal.agent, config.consensus.rewards.usefulResult, `useful ${tierLabel.toLowerCase()} ${precedent.outcome} result`)
            } else if (precedent.outcome === 'invalid') {
              await consensus.slashAgent(proposal.agent, config.consensus.rewards.penalizeInvalid, `invalid ${tierLabel.toLowerCase()} experiment`)
            }
          } catch (err) {
            progress.agentResult(proposal.agent, `ledger update failed: ${String(err)}`, false)
          }
        }
      } catch (err) {
        progress.agentResult(proposal.agent, `result judging failed: ${String(err)}`, false)
      }
    }

    progress.popIndent()
  }
}

async function printBalanceReport(
  ctx: CycleContext,
  agentIds: string[],
  balancesBefore: Map<string, number>,
  cycleNumber: number,
  totalCycles: number,
): Promise<void> {
  const repData = []
  for (const agentId of agentIds) {
    let balance: number
    try {
      balance = await ctx.consensus.getAgentBalance(agentId)
    } catch {
      balance = balancesBefore.get(agentId) ?? ctx.config.consensus.initialCredits
    }
    const before = balancesBefore.get(agentId) ?? balance
    repData.push({
      agentId,
      score: balance,
      delta: balance - before,
      sparkline: '',
    })
  }

  ctx.progress.phase(`Cycle ${cycleNumber}/${totalCycles} complete. Balances:`)
  ctx.progress.reputation(repData)
  ctx.progress.blank()
}

/** Build a training command for GPU tiers. Shared by Tier 2 (python3) and Tier 3 (torchrun). */
function buildGpuTrainCommand(
  tierConfig: { dataPath: string; tokenizerPath: string; trainScript: string; maxWallclockSec: number },
  launcher: string,
): string {
  const safePath = /^[a-zA-Z0-9_.\-\/]+$/
  for (const [name, value] of [['dataPath', tierConfig.dataPath], ['tokenizerPath', tierConfig.tokenizerPath], ['trainScript', tierConfig.trainScript]] as const) {
    if (!safePath.test(value)) throw new Error(`Unsafe characters in config ${name}: ${value}`)
  }
  return [
    'cd /workspace &&',
    'PYTHONPATH=/workspace/site-packages',
    `MAX_WALLCLOCK_SECONDS=${Math.floor(tierConfig.maxWallclockSec)}`,
    `DATA_PATH='${tierConfig.dataPath}'`,
    `TOKENIZER_PATH='${tierConfig.tokenizerPath}'`,
    'TRAIN_LOG_EVERY=5',
    'VAL_LOSS_EVERY=0',
    // For single-GPU: launcher = "LOCAL_RANK=0 RANK=0 WORLD_SIZE=1 MASTER_ADDR=localhost MASTER_PORT=29500 python3"
    // For multi-GPU: launcher = "torchrun --standalone --nproc_per_node=8"
    `${launcher} '/workspace/${tierConfig.trainScript}' 2>&1`,
  ].join(' ')
}
