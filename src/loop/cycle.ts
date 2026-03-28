import fs from 'node:fs'
import path from 'node:path'
import type { CycleContext } from './context.js'
import type { Proposal } from '../schema/proposal.js'
import type { Judgment } from '../schema/judgment.js'
import { architectureAgent } from '../agents/architecture.js'
import { compressionAgent } from '../agents/compression.js'
import { trainingAgent } from '../agents/training.js'
import { runMultiJudge } from '../judges/judge-personas.js'
import { judgeResult } from '../judges/result-judge.js'
import { shouldMerge } from '../policy/merge-policy.js'
import { runExperiment } from '../runner/sandbox.js'
import { analyzeLossCurve, compareToBaseline } from '../runner/loss-curve-analyzer.js'
import { Tier0Runner } from '../runner/tier0-runner.js'
import { Tier1Runner } from '../runner/tier1-runner.js'
import { Tier2Runner } from '../runner/tier2-runner.js'
import { RunPodsClient } from '../runner/runpods-client.js'
import { CostTracker } from '../runner/cost-tracker.js'
import { PipelineOrchestrator } from '../runner/pipeline.js'
import type { TierRunnerContext, TierRunResult } from '../runner/tier-runner.js'
import { getExplorerForCycle } from '../agents/exploration.js'
import type { AgentContextOptions } from '../agents/context.js'

export async function runCycle(
  ctx: CycleContext,
  cycleNumber: number,
  totalCycles: number,
  boardId: string,
): Promise<void> {
  const { config, llm, audit, precedents, board, consensus, progress, baseline, coverageTracker, workDir, dryRun } = ctx

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

  function agentContextOptions(agentName: string): AgentContextOptions {
    return {
      coverageMarkdown,
      explorationMode: agentName === explorerName,
      explorationTargets: agentName === explorerName ? explorationTargets : undefined,
      baselineSignal: baselineSignalForAgents,
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
  const runners: Array<InstanceType<typeof Tier0Runner> | InstanceType<typeof Tier1Runner> | Tier2Runner> = [tier0, tier1]
  if (config.policy.tiers.tier2?.enabled && process.env.RUNPOD_API_KEY) {
    const rpClient = new RunPodsClient(process.env.RUNPOD_API_KEY)
    runners.push(new Tier2Runner(rpClient, ctx.costTracker ?? new CostTracker(50)))
  }
  const pipeline = new PipelineOrchestrator(runners, audit)

  const tierCtx: TierRunnerContext = {
    sourceCode,
    boardId,
    workDir,
    policy: config.policy,
    pgolf: config.pgolf,
    baselineCurve: baseline.load(boardId),
    onProgress: (agent: string, line: string) => progress.agent(agent, line),
  }

  const tier0Results = await pipeline.runTier(0, validProposals, tierCtx, cycleNum)

  const compliantProposals: Proposal[] = []
  for (const result of tier0Results) {
    if (result.promotable) {
      progress.agentResult(result.proposal.agent, `compliance passed (risk: ${result.postGate.riskScore?.toFixed(2) ?? 'N/A'})`, true)
      compliantProposals.push(result.proposal)
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
    return
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
    return
  }

  progress.phase('Executing approved proposals (Tier 1)...')

  const tier1Results = await pipeline.runTier(1, approvedProposals, tierCtx, cycleNum)
  const promoted = pipeline.getPromoted(tier1Results, config.policy.tiers.tier1.maxPromotions)
  const updatedBoard = board.load(boardId) ?? boardState

  for (const tierResult of tier1Results) {
    const { proposal, run, curveSignal, baselineComparison, postGate } = tierResult
    progress.blank()
    progress.phase(`  Result: ${proposal.title} [${proposal.agent}]`)
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
      progress.agentResult(proposal.agent, `tier 1 gate: ${postGate.passed ? 'PASSED' : 'FAILED'} — ${postGate.reason}`, postGate.passed)
    }

    // Result judging + merge decision (only for runs that completed)
    if (run) {
      try {
        const currentBoard = board.load(boardId) ?? updatedBoard
        const precedent = await judgeResult(llm, proposal, run, currentBoard, config.agents.judgeMaxTokens)
        precedents.append(precedent)
        audit.write(cycleNum, 'precedent_created', precedent.id, `Precedent created: [${precedent.outcome}] ${precedent.summary}`, { outcome: precedent.outcome, family: precedent.family, delta: precedent.metrics.delta }, proposal.agent)

        const currentBoardState = board.load(boardId) ?? currentBoard
        if (run.status === 'passed' && shouldMerge(run.metrics, currentBoardState, config.policy.merge, config.pgolf.maxArtifactBytes)) {
          board.updateBest(boardId, {
            valBpb: run.metrics.valBpb!,
            artifactBytes: run.metrics.artifactBytes ?? currentBoardState.currentBest.artifactBytes,
            commitRef: run.id,
            proposalId: proposal.id,
          })
          progress.agentResult(proposal.agent, 'MERGED: new best result!', true)
          audit.write(cycleNum, 'baseline_updated', boardId, `Board updated with new best from proposal ${proposal.id}`, { valBpb: run.metrics.valBpb, artifactBytes: run.metrics.artifactBytes, proposalId: proposal.id }, proposal.agent)

          try {
            await consensus.rewardAgent(proposal.agent, config.consensus.rewards.merge, 'merge accepted')
          } catch (err) {
            progress.agentResult(proposal.agent, `ledger reward failed: ${String(err)}`, false)
          }
        } else {
          try {
            if (precedent.outcome === 'positive' || precedent.outcome === 'negative') {
              await consensus.rewardAgent(proposal.agent, config.consensus.rewards.usefulResult, `useful ${precedent.outcome} result`)
            } else if (precedent.outcome === 'invalid') {
              await consensus.slashAgent(proposal.agent, config.consensus.rewards.penalizeInvalid, 'invalid experiment result')
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

  if (promoted.length > 0 && pipeline.hasTier(2)) {
    progress.blank()
    progress.phase(`Executing ${promoted.length} promoted proposal(s) on RunPods (Tier 2)...`)
    const tier2Results = await pipeline.runTier(2, promoted.map(r => r.proposal), tierCtx, cycleNum)

    for (const tierResult of tier2Results) {
      const { proposal, run, curveSignal, baselineComparison, postGate } = tierResult
      progress.blank()
      progress.phase(`  Tier 2 Result: ${proposal.title} [${proposal.agent}]`)
      progress.pushIndent()

      if (run) {
        if (run.metrics.valBpb !== undefined) {
          progress.metric('val_bpb', run.metrics.valBpb, updatedBoard.baseline.valBpb)
        }
        progress.agentResult(proposal.agent, `tier 2 gate: ${postGate.passed ? 'PASSED' : 'FAILED'} — ${postGate.reason}`, postGate.passed)

        // Result judging + merge (same as tier 1)
        try {
          const currentBoard = board.load(boardId) ?? updatedBoard
          const precedent = await judgeResult(llm, proposal, run, currentBoard, config.agents.judgeMaxTokens)
          precedents.append(precedent)
          audit.write(cycleNum, 'precedent_created', precedent.id, `Precedent created: [${precedent.outcome}] ${precedent.summary}`, { outcome: precedent.outcome, family: precedent.family, delta: precedent.metrics.delta, tier: 2 }, proposal.agent)

          const currentBoardState = board.load(boardId) ?? currentBoard
          if (run.status === 'passed' && shouldMerge(run.metrics, currentBoardState, config.policy.merge, config.pgolf.maxArtifactBytes)) {
            board.updateBest(boardId, {
              valBpb: run.metrics.valBpb!,
              artifactBytes: run.metrics.artifactBytes ?? currentBoardState.currentBest.artifactBytes,
              commitRef: run.id,
              proposalId: proposal.id,
            })
            progress.agentResult(proposal.agent, 'MERGED from Tier 2: new best result!', true)
            audit.write(cycleNum, 'baseline_updated', boardId, `Board updated from Tier 2 proposal ${proposal.id}`, { valBpb: run.metrics.valBpb, artifactBytes: run.metrics.artifactBytes, proposalId: proposal.id, tier: 2 }, proposal.agent)

            try {
              await consensus.rewardAgent(proposal.agent, config.consensus.rewards.merge, 'tier 2 merge accepted')
            } catch (err) {
              progress.agentResult(proposal.agent, `ledger reward failed: ${String(err)}`, false)
            }
          } else {
            try {
              if (precedent.outcome === 'positive' || precedent.outcome === 'negative') {
                await consensus.rewardAgent(proposal.agent, config.consensus.rewards.usefulResult, `useful tier 2 ${precedent.outcome} result`)
              } else if (precedent.outcome === 'invalid') {
                await consensus.slashAgent(proposal.agent, config.consensus.rewards.penalizeInvalid, 'invalid tier 2 experiment')
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

    // Report cost
    if (ctx.costTracker) {
      const summary = ctx.costTracker.getSummary()
      progress.phase(`GPU spend: $${summary.spent.toFixed(2)} / $${summary.budget.toFixed(2)} budget`)
    }
  } else if (promoted.length > 0) {
    progress.phase(`Tier 1 promoted ${promoted.length} proposal(s) (Tier 2 not enabled)`)
  }

  progress.blank()
  await printBalanceReport(ctx, agentIds, balancesBefore, cycleNumber, totalCycles)
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
