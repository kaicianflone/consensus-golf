const GREEN = '\x1b[32m', RED = '\x1b[31m', DIM = '\x1b[2m', RESET = '\x1b[0m', BOLD = '\x1b[1m'

export function formatMetricDelta(candidate: number, baseline: number): string {
  const delta = candidate - baseline
  let color: string
  if (delta < 0) {
    color = GREEN
  } else if (delta > 0) {
    color = RED
  } else {
    color = DIM
  }
  const sign = delta >= 0 ? '+' : ''
  return `${color}${sign}${delta.toFixed(4)}${RESET}`
}

export function formatReputationLine(
  agentId: string,
  score: number,
  delta: number,
  sparkline: string
): string {
  const paddedId = agentId.padEnd(6)
  const sign = delta >= 0 ? '+' : ''
  return `  ${paddedId}  ${score} (${sign}${delta}) ${sparkline}`
}

export class ProgressReporter {
  indent: number = 0

  private pad(): string {
    return '  '.repeat(this.indent)
  }

  pushIndent(): void {
    this.indent++
  }

  popIndent(): void {
    if (this.indent > 0) this.indent--
  }

  phase(msg: string): void {
    console.log(`${this.pad()}${BOLD}${msg}${RESET}`)
  }

  agent(tag: string, msg: string): void {
    const paddedTag = `[${tag}]`.padEnd(8)
    console.log(`${'  '.repeat(this.indent + 1)}${paddedTag} ${msg}`)
  }

  agentResult(tag: string, msg: string, isGood: boolean): void {
    const paddedTag = `[${tag}]`.padEnd(8)
    const color = isGood ? GREEN : RED
    console.log(`${'  '.repeat(this.indent + 1)}${color}${paddedTag} ${msg}${RESET}`)
  }

  metric(label: string, value: number, baseline: number): void {
    const delta = formatMetricDelta(value, baseline)
    console.log(`${'  '.repeat(this.indent + 2)}${label}: ${value} (${delta})`)
  }

  reputation(agents: { agentId: string; score: number; delta: number; sparkline: string }[]): void {
    const parts = agents.map(a => formatReputationLine(a.agentId, a.score, a.delta, a.sparkline))
    console.log(parts.join(' |'))
  }

  lineage(title: string, refs: { outcome: string; summary: string }[]): void {
    console.log(`${this.pad()}${title}`)
    if (refs.length === 0) {
      console.log(`${this.pad()}  (no prior precedent)`)
      return
    }
    for (const ref of refs) {
      const label = ref.outcome === 'positive' || ref.outcome === 'pos' ? '[POS]' : '[NEG]'
      console.log(`${this.pad()}  ${label} ${ref.summary}`)
    }
  }

  progress(tag: string, current: number, total: number): void {
    const width = 10
    const pct = total > 0 ? current / total : 0
    const filled = Math.floor(pct * width)
    const bar = '='.repeat(Math.max(0, filled - 1)) + (filled > 0 ? '>' : '') + ' '.repeat(width - filled)
    const pctStr = Math.round(pct * 100)
    const line = `[${bar}] ${current}/${total} (${pctStr}%)`
    if (current >= total) {
      process.stdout.write(`\r${tag} ${line}\n`)
    } else {
      process.stdout.write(`\r${tag} ${line}`)
    }
  }

  blank(): void {
    console.log()
  }
}
