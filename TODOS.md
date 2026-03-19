# Deferred Work

## Phase 2

### Tournament Mode
Head-to-head comparison of top 2 approved proposals per cycle.
Run both against same data/iterations, compare final metrics directly.
Catches noise vs. real improvement. Doubles compute per cycle.
Effort: M | Priority: P2 | Depends on: MVP loop working end-to-end

### Web Dashboard
Local web UI showing cycle history, precedent graph, agent reputation leaderboard, live training progress.
Serves the same data files (JSONL + board JSON) as read-only data source.
Effort: L | Priority: P2 | Depends on: stable CLI loop

### show-next CLI Command
LLM call that synthesizes all precedents and board state into actionable suggestions for human researchers.
"Given everything tried, what should a human try next?" with ranked ideas and reasoning.
Effort: M | Priority: P2 | Depends on: 50+ precedents for meaningful synthesis

### Cycle Summary Reports
Write a markdown report file after multi-cycle runs with metrics, proposals, outcomes, reputation changes.
Useful for unattended overnight runs.
Effort: S | Priority: P2

### Ollama Backend
Local/offline LLM support via Ollama HTTP API at localhost:11434.
LlmClient interface already supports it. Implementation is straightforward.
Effort: S | Priority: P2

## Phase 3

### Agent Meta-Learning
Prompt evolution based on proposal track record.
Analyze which prompt phrasings led to higher-scoring proposals and auto-tune agent system prompts.
Effort: XL | Priority: P3 | Depends on: 50+ cycles of precedent data

### JSONL Rotation
Rotate precedents.jsonl and audit.jsonl at a size threshold (10MB).
Requires reading across rotated files.
Effort: S | Priority: P3

### SQLite Storage Backend
Replace JSONL with SQLite for better query performance and concurrent access.
Effort: M | Priority: P3
