const REP_FLOOR = 10
const DEFAULT_REP = 100
const SPARKLINE_CHARS = '\u2581\u2582\u2583\u2584\u2585\u2586\u2587\u2588'

export class ReputationTracker {
  private scores: Map<string, number>
  private history: Map<string, number[]>

  constructor(agentIds: string[]) {
    this.scores = new Map()
    this.history = new Map()
    for (const id of agentIds) {
      this.scores.set(id, DEFAULT_REP)
      this.history.set(id, [])
    }
  }

  getScore(agentId: string): number {
    return this.scores.get(agentId) ?? DEFAULT_REP
  }

  payout(agentId: string, amount: number, _reason: string): { delta: number; newScore: number } {
    const delta = Math.abs(amount)
    const current = this.getScore(agentId)
    const newScore = current + delta
    this.scores.set(agentId, newScore)
    return { delta, newScore }
  }

  slash(agentId: string, amount: number, _reason: string): { delta: number; newScore: number } {
    const delta = Math.abs(amount)
    const current = this.getScore(agentId)
    const newScore = Math.max(REP_FLOOR, current - delta)
    this.scores.set(agentId, newScore)
    return { delta, newScore }
  }

  recordSnapshot(): void {
    for (const [id, score] of this.scores.entries()) {
      const hist = this.history.get(id) ?? []
      hist.push(score)
      this.history.set(id, hist)
    }
  }

  getHistory(agentId: string): number[] {
    return this.history.get(agentId) ?? []
  }

  sparkline(agentId: string): string {
    const hist = this.getHistory(agentId)
    if (hist.length === 0) return ''
    const min = Math.min(...hist)
    const max = Math.max(...hist)
    const range = max - min
    return hist
      .map((v) => {
        const idx =
          range === 0
            ? SPARKLINE_CHARS.length - 1
            : Math.min(
                SPARKLINE_CHARS.length - 1,
                Math.floor(((v - min) / range) * SPARKLINE_CHARS.length),
              )
        return SPARKLINE_CHARS[idx]
      })
      .join('')
  }

  getLeaderboard(): Array<{ agentId: string; score: number }> {
    return Array.from(this.scores.entries())
      .map(([agentId, score]) => ({ agentId, score }))
      .sort((a, b) => b.score - a.score)
  }

  toJSON(): Record<string, number> {
    return Object.fromEntries(this.scores.entries())
  }

  loadFromJSON(data: Record<string, number>): void {
    for (const [id, score] of Object.entries(data)) {
      this.scores.set(id, score)
    }
  }
}
