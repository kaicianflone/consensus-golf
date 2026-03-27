import type { TaxonomyData } from '../memory/technique-coverage.js'

export function getExplorerForCycle(cycleNumber: number, agentCount: number): number {
  return cycleNumber % agentCount
}

export function buildExplorationDirective(
  targets: string[],
  taxonomy: TaxonomyData,
): string {
  const lines: string[] = [
    '## EXPLORATION MODE (ACTIVE)',
    'You are in exploration mode this cycle. You MUST propose an experiment targeting',
    'one of these underexplored technique families:',
    '',
  ]

  for (const target of targets) {
    const family = taxonomy.families[target]
    if (family) {
      lines.push(`- **${target}** (${family.category}): ${family.description}`)
    } else {
      lines.push(`- **${target}**: (no description available)`)
    }
  }

  lines.push('')
  lines.push('Do NOT propose changes similar to recent experiments. Prioritize novelty.')
  lines.push('Your proposal will be evaluated on whether it explores NEW territory.')

  return lines.join('\n')
}
