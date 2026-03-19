import { PrecedentStore } from '../memory/precedent-store.js'
import type { Precedent } from '../schema/precedent.js'

const GREEN = '\x1b[32m'
const RED = '\x1b[31m'
const RESET = '\x1b[0m'

function parseArgs(): { last: number; family?: string; outcome?: string } {
  const argv = process.argv.slice(2)
  let last = 20
  let family: string | undefined
  let outcome: string | undefined

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--board' && argv[i + 1] !== undefined) {
      // Accepted for consistency but unused
      i++
    } else if (arg === '--last' && argv[i + 1] !== undefined) {
      last = parseInt(argv[++i], 10)
    } else if (arg === '--family' && argv[i + 1] !== undefined) {
      family = argv[++i]
    } else if (arg === '--outcome' && argv[i + 1] !== undefined) {
      outcome = argv[++i]
    }
  }

  return { last, family, outcome }
}

function formatOutcomeTag(outcome: Precedent['outcome']): string {
  if (outcome === 'positive') {
    return `${GREEN}[POS]${RESET}`
  } else if (outcome === 'negative') {
    return `${RED}[NEG]${RESET}`
  } else if (outcome === 'invalid') {
    return `${RED}[INV]${RESET}`
  }
  return `[UNC]`
}

function main(): void {
  const { last, family, outcome } = parseArgs()
  const store = new PrecedentStore('data/precedents.jsonl')

  let precedents: Precedent[]
  if (family !== undefined || outcome !== undefined) {
    precedents = store.readFiltered({ family, outcome })
    // Still apply the `last` limit
    precedents = precedents.slice(Math.max(0, precedents.length - last))
  } else {
    precedents = store.readLast(last)
  }

  if (precedents.length === 0) {
    console.log('No precedents found.')
    return
  }

  for (const p of precedents) {
    const tag = formatOutcomeTag(p.outcome)
    const deltaStr = p.metrics.delta !== undefined ? ` delta=${p.metrics.delta.toFixed(4)}` : ''
    console.log(`${tag} [${p.family}] ${p.summary}${deltaStr}`)
    console.log(`  id=${p.id}  createdAt=${p.createdAt}`)
  }
}

main()
