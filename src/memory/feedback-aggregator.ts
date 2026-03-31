import type { Precedent } from '../schema/precedent.js'

export interface FamilyStats {
  family: string
  trials: number
  positiveCount: number
  negativeCount: number
  invalidCount: number
  positiveRate: number
  negativeRate: number
  avgPositiveDelta: number
  avgNegativeDelta: number
  invalidRate: number
}

export interface AgentStats {
  agent: string
  trials: number
  positiveRate: number
  negativeRate: number
  invalidRate: number
  avgDelta: number
}

export interface RLFeedback {
  highImpactFamilies: FamilyStats[]
  avoidFamilies: FamilyStats[]
  agentStats: Record<string, AgentStats>
  suggestedDirections: string[]
}

export class FeedbackAggregator {
  computeFamilyStats(precedents: Precedent[]): FamilyStats[] {
    const grouped = new Map<string, Precedent[]>()
    for (const p of precedents) {
      const list = grouped.get(p.family) ?? []
      list.push(p)
      grouped.set(p.family, list)
    }

    const stats: FamilyStats[] = []
    for (const [family, entries] of grouped) {
      if (entries.length < 2) continue

      const positiveEntries = entries.filter(p => p.outcome === 'positive')
      const negativeEntries = entries.filter(p => p.outcome === 'negative')
      const invalidEntries = entries.filter(p => p.outcome === 'invalid')

      const positiveDeltaSum = positiveEntries.reduce(
        (sum, p) => sum + (p.metrics.delta ?? 0),
        0,
      )
      const negativeDeltaSum = negativeEntries.reduce(
        (sum, p) => sum + (p.metrics.delta ?? 0),
        0,
      )

      stats.push({
        family,
        trials: entries.length,
        positiveCount: positiveEntries.length,
        negativeCount: negativeEntries.length,
        invalidCount: invalidEntries.length,
        positiveRate: positiveEntries.length / entries.length,
        negativeRate: negativeEntries.length / entries.length,
        avgPositiveDelta:
          positiveEntries.length > 0
            ? positiveDeltaSum / positiveEntries.length
            : 0,
        avgNegativeDelta:
          negativeEntries.length > 0
            ? negativeDeltaSum / negativeEntries.length
            : 0,
        invalidRate: invalidEntries.length / entries.length,
      })
    }

    return stats
  }

  computeAgentStats(precedents: Precedent[]): Record<string, AgentStats> {
    const grouped = new Map<string, Precedent[]>()
    for (const p of precedents) {
      const list = grouped.get(p.category) ?? []
      list.push(p)
      grouped.set(p.category, list)
    }

    const result: Record<string, AgentStats> = {}
    for (const [agent, entries] of grouped) {
      const positiveCount = entries.filter(p => p.outcome === 'positive').length
      const negativeCount = entries.filter(p => p.outcome === 'negative').length
      const invalidCount = entries.filter(p => p.outcome === 'invalid').length
      const deltaSum = entries.reduce(
        (sum, p) => sum + (p.metrics.delta ?? 0),
        0,
      )

      result[agent] = {
        agent,
        trials: entries.length,
        positiveRate: positiveCount / entries.length,
        negativeRate: negativeCount / entries.length,
        invalidRate: invalidCount / entries.length,
        avgDelta: entries.length > 0 ? deltaSum / entries.length : 0,
      }
    }

    return result
  }

  suggestDirections(
    familyStats: FamilyStats[],
    unexploredFamilies: string[],
  ): string[] {
    const suggestions: string[] = []

    // 1. Continue exploring high-impact families
    const highImpact = familyStats
      .filter(f => f.positiveRate > 0.3 && f.avgPositiveDelta < -0.001)
      .sort((a, b) => a.avgPositiveDelta - b.avgPositiveDelta)

    for (const f of highImpact) {
      if (suggestions.length >= 5) break
      suggestions.push(
        `Continue exploring ${f.family} - ${f.positiveCount} positive results, avg improvement ${f.avgPositiveDelta.toFixed(4)} bpb`,
      )
    }

    // 2. Combine positive families with adjacent unexplored
    if (highImpact.length > 0 && unexploredFamilies.length > 0) {
      for (const unexplored of unexploredFamilies) {
        if (suggestions.length >= 5) break
        suggestions.push(
          `Try combining ${highImpact[0].family} with ${unexplored}`,
        )
      }
    }

    // 3. Avoid families with high failure rates
    const toAvoid = familyStats.filter(
      f => f.invalidRate > 0.5 || (f.negativeRate > 0.7 && f.trials > 2),
    )
    for (const f of toAvoid) {
      if (suggestions.length >= 5) break
      suggestions.push(
        `Avoid ${f.family} - ${f.negativeCount + f.invalidCount} failures in ${f.trials} trials`,
      )
    }

    return suggestions.slice(0, 5)
  }

  aggregate(precedents: Precedent[], unexploredFamilies: string[]): RLFeedback {
    const familyStats = this.computeFamilyStats(precedents)
    const agentStats = this.computeAgentStats(precedents)

    const highImpactFamilies = familyStats
      .filter(f => f.positiveRate > 0.3 && f.avgPositiveDelta < -0.001)
      .sort((a, b) => a.avgPositiveDelta - b.avgPositiveDelta)
      .slice(0, 5)  // cap to avoid blowing prompt budget

    const avoidFamilies = familyStats.filter(
      f => f.invalidRate > 0.5 || (f.negativeRate > 0.7 && f.trials > 2),
    ).slice(0, 3)  // cap to avoid blowing prompt budget

    const suggestedDirections = this.suggestDirections(
      familyStats,
      unexploredFamilies,
    )

    return {
      highImpactFamilies,
      avoidFamilies,
      agentStats,
      suggestedDirections,
    }
  }
}
