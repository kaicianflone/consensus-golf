# Consensus-Golf Architecture

## Full Cycle Flow

```
╔══════════════════════════════════════════════════════════════════════════════╗
║                    CONSENSUS-GOLF: FULL CYCLE ARCHITECTURE                  ║
╚══════════════════════════════════════════════════════════════════════════════╝

  data/precedents.jsonl ─────────────────────────────────────────────┐
  data/baselines/{board}-baseline.json ──────────────────────────┐   │
  packages/parameter-golf/train_gpt_mlx.py (source code) ───┐   │   │
  config/technique-taxonomy.json ────────────────────────┐   │   │   │
                                                         │   │   │   │
═══ PHASE 0.5: SETUP ═══════════════════════════════════╪═══╪═══╪═══╪═══
                                                         │   │   │   │
  CoverageTracker.buildCoverageMap(precedents)◄──────────┘   │   │   │
       │                                                     │   │   │
       ├─► coverageMarkdown (explored/unexplored families)   │   │   │
       ├─► explorationTargets (top 3 unexplored)             │   │   │
       └─► explorerName = agents[cycleNum % 3]               │   │   │
                                                              │   │   │
  FeedbackAggregator.aggregate(precedents, unexplored)◄───────┼───┼───┘
       │                                                      │   │
       ├─► highImpactFamilies (top 5 by positive rate)        │   │
       ├─► avoidFamilies (top 3 by failure rate)              │   │
       ├─► agentStats (per-category success rates)            │   │
       └─► suggestedDirections (up to 5 natural language)     │   │
                                                              │   │
  Baseline capture (if missing/stale) ◄───────────────────────┘   │
       │  runExperiment(unmodified source, 50 iters on M3)        │
       └─► saves descent rate + step losses to baseline file      │
                                                                   │
  AgentContextOptions = {                                          │
    coverageMarkdown,                                              │
    explorationMode (true for 1 of 3 agents),                     │
    explorationTargets,                                            │
    baselineSignal { descentRate, lossDrop },                      │
    rlFeedback { highImpact, avoid, agentStats, suggestions }      │
  }                                                                │
                                                                   │
═══ PHASE 1: PROPOSAL GENERATION (parallel LLM calls) ════════════╪═══
                                                                   │
  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐   │
  │  architecture    │  │  compression    │  │  training        │   │
  │  Agent           │  │  Agent          │  │  Agent           │   │
  │                  │  │                 │  │                  │   │
  │ System prompt:   │  │ System prompt:  │  │ System prompt:   │   │
  │ - Board state    │  │ - Board state   │  │ - Board state    │   │
  │ - Last 20        │◄─┤ - Last 20      ◄┤  │ - Last 20       │◄──┘
  │   precedents     │  │   precedents    │  │   precedents     │
  │ - Coverage map   │  │ - Coverage map  │  │ - Coverage map   │
  │ - RL feedback    │  │ - RL feedback   │  │ - RL feedback    │
  │ - Baseline sig   │  │ - Baseline sig  │  │ - Baseline sig   │
  │ - Source code    │  │ - Source code   │  │ - Source code    │
  │                  │  │                 │  │                  │
  │ Output:          │  │ Output:         │  │ Output:          │
  │  modifiedSource  │  │  modifiedSource │  │  modifiedSource  │
  │  title, thesis   │  │  title, thesis  │  │  title, thesis   │
  │  risks, category │  │  risks, category│  │  risks, category │
  └────────┬─────────┘  └────────┬────────┘  └────────┬────────┘
           │                     │                     │
           │  Anthropic API      │  Anthropic API      │  Anthropic API
           │  (Claude Sonnet)    │  (Claude Sonnet)    │  (Claude Sonnet)
           │                     │                     │
  FAILURE: consensus.slashAgent(agent, 4 credits, "generation failed")
           │                     │                     │
           └──────────┬──────────┴──────────┬──────────┘
                      │                     │
                      ▼                     ▼
              3 Proposal objects    audit: proposal_created
                      │
═══ PHASE 2: TIER 0 — COMPLIANCE (parallel, CPU, instant) ═══════════
                      │
        PipelineOrchestrator.runTier(0, proposals)
                      │
        ┌─────────────┼─────────────┐
        ▼             ▼             ▼
   Tier0Runner   Tier0Runner   Tier0Runner     ← Promise.all()
        │             │             │
   py_compile    py_compile    py_compile      ← syntax check
   security      security      security       ← regex scan for
   scan          scan          scan              blocked patterns
        │             │             │
        ▼             ▼             ▼
   PASS/FAIL     PASS/FAIL     PASS/FAIL
        │             │             │
  FAILURE: consensus.slashAgent(agent, 8 credits, "compliance failure")
        │             │             │
        └──────┬──────┴──────┬──────┘
               │             │
               ▼             ▼
        compliantProposals (typically 2-3)
               │
═══ PHASE 3: CONSENSUS VOTING (sequential LLM calls) ════════════════
               │
  For each compliant proposal:
               │
  ┌────────────┴────────────────────────────────────────────┐
  │                                                         │
  │  consensus.postProposalJob(cycleNum, proposalId)        │
  │       │                                                 │
  │       ▼  consensus-tools/core: Board.createJob()        │
  │       │  mode=VOTING, quorum=1, stakeRequired=1         │
  │       │  Creates job in data/consensus/board.json       │
  │       │                                                 │
  │  consensus.submitProposal(agent, jobId, proposal, score)│
  │       │                                                 │
  │       ▼  consensus-tools/core: Board.claimJob()         │
  │       │  Stakes 1 credit from agent's ledger            │
  │       │  Board.submitResult() with proposal artifacts   │
  │       │                                                 │
  │  runMultiJudge(proposal, board, precedents)             │
  │       │                                                 │
  │       ├─► judge-conservative: LLM scores (0-1) on:     │
  │       │     novelty, plausibility, expectedGain,        │
  │       │     compliance, simplicity                      │
  │       │     → recommendation: approve/reject/revise     │
  │       │                                                 │
  │       ├─► judge-innovative: same 5 dimensions           │
  │       │     (weights novelty + risk-tolerance higher)   │
  │       │                                                 │
  │       └─► judge-efficiency: same 5 dimensions           │
  │             (weights simplicity + compression higher)   │
  │                                                         │
  │  For each judge:                                        │
  │    consensus.castJudgmentVote(judgeId, jobId, ...)      │
  │       │                                                 │
  │       ▼  consensus-tools/core: Board.castVote()         │
  │       │  score: 1.0 (approve) | 0.5 (revise) | -1 (rej)│
  │       │  weight: judge's compositeScore (0-1)           │
  │       │  Persists to data/consensus/board.json          │
  │                                                         │
  └─────────────────────────────────────────────────────────┘
               │
  consensus.resolveAllProposals()
       │
       ▼  consensus-tools/core: Board.resolveJob()
       │  Policy: APPROVAL_VOTE, quorum=1, minScore=0
       │  Checks: enough votes? aggregate score > min?
       │  Returns: winningSubmissionIds[]
       │
       ▼
  approvedProposals (typically 1-2 of 3)
       │
═══ PHASE 4: TIER 1 — M3 SMOKE TEST (sequential, local) ═════════════
       │
  pipeline.runTier(1, approvedProposals)
       │
  For each approved proposal (sequential):
       │
  ┌────┴──────────────────────────────────────────────────┐
  │  Tier1Runner.run(proposal, ctx)                       │
  │       │                                               │
  │  runExperiment(proposal.modifiedSource)                │
  │       │                                               │
  │       ├─ mkdir work/{runId}/                          │
  │       ├─ write train_gpt_mlx.py (modified)            │
  │       ├─ spawn: .venv/bin/python3 train_gpt_mlx.py    │
  │       │    env: ITERATIONS=50, BATCH=8192, WALLCLOCK=600│
  │       ├─ stream stdout, detect NaN                    │
  │       ├─ parse metrics: stepLosses[], trainLoss       │
  │       └─ status: passed (exit 0 or wallclock) | failed│
  │       │                                               │
  │  analyzeLossCurve(stepLosses)                         │
  │       │ → descentRate (OLS slope)                     │
  │       │ → lossDrop, lossDropFraction                  │
  │       │                                               │
  │  compareToBaseline(candidate.signal, baseline.signal)  │
  │       │ → relativeDescentRate = cand.slope / base.slope│
  │       │ → verdict: faster | similar | slower          │
  │       │                                               │
  │  POST-GATE:                                           │
  │       │ if run.status != 'passed' → FAIL              │
  │       │ if relativeDescentRate < 0.8 → FAIL           │
  │       │ else → PASS (promotable = true)               │
  │       │                                               │
  └───────┴───────────────────────────────────────────────┘
       │
  handleTierResults(tier1Results, "Tier 1")
       │
       ├─ For each result:
       │    judgeResult(llm, proposal, run, board)          ← LLM classifies outcome
       │       │ → Precedent { family, outcome, summary }
       │       └─ precedents.append() → data/precedents.jsonl  ← FEEDBACK LOOP
       │
       │    shouldMerge(metrics, board, policy)?
       │       │ if valBpb < board.currentBest - 0.002:
       │       │   board.updateBest() → data/boards/{id}.json
       │       │   consensus.rewardAgent(+5 credits)
       │       │ else:
       │       │   consensus.rewardAgent(+2 useful) or slashAgent(-4 invalid)
       │
  pipeline.getPromoted(tier1Results, maxPromotions=2)
       │ sort by relativeDescentRate descending
       │ take top 2 that passed
       │
       ▼
  promoted (0-2 proposals)
       │
═══ PHASE 5: TIER 2 — 1xH100 GPU (sequential, RunPod) ═══════════════
       │
  if promoted.length > 0 && tier2.enabled:
       │
  pipeline.runTier(2, promoted)
       │
  ┌────┴──────────────────────────────────────────────────┐
  │  Tier2Runner.run(proposal, ctx)                       │
  │       │                                               │
  │  PRE-GATE:                                            │
  │       │ tier2 enabled? RUNPOD_API_KEY set?            │
  │       │ costTracker.canAfford($0.45)?                 │
  │       │                                               │
  │  GPU FALLBACK CHAIN (retry on SUPPLY_CONSTRAINT/5xx): │
  │       │ 1. NVIDIA H100 80GB HBM3                     │
  │       │ 2. NVIDIA A100 80GB PCIe                     │
  │       │ 3. NVIDIA A100-SXM4-80GB                     │
  │       │ 4. NVIDIA GeForce RTX 4090                   │
  │       │                                               │
  │  RunPodsClient.createPod(gpuCount=1, vol=fmbckw29gp) │
  │       │ GraphQL: podFindAndDeployOnDemand             │
  │       │                                               │
  │  waitForRunning(podId, 120s)                          │
  │       │ polls getPodStatus() every 5s                 │
  │       │ retries transient 400/500 up to 5x            │
  │       │                                               │
  │  executeCommand: pip install sentencepiece             │
  │       │ SSH -tt, pipe through stdin                   │
  │       │                                               │
  │  uploadScript(modifiedSource → /workspace/train_gpt.py)│
  │       │ heredoc + stty -echo + base64 decode          │
  │       │                                               │
  │  executeCommand: PYTHONPATH=/workspace/site-packages   │
  │       │ LOCAL_RANK=0 RANK=0 WORLD_SIZE=1              │
  │       │ MAX_WALLCLOCK_SECONDS=600                     │
  │       │ python3 /workspace/train_gpt.py               │
  │       │ SSH timeout = 600 + 300 = 900s                │
  │       │                                               │
  │  parseMetrics(stdout)                                 │
  │       │ → valBpb, valLoss, trainLoss, artifactBytes   │
  │       │                                               │
  │  FINALLY: terminatePod(podId)                         │
  │       │   costTracker.recordSpend($0.45)              │
  │       │                                               │
  │  POST-GATE:                                           │
  │       │ run.status == 'passed'?                       │
  │       │ valBpb defined?                               │
  │       │ artifactBytes <= 16MB?                        │
  │       │ → promotable = true/false                     │
  │       │                                               │
  └───────┴───────────────────────────────────────────────┘
       │
  handleTierResults(tier2Results, "Tier 2", skipMerge=hasTier(3))
       │
       ├─ judgeResult → Precedent → precedents.jsonl       ← FEEDBACK LOOP
       ├─ if !skipMerge: shouldMerge check + board update
       │  (skipped when Tier 3 enabled to avoid double-merge)
       │
  pipeline.getPromotedByBpb(tier2Results, maxPromotions=1)
       │ sort by valBpb ascending (lower = better)
       │ take top 1 that passed
       │
       ▼
  promotedToTier3 (0-1 proposals)
       │
═══ PHASE 6: TIER 3 — 8xH100 GPU (sequential, RunPod) ═══════════════
       │
  if promotedToTier3.length > 0 && tier3.enabled:
       │
  pipeline.runTier(3, promotedToTier3)
       │
  ┌────┴──────────────────────────────────────────────────┐
  │  Tier3Runner.run(proposal, ctx)                       │
  │       │                                               │
  │  PRE-GATE:                                            │
  │       │ tier3 enabled? RUNPOD_API_KEY set?            │
  │       │ costTracker.canAfford($3.50)?                 │
  │       │                                               │
  │  GPU FALLBACK (retry on SUPPLY_CONSTRAINT/5xx):       │
  │       │ 1. tier3Config.gpuType (default: H100 HBM3)  │
  │       │ 2. NVIDIA H100 SXM                           │
  │       │                                               │
  │  RunPodsClient.createPod(gpuCount=8, vol=fmbckw29gp) │
  │       │                                               │
  │  waitForRunning(podId, 120s)                          │
  │       │                                               │
  │  executeCommand: pip install sentencepiece             │
  │       │                                               │
  │  uploadScript(modifiedSource → /workspace/train_gpt.py)│
  │       │                                               │
  │  executeCommand: PYTHONPATH=/workspace/site-packages   │
  │       │ MAX_WALLCLOCK_SECONDS=600                     │
  │       │ torchrun --standalone --nproc_per_node=8      │ ← DDP auto
  │       │          /workspace/train_gpt.py              │
  │       │ SSH timeout = 600 + 300 = 900s                │
  │       │                                               │
  │  parseMetrics(stdout)                                 │
  │       │ → valBpb (THE LEADERBOARD SCORE), artifactBytes│
  │       │                                               │
  │  FINALLY: terminatePod(podId)                         │
  │       │   costTracker.recordSpend($3.50)              │
  │       │                                               │
  │  POST-GATE:                                           │
  │       │ run.status == 'passed'?                       │
  │       │ valBpb defined?                               │
  │       │ artifactBytes <= 16MB?                        │
  │       │                                               │
  └───────┴───────────────────────────────────────────────┘
       │
  handleTierResults(tier3Results, "Tier 3")
       │
       ├─ judgeResult → Precedent → precedents.jsonl       ← FEEDBACK LOOP
       ├─ shouldMerge: if valBpb < board.best - 0.002:
       │     board.updateBest()
       │     consensus.rewardAgent(+5 credits)
       │     audit: baseline_updated
       │
═══ CYCLE COMPLETE ════════════════════════════════════════════════════
       │
  costTracker.getSummary() → "GPU spend: $X.XX / $20.00"
  printBalanceReport(agents, balancesBefore)
       │ architecture: 106 (+6)
       │ compression:   98 (-2)
       │ training:     112 (+12)
       │
  return CycleResult {
    proposalsGenerated, tier0Passed, tier1Passed,
    tier2Attempted, tier2Passed, tier3Attempted, tier3Passed,
    bestValBpb, bestTechnique, wallclockSec
  }
```

## Feedback Loop (Autoresearch)

```
  Each cycle produces:
       │
       ├─ Precedents (append-only JSONL)
       │    { family, outcome, metrics.delta, category, summary }
       │
       ├─ Audit trail (append-only JSONL)
       │    { eventType, agentId, data }
       │
       └─ Board state (atomic JSON)
            { baseline.valBpb, currentBest.valBpb }

  Next cycle reads:
       │
       ├─ PrecedentStore.readForAgent(category, limit=20)
       │    → injected into each agent's LLM prompt
       │
       ├─ CoverageTracker.buildCoverageMap(allPrecedents)
       │    → explored/unexplored technique families
       │    → explorationTargets for the cycle's explorer agent
       │
       └─ FeedbackAggregator.aggregate(allPrecedents, unexplored)
            │
            ├─ computeFamilyStats: group by family
            │    positiveRate, avgDelta per family
            │    → highImpact (>30% positive, delta < -0.001)
            │    → avoid (>50% invalid or >70% negative)
            │
            ├─ computeAgentStats: group by category
            │    per-agent success/failure rates
            │
            └─ suggestDirections: cross-reference
                 positive families x unexplored families
                 → "Continue exploring X" / "Combine X with Y" / "Avoid Z"
```

## Consensus-Tools Integration

```
  packages/consensus-tools/core provides:

  Board (data/consensus/board.json)
  ├── Jobs      — one per proposal per cycle
  │   └── createJob(mode=VOTING, quorum=1, stake=1)
  ├── Claims    — agent claims a job (stakes credits)
  │   └── claimJob(agentId, jobId, leaseSec=3600)
  ├── Submissions — proposal artifacts attached to job
  │   └── submitResult(agentId, claimId, { proposalId, score })
  ├── Votes     — judge votes per submission
  │   └── castVote(judgeId, submissionId, score, weight, rationale)
  ├── Resolutions — voting outcome
  │   └── resolveJob(jobId) → winningSubmissionIds[]
  └── Ledger    — append-only credit log
      ├── FAUCET: initial 100 credits per agent
      ├── SLASH:  -4 (invalid), -8 (noncompliant)
      ├── PAYOUT: +5 (merge), +2 (useful result)
      └── getBalance(agentId) → sum of all entries

  ConsensusBridge (src/adapter/consensus-bridge.ts) wraps Board:
  ├── postProposalJob()    → Board.createJob()
  ├── submitProposal()     → Board.claimJob() + submitResult()
  ├── castJudgmentVote()   → Board.castVote()
  ├── resolveAllProposals()→ Board.resolveJob() for each
  ├── rewardAgent()        → Board.ledger.payout()
  ├── slashAgent()         → Board.ledger.slash()
  └── getAgentBalance()    → Board.ledger.getBalance()
```

## Promotion Funnel

```
  3 proposals generated
       │
       ▼  Tier 0: syntax + security (parallel, instant)
  ~2-3 compliant
       │
       ▼  Consensus: 3 judges vote (sequential LLM)
  ~1-2 approved
       │
       ▼  Tier 1: M3 smoke test, 600s (sequential)
       │  GATE: relativeDescentRate >= 0.8
  ~0-1 pass
       │
       ▼  Promote top 2 by descentRate
       │
       ▼  Tier 2: 1xH100, 600s, ~$0.45 (sequential)
       │  GATE: valBpb defined + artifact < 16MB
       │  MERGE: skipped if Tier 3 enabled
  ~0-1 pass
       │
       ▼  Promote top 1 by valBpb (lower = better)
       │
       ▼  Tier 3: 8xH100, 600s, ~$3.50 (sequential)
       │  GATE: valBpb defined + artifact < 16MB
       │  MERGE: if valBpb < board.best - 0.002
  ~0-1 pass
       │
       ▼  NEW LEADERBOARD SCORE

  Per overnight (4hr, ~20 cycles, $20 GPU budget):
  ~60 proposals → ~40 T0 → ~20 T1 → ~8 T2 → ~4 T3
```

## Tier Economics

| Tier | Hardware | Wallclock | Steps | Cost | Runs/$20 | Purpose |
|------|----------|-----------|-------|------|----------|---------|
| 0 | CPU | instant | 0 | Free | Unlimited | Syntax + security filter |
| 1 | M3 local | 600s | 50 | Free | Unlimited | Descent rate filter |
| 2 | 1xH100 | 600s | ~1450 | ~$0.45 | ~44 | Convergence signal |
| 3 | 8xH100 | 600s | ~20000 | ~$3.50 | ~5 | Leaderboard score |

## Key Files

| Component | File |
|-----------|------|
| Cycle orchestration | src/loop/cycle.ts |
| Tier runner interface | src/runner/tier-runner.ts |
| Pipeline orchestrator | src/runner/pipeline.ts |
| Tier 0 (compliance) | src/runner/tier0-runner.ts |
| Tier 1 (M3 smoke) | src/runner/tier1-runner.ts |
| Tier 2 (1xH100) | src/runner/tier2-runner.ts |
| Tier 3 (8xH100) | src/runner/tier3-runner.ts |
| RunPod client | src/runner/runpods-client.ts |
| Local sandbox | src/runner/sandbox.ts |
| Cost tracker | src/runner/cost-tracker.ts |
| Consensus bridge | src/adapter/consensus-bridge.ts |
| Feedback aggregator | src/memory/feedback-aggregator.ts |
| Precedent store | src/memory/precedent-store.ts |
| Coverage tracker | src/memory/technique-coverage.ts |
| Agent context builder | src/agents/context.ts |
| Baseline manager | src/persistence/baseline-manager.ts |
| Board manager | src/persistence/board-manager.ts |
| Config schemas | src/schema/config.ts |
| Overnight scheduler | src/loop/scheduler.ts |
| Summary reports | src/loop/summary-report.ts |

## Data Files

| File | Format | Purpose |
|------|--------|---------|
| data/boards/{id}.json | Atomic JSON | Board state (baseline, currentBest, activeCycle) |
| data/baselines/{id}-baseline.json | Atomic JSON | Tier 1 baseline loss curve |
| data/baselines/{id}-baseline-tier{N}.json | Atomic JSON | Per-tier baselines |
| data/precedents.jsonl | Append JSONL | All experiment outcomes (feedback loop) |
| data/consensus/board.json | Atomic JSON | Consensus-tools ledger, jobs, votes |
| data/audit.jsonl | Append JSONL | Full event trail |
| data/reports/{id}-{ts}.md | Markdown | Overnight summary reports |
| config/default-policy.json | JSON | Tier configs, execution params, merge policy |
| config/consensus.json | JSON | Agent list, judge list, rewards, voting policy |
| config/agents.json | JSON | LLM backend, model, temperature |
| config/pgolf.json | JSON | Repo path, data path, baseline val_bpb |
