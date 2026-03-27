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
import { checkCompliance } from '../judges/compliance-check.js'
import { shouldMerge } from '../policy/merge-policy.js'
import { runExperiment } from '../runner/sandbox.js'
import { analyzeLossCurve, compareToBaseline } from '../runner/loss-curve-analyzer.js'
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
      progress.phase(`Baseline capture failed: ${String(err)} — continuing without baseline`)
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

  // ─── PHASE 2: Compliance check ───────────────────────────────────
  progress.phase('Checking compliance...')
  progress.pushIndent()

  const complianceResults = await Promise.all(
    validProposals.map((p) => checkCompliance(p.modifiedSource, sourceCode)),
  )

  const compliantProposals: Proposal[] = []
  for (let i = 0; i < validProposals.length; i++) {
    const proposal = validProposals[i]
    const compliance = complianceResults[i]
    const passed = compliance.syntaxValid && compliance.securityScan.safe
    if (passed) {
      progress.agentResult(proposal.agent, 'compliance passed', true)
      compliantProposals.push(proposal)
    } else {
      const reason = !compliance.syntaxValid
        ? `syntax error: ${compliance.syntaxError ?? 'unknown'}`
        : `security scan blocked: ${compliance.securityScan.blockedPatterns.join(', ')}`
      progress.agentResult(proposal.agent, `compliance failed: ${reason}`, false)
      try {
        await consensus.slashAgent(proposal.agent, config.consensus.rewards.penalizeNoncompliant, 'compliance failure')
      } catch (err) {
        progress.agentResult(proposal.agent, `ledger slash failed: ${String(err)}`, false)
      }
      audit.write(cycleNum, 'proposal_rejected', proposal.id, `Proposal ${proposal.id} rejected: ${reason}`, { reason, syntaxValid: compliance.syntaxValid, securitySafe: compliance.securityScan.safe }, proposal.agent)
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

  // ─── PHASE 5: Execute or dry-run ─────────────────────────────────
  if (approvedProposals.length === 0 || dryRun) {
    if (dryRun) {
      progress.phase('[DRY RUN] Skipping execution of approved proposals.')
    } else {
      progress.phase('No proposals approved for execution.')
    }
    await printBalanceReport(ctx, agentIds, balancesBefore, cycleNumber, totalCycles)
    return
  }

  progress.phase('Executing approved proposals...')

  const updatedBoard = board.load(boardId) ?? boardState

  for (const proposal of approvedProposals) {
    progress.blank()
    progress.phase(`  Running: ${proposal.title} [${proposal.agent}]`)
    progress.pushIndent()

    audit.write(cycleNum, 'run_started', proposal.id, `Execution started for proposal ${proposal.id}`, { title: proposal.title, agent: proposal.agent }, proposal.agent)

    let run
    try {
      run = await runExperiment(proposal, sourceCode, config.policy, config.pgolf, workDir, (line: string) => { progress.agent(proposal.agent, line) })

      // Loss curve analysis
      const curveSignal = analyzeLossCurve(run.metrics.stepLosses ?? [])
      const curveComparison = baselineCurve
        ? compareToBaseline(curveSignal, baselineCurve.signal)
        : undefined
      if (curveSignal.stepCount >= 2) {
        progress.agent(proposal.agent, `descent_rate: ${curveSignal.descentRate.toFixed(6)} loss_drop: ${curveSignal.lossDrop.toFixed(4)} (${curveSignal.lossDropFraction > 0 ? '+' : ''}${(curveSignal.lossDropFraction * 100).toFixed(1)}%)`)
        if (curveComparison) {
          progress.agent(proposal.agent, `vs baseline: ${curveComparison.verdict} (relative: ${curveComparison.relativeDescentRate.toFixed(3)})`)
        }
      }

      if (run.metrics.valBpb !== undefined) {
        progress.metric('val_bpb', run.metrics.valBpb, updatedBoard.baseline.valBpb)
      }
      if (run.metrics.valLoss !== undefined && updatedBoard.baseline.valBpb !== undefined) {
        progress.metric('val_loss', run.metrics.valLoss, updatedBoard.baseline.valBpb)
      }
      if (run.metrics.artifactBytes !== undefined) {
        progress.metric('artifact_bytes', run.metrics.artifactBytes, updatedBoard.baseline.artifactBytes)
      }

      if (run.status === 'passed') {
        audit.write(cycleNum, 'run_completed', run.id, `Run completed for proposal ${proposal.id}: status=${run.status}`, { proposalId: proposal.id, status: run.status, valBpb: run.metrics.valBpb, artifactBytes: run.metrics.artifactBytes }, proposal.agent)
      } else {
        audit.write(cycleNum, 'run_failed', run.id, `Run failed for proposal ${proposal.id}: status=${run.status}`, { proposalId: proposal.id, status: run.status }, proposal.agent)
      }
    } catch (err) {
      progress.agentResult(proposal.agent, `execution error: ${String(err)}`, false)
      audit.write(cycleNum, 'run_failed', proposal.id, `Execution threw error: ${String(err)}`, { error: String(err) }, proposal.agent)
      progress.popIndent()
      continue
    }

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

    progress.popIndent()
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
