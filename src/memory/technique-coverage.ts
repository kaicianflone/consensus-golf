import type { Precedent } from '../schema/precedent.js'

export interface TechniqueFamily {
  category: string
  description: string
  tags: string[]
}

export interface TaxonomyData {
  families: Record<string, TechniqueFamily>
}

export interface CoverageEntry {
  family: string
  category: string
  description: string
  trialCount: number
  outcomes: { positive: number; negative: number; invalid: number; uncertain: number }
}

export interface CoverageMap {
  explored: CoverageEntry[]
  unexplored: Array<{ family: string; category: string; description: string }>
  coveragePct: number
}

export class TechniqueCoverageTracker {
  constructor(private readonly taxonomy: TaxonomyData) {}

  buildCoverageMap(precedents: Precedent[]): CoverageMap {
    const familyKeys = Object.keys(this.taxonomy.families)
    const counts = new Map<string, CoverageEntry>()

    // Initialize all families
    for (const key of familyKeys) {
      const fam = this.taxonomy.families[key]
      counts.set(key, {
        family: key,
        category: fam.category,
        description: fam.description,
        trialCount: 0,
        outcomes: { positive: 0, negative: 0, invalid: 0, uncertain: 0 },
      })
    }

    // Match each precedent to families
    for (const p of precedents) {
      const matchedFamilies = this.matchPrecedentToFamilies(p)
      for (const familyKey of matchedFamilies) {
        const entry = counts.get(familyKey)
        if (entry) {
          entry.trialCount++
          if (p.outcome === 'positive') entry.outcomes.positive++
          else if (p.outcome === 'negative') entry.outcomes.negative++
          else if (p.outcome === 'invalid') entry.outcomes.invalid++
          else entry.outcomes.uncertain++
        }
      }
    }

    const explored: CoverageEntry[] = []
    const unexplored: Array<{ family: string; category: string; description: string }> = []

    for (const [key, entry] of counts) {
      if (entry.trialCount > 0) {
        explored.push(entry)
      } else {
        unexplored.push({ family: key, category: entry.category, description: entry.description })
      }
    }

    const coveragePct = familyKeys.length > 0
      ? (explored.length / familyKeys.length) * 100
      : 0

    return { explored, unexplored, coveragePct }
  }

  matchPrecedentToFamilies(precedent: Precedent): string[] {
    const matched: string[] = []
    const precedentTokens = [
      precedent.family.toLowerCase(),
      ...precedent.tags.map(t => t.toLowerCase()),
    ]

    for (const [familyKey, family] of Object.entries(this.taxonomy.families)) {
      const familyTags = family.tags.map(t => t.toLowerCase())
      // Match only if a precedent token contains a taxonomy tag (not bidirectional)
      // This prevents short tokens like "lr" from matching everything
      const hasMatch = familyTags.some(tag =>
        tag.length >= 3 && precedentTokens.some(token => token.includes(tag))
      )
      if (hasMatch) {
        matched.push(familyKey)
      }
    }

    return matched
  }

  formatForAgent(map: CoverageMap): string {
    const lines: string[] = [
      `## Technique Coverage (${map.coveragePct.toFixed(0)}% explored)`,
    ]

    if (map.unexplored.length > 0) {
      lines.push('### Unexplored — try these!')
      for (const u of map.unexplored) {
        lines.push(`- ${u.family} (${u.category}): ${u.description}`)
      }
    }

    if (map.explored.length > 0) {
      lines.push('### Explored')
      for (const e of map.explored) {
        lines.push(
          `- ${e.family} (${e.category}): ${e.trialCount} trial${e.trialCount !== 1 ? 's' : ''} (${e.outcomes.positive} positive, ${e.outcomes.negative} negative)`
        )
      }
    }

    return lines.join('\n')
  }

  getExplorationTargets(map: CoverageMap, limit = 3): string[] {
    // Unexplored first, then least-explored
    const targets = map.unexplored.map(u => u.family)
    if (targets.length >= limit) return targets.slice(0, limit)

    // Add least-explored families
    const sortedExplored = [...map.explored].sort((a, b) => a.trialCount - b.trialCount)
    for (const e of sortedExplored) {
      if (targets.length >= limit) break
      targets.push(e.family)
    }

    return targets.slice(0, limit)
  }
}
