import fs from 'node:fs'
import path from 'node:path'
import type { CycleContext } from './context.js'
import type { Proposal } from '../schema/proposal.js'
import type { Judgment } from '../schema/judgment.js'
import { architectureAgent } from '../agents/architecture.js'
import { compressionAgent } from '../agents/compression.js'
import { trainingAgent } from '../agents/training.js'
import { judgeProposal } from '../judges/proposal-judge.js'
import { judgeResult } from '../judges/result-judge.js'
import { checkCompliance } from '../judges/compliance-check.js'
import { applyApprovalPolicy } from '../policy/approval-policy.js'
import { shouldMerge } from '../policy/merge-policy.js'
import { runExperiment } from '../runner/sandbox.js'
import { formatMetricDelta } from './progress.js'

export async function runCycle(
  ctx: CycleContext,
  cycleNumber: number,
  totalCycles: number,
  boardId: string,
): Promise<void> {
  const { config, llm, audit, precedents, board, reputation, progress, workDir, dryRun } = ctx

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
  const archPrecedents = precedents.readForAgent('architecture')
  const compPrecedents = precedents.readForAgent('compression')
  const trainPrecedents = precedents.readForAgent('training')

  // Capture reputation scores before this cycle
  const agentIds = ['architecture', 'compression', 'training']
  const reputationBefore = new Map<string, number>(
    agentIds.map((id) => [id, reputation.getScore(id)]),
  )

  // 5. Generate proposals concurrently
  progress.phase('Generating proposals...')
  progress.pushIndent()

  const proposalResults = await Promise.allSettled([
    architectureAgent(llm, boardState, archPrecedents, sourceCode, config.agents),
    compressionAgent(llm, boardState, compPrecedents, sourceCode, config.agents),
    trainingAgent(llm, boardState, trainPrecedents, sourceCode, config.agents),
  ])

  const agentNames = ['architecture', 'compression', 'training']
  const validProposals: Proposal[] = []

  for (let i = 0; i < proposalResults.length; i++) {
    const result = proposalResults[i]
    const agentName = agentNames[i]
    if (result.status === 'fulfilled') {
      progress.agentResult(agentName, `proposal generated: ${result.value.title}`, true)
      audit.write(
        cycleNum,
        'proposal_created',
        result.value.id,
        `${agentName} generated proposal: ${result.value.title}`,
        { title: result.value.title, category: result.value.category },
        agentName,
      )
      validProposals.push(result.value)
    } else {
      progress.agentResult(agentName, `failed: ${String(result.reason)}`, false)
      reputation.slash(agentName, config.policy.reputation.penalizeInvalid, 'proposal generation failed')
      audit.write(
        cycleNum,
        'proposal_rejected',
        `${agentName}-cycle-${cycleNum}`,
        `${agentName} failed to generate proposal: ${String(result.reason)}`,
        { error: String(result.reason) },
        agentName,
      )
    }
  }

  progress.popIndent()
  progress.blank()

  // 6. Run compliance check concurrently
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
      reputation.slash(
        proposal.agent,
        config.policy.reputation.penalizeNoncompliant,
        'compliance failure',
      )
      audit.write(
        cycleNum,
        'proposal_rejected',
        proposal.id,
        `Proposal ${proposal.id} rejected: ${reason}`,
        { reason, syntaxValid: compliance.syntaxValid, securitySafe: compliance.securityScan.safe },
        proposal.agent,
      )
    }
  }

  progress.popIndent()
  progress.blank()

  if (compliantProposals.length === 0) {
    progress.phase('No compliant proposals. Ending cycle.')
    return
  }

  // 7. Judge compliant proposals
  progress.phase('Judging proposals...')
  progress.pushIndent()

  const allPrecedents = precedents.readAll()
  const judgments: Judgment[] = []

  for (const proposal of compliantProposals) {
    try {
      const judgment = await judgeProposal(
        llm,
        proposal,
        boardState,
        allPrecedents,
        config.agents.judgeMaxTokens,
      )
      const approved = judgment.recommendation === 'approve'
      progress.agentResult(
        proposal.agent,
        `score: ${judgment.compositeScore.toFixed(3)} (${judgment.recommendation})`,
        approved,
      )
      audit.write(
        cycleNum,
        'judgment_issued',
        judgment.id,
        `Judgment for proposal ${proposal.id}: ${judgment.recommendation} (score: ${judgment.compositeScore.toFixed(3)})`,
        { proposalId: proposal.id, compositeScore: judgment.compositeScore, recommendation: judgment.recommendation },
        proposal.agent,
      )
      judgments.push(judgment)
    } catch (err) {
      progress.agentResult(proposal.agent, `judging failed: ${String(err)}`, false)
    }
  }

  progress.popIndent()
  progress.blank()

  // 8. Apply approval policy
  progress.phase('Applying approval policy...')
  progress.pushIndent()

  const approvedJudgments = applyApprovalPolicy(judgments, {
    minCompositeScore: config.policy.approval.minCompositeScore,
    minCompliance: config.policy.approval.minCompliance,
    maxApprovedPerCycle: config.policy.approval.maxApprovedPerCycle,
  })

  const approvedProposalIds = new Set(approvedJudgments.map((j) => j.proposalId))

  for (const judgment of judgments) {
    const proposal = compliantProposals.find((p) => p.id === judgment.proposalId)
    if (!proposal) continue

    if (approvedProposalIds.has(judgment.proposalId)) {
      progress.agentResult(proposal.agent, `approved: ${proposal.title}`, true)
      audit.write(
        cycleNum,
        'proposal_approved',
        proposal.id,
        `Proposal ${proposal.id} approved`,
        { compositeScore: judgment.compositeScore },
        proposal.agent,
      )
    } else {
      progress.agentResult(proposal.agent, `rejected: ${proposal.title}`, false)
      audit.write(
        cycleNum,
        'proposal_rejected',
        proposal.id,
        `Proposal ${proposal.id} rejected by policy`,
        { compositeScore: judgment.compositeScore, minRequired: config.policy.approval.minCompositeScore },
        proposal.agent,
      )
    }
  }

  progress.popIndent()
  progress.blank()

  const approvedProposals = compliantProposals.filter((p) => approvedProposalIds.has(p.id))

  // 9. If no approved or dryRun, print report and return
  if (approvedProposals.length === 0 || dryRun) {
    if (dryRun) {
      progress.phase('[DRY RUN] Skipping execution of approved proposals.')
    } else {
      progress.phase('No proposals approved for execution.')
    }

    // Print reputation snapshot
    reputation.recordSnapshot()
    const leaderboard = reputation.getLeaderboard()
    const repData = leaderboard.map((entry) => {
      const before = reputationBefore.get(entry.agentId) ?? entry.score
      const delta = entry.score - before
      return {
        agentId: entry.agentId,
        score: entry.score,
        delta,
        sparkline: reputation.sparkline(entry.agentId),
      }
    })
    progress.phase('Reputation snapshot:')
    progress.reputation(repData)
    progress.blank()
    return
  }

  // 10. Execute approved proposals sequentially
  progress.phase('Executing approved proposals...')

  const updatedBoard = board.load(boardId) ?? boardState

  for (const proposal of approvedProposals) {
    progress.blank()
    progress.phase(`  Running: ${proposal.title} [${proposal.agent}]`)
    progress.pushIndent()

    // Write run_started audit
    audit.write(
      cycleNum,
      'run_started',
      proposal.id,
      `Execution started for proposal ${proposal.id}`,
      { title: proposal.title, agent: proposal.agent },
      proposal.agent,
    )

    let run
    try {
      run = await runExperiment(
        proposal,
        sourceCode,
        config.policy,
        config.pgolf,
        workDir,
        (line: string) => {
          progress.agent(proposal.agent, line)
        },
      )

      // Display metrics with color-coded deltas
      if (run.metrics.valBpb !== undefined) {
        progress.metric('val_bpb', run.metrics.valBpb, updatedBoard.baseline.valBpb)
      }
      if (run.metrics.valLoss !== undefined && updatedBoard.baseline.valBpb !== undefined) {
        progress.metric('val_loss', run.metrics.valLoss, updatedBoard.baseline.valBpb)
      }
      if (run.metrics.artifactBytes !== undefined) {
        progress.metric('artifact_bytes', run.metrics.artifactBytes, updatedBoard.baseline.artifactBytes)
      }

      // Write run_completed or run_failed audit
      if (run.status === 'passed') {
        audit.write(
          cycleNum,
          'run_completed',
          run.id,
          `Run completed for proposal ${proposal.id}: status=${run.status}`,
          {
            proposalId: proposal.id,
            status: run.status,
            valBpb: run.metrics.valBpb,
            artifactBytes: run.metrics.artifactBytes,
          },
          proposal.agent,
        )
      } else {
        audit.write(
          cycleNum,
          'run_failed',
          run.id,
          `Run failed for proposal ${proposal.id}: status=${run.status}`,
          { proposalId: proposal.id, status: run.status },
          proposal.agent,
        )
      }
    } catch (err) {
      progress.agentResult(proposal.agent, `execution error: ${String(err)}`, false)
      audit.write(
        cycleNum,
        'run_failed',
        proposal.id,
        `Execution threw error for proposal ${proposal.id}: ${String(err)}`,
        { error: String(err) },
        proposal.agent,
      )
      progress.popIndent()
      continue
    }

    // Judge result, write precedent, write audit
    try {
      const currentBoard = board.load(boardId) ?? updatedBoard
      const precedent = await judgeResult(
        llm,
        proposal,
        run,
        currentBoard,
        config.agents.judgeMaxTokens,
      )
      precedents.append(precedent)
      audit.write(
        cycleNum,
        'precedent_created',
        precedent.id,
        `Precedent created: [${precedent.outcome}] ${precedent.summary}`,
        { outcome: precedent.outcome, family: precedent.family, delta: precedent.metrics.delta },
        proposal.agent,
      )

      // Check merge threshold, update board if merged
      const currentBoardState = board.load(boardId) ?? currentBoard
      if (
        run.status === 'passed' &&
        shouldMerge(run.metrics, currentBoardState, config.policy.merge, config.pgolf.maxArtifactBytes)
      ) {
        board.updateBest(boardId, {
          valBpb: run.metrics.valBpb!,
          artifactBytes: run.metrics.artifactBytes ?? currentBoardState.currentBest.artifactBytes,
          commitRef: run.id,
          proposalId: proposal.id,
        })
        progress.agentResult(proposal.agent, 'MERGED: new best result!', true)
        audit.write(
          cycleNum,
          'baseline_updated',
          boardId,
          `Board updated with new best from proposal ${proposal.id}`,
          { valBpb: run.metrics.valBpb, artifactBytes: run.metrics.artifactBytes, proposalId: proposal.id },
          proposal.agent,
        )

        // Update reputation: reward merge
        reputation.payout(proposal.agent, config.policy.reputation.rewardMerge, 'merge accepted')
      } else {
        // Update reputation based on outcome
        if (precedent.outcome === 'positive') {
          reputation.payout(
            proposal.agent,
            config.policy.reputation.rewardUsefulNegative,
            'useful result (positive but not merged)',
          )
        } else if (precedent.outcome === 'negative') {
          reputation.payout(
            proposal.agent,
            config.policy.reputation.rewardUsefulNegative,
            'useful negative result',
          )
        } else if (precedent.outcome === 'invalid') {
          reputation.slash(
            proposal.agent,
            config.policy.reputation.penalizeInvalid,
            'invalid experiment result',
          )
        }
      }
    } catch (err) {
      progress.agentResult(proposal.agent, `result judging failed: ${String(err)}`, false)
    }

    progress.popIndent()
  }

  progress.blank()

  // 11. Print cycle report with reputation snapshot and sparklines
  reputation.recordSnapshot()
  const leaderboard = reputation.getLeaderboard()
  const repData = leaderboard.map((entry) => {
    const before = reputationBefore.get(entry.agentId) ?? entry.score
    const delta = entry.score - before
    return {
      agentId: entry.agentId,
      score: entry.score,
      delta,
      sparkline: reputation.sparkline(entry.agentId),
    }
  })

  progress.phase(`Cycle ${cycleNumber}/${totalCycles} complete. Reputation:`)
  progress.reputation(repData)
  progress.blank()
}
