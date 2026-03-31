# consensus-golf

Autonomous ML research system for [OpenAI Parameter Golf](https://github.com/openai/parameter-golf). Uses multi-agent consensus to generate, evaluate, and run training experiments that compete on the leaderboard.

The challenge: train the best language model that fits in 16MB and trains in under 10 minutes on 8xH100s, scored by val_bpb (bits per byte) on FineWeb.

## How it works

Three LLM agents (architecture, compression, training) propose modifications to a baseline training script. A panel of three judges votes on each proposal. Approved proposals are tested through a tiered GPU pipeline, with each tier filtering for the next.

```
3 agents propose → Tier 0 (syntax check) → 3 judges vote → Tier 1 (M3 smoke)
    → Tier 2 (1xH100) → Tier 3 (8xH100 = leaderboard score)
```

Results feed back into the next cycle as precedents. A feedback aggregator tracks which technique families succeed or fail, steering future proposals toward productive directions and away from dead ends.

The system runs autonomously overnight, cycling through propose-evaluate-execute loops on a GPU budget.

### Tier system

| Tier | Hardware | Time | Cost | What it tests |
|------|----------|------|------|---------------|
| 0 | CPU | instant | Free | Syntax + security compliance |
| 1 | M3 (local) | ~10 min | Free | Loss descent rate vs baseline |
| 2 | 1xH100 | ~10 min | ~$0.45 | Convergence speed, val_bpb at 1450 steps |
| 3 | 8xH100 | ~10 min | ~$3.50 | Full challenge run, 20000 steps, leaderboard val_bpb |

Each tier has its own baseline. Proposals are compared against the baseline at the same hardware tier, so comparisons are always fair. Promotion between tiers is selective: top 2 from Tier 1 by descent rate, top 1 from Tier 2 by val_bpb.

### Feedback loop

After each run, an LLM result judge classifies the outcome into a technique family (e.g., "learning-rate", "attention-optimization") and records it as a precedent. The feedback aggregator computes:

- **High-impact families**: techniques with >30% positive rate and meaningful improvement
- **Avoid families**: techniques with >70% failure rate
- **Per-agent stats**: which agent produces the most useful proposals
- **Suggested directions**: cross-referencing positive results with unexplored families

This feedback is injected into agent prompts each cycle, creating a learning loop that gets smarter over time without modifying the agents themselves.

### Consensus voting

Proposals require approval from a multi-judge panel before execution. Three judge personas (conservative, innovative, efficiency-focused) score proposals on novelty, plausibility, expected gain, compliance, and simplicity. The consensus-tools library manages the voting protocol, credit ledger, and resolution logic.

Agents earn credits for successful experiments and lose credits for invalid proposals, creating economic pressure toward quality.

## Setup

### Prerequisites

- Node.js 20+
- Python 3.12+ with MLX support (Apple Silicon for Tier 1)
- pnpm
- Anthropic API key
- RunPod API key + SSH key (for Tier 2/3)

### Install

```bash
git clone https://github.com/kaicianflone/consensus-golf.git
cd consensus-golf
pnpm install
npm run build:deps

# Python venv for Tier 1 smoke tests
python3 -m venv .venv
source .venv/bin/activate
pip install numpy sentencepiece mlx

# Download dataset (sp1024 tokenization)
cd packages/parameter-golf
python3 data/cached_challenge_fineweb.py --variant sp1024 --train-shards 1
cd ../..
```

### Configure

Copy `.env.local` with your API keys:

```
ANTHROPIC_API_KEY=sk-ant-...
RUNPOD_API_KEY=rpa_...
```

Review `config/default-policy.json` for tier settings. Tier 2 and Tier 3 are disabled by default.

### Run

**Single cycle** (Tier 0 + consensus + Tier 1 only):

```bash
set -a && source .env.local && set +a
npm run cycle -- --cycles 1 --board pgolf-test
```

**Overnight mode** (4 hours, $20 GPU budget):

```bash
npm run cycle -- --overnight --gpu-budget 20 --budget-seconds 14400 --board pgolf-live
```

**View results:**

```bash
npm run board -- pgolf-live          # current board state
npm run precedents                    # experiment history
ls data/reports/                      # overnight summary reports
```

### Tests

```bash
npm test                              # 169 tests across 27 files
```

## Architecture

See [ARCHITECTURE.md](ARCHITECTURE.md) for the full cycle flow with ASCII diagrams, tier promotion logic, consensus-tools integration, and feedback loop details.

### Key directories

```
src/
  agents/       — LLM proposal generators (architecture, compression, training)
  judges/       — Multi-judge evaluation + result classification
  runner/       — Tier 0/1/2/3 runners, RunPod client, sandbox
  loop/         — Cycle orchestration, scheduler, summary reports
  adapter/      — Consensus-tools bridge
  memory/       — Precedent store, coverage tracker, feedback aggregator
  persistence/  — Board manager, baseline manager, audit writer
  schema/       — Zod schemas for proposals, experiments, config
  cli/          — CLI entry points
  policy/       — Merge policy

config/         — Policy, consensus, agent, pgolf configuration
packages/
  parameter-golf/  — Training scripts (train_gpt.py, train_gpt_mlx.py)
  consensus-tools/ — Voting protocol, ledger, guards (git submodule)
data/
  boards/       — Board state per experiment track
  baselines/    — Per-tier baseline curves
  precedents.jsonl — Experiment outcome history
  consensus/    — Consensus-tools board (ledger, jobs, votes)
  reports/       — Overnight summary markdown reports
```

## Challenge context

OpenAI Parameter Golf runs March 18 to April 30, 2026. The leaderboard baseline is 1.2244 val_bpb on the `fineweb10B_sp1024` dataset with a 9-layer 512-dim model, 1024 vocab, tied embeddings, trained for ~10 minutes on 8xH100s.

This project approaches the challenge through automated search rather than manual tuning. The hypothesis: a system that can run 60+ proposals per overnight session, learning from each result, will explore the hyperparameter and architecture space faster than manual iteration.

Current infrastructure status:
- Tier 0-1: fully operational, tested
- Tier 2 (1xH100): confirmed working on RunPod EU-NL-1 datacenter
- Tier 3 (8xH100): implemented, pending first live run
- Feedback loop: implemented, pending 50+ precedents for meaningful signal

## License

See individual package licenses. The parameter-golf training scripts adapt code from [modded-nanogpt](https://github.com/KellerJordan/modded-nanogpt), see [packages/parameter-golf/THIRD_PARTY_NOTICES.md](packages/parameter-golf/THIRD_PARTY_NOTICES.md).
