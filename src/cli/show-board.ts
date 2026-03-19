import { BoardManager } from '../persistence/board-manager.js'

const GREEN = '\x1b[32m'
const RED = '\x1b[31m'
const BOLD = '\x1b[1m'
const DIM = '\x1b[2m'
const RESET = '\x1b[0m'

function parseArgs(): { boardId: string } {
  const argv = process.argv.slice(2)
  let boardId = 'pgolf-main'

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--board' && argv[i + 1] !== undefined) {
      boardId = argv[++i]
    }
  }

  return { boardId }
}

function main(): void {
  const { boardId } = parseArgs()
  const boardManager = new BoardManager('data/boards')
  const board = boardManager.load(boardId)

  if (board === null) {
    console.error(`Board not found: ${boardId}`)
    process.exit(1)
  }

  console.log(`${BOLD}Board:${RESET} ${board.name}`)
  console.log(`${BOLD}Status:${RESET} ${board.status}`)
  console.log(`${BOLD}Active Cycle:${RESET} ${board.activeCycle}`)
  console.log()

  console.log(`${BOLD}Baseline:${RESET}`)
  console.log(`  val_bpb:        ${board.baseline.valBpb}`)
  console.log(`  artifact bytes: ${board.baseline.artifactBytes}`)
  console.log()

  console.log(`${BOLD}Current Best:${RESET}`)
  console.log(`  val_bpb:        ${board.currentBest.valBpb}`)
  console.log(`  artifact bytes: ${board.currentBest.artifactBytes}`)
  if (board.currentBest.proposalId !== '') {
    console.log(`  proposal ID:    ${board.currentBest.proposalId}`)
  }

  const bpbDelta = board.currentBest.valBpb - board.baseline.valBpb
  const bytesDelta = board.currentBest.artifactBytes - board.baseline.artifactBytes

  if (bpbDelta !== 0 || bytesDelta !== 0) {
    console.log()
    console.log(`${BOLD}Delta from Baseline:${RESET}`)

    const bpbSign = bpbDelta >= 0 ? '+' : ''
    const bpbColor = bpbDelta < 0 ? GREEN : bpbDelta > 0 ? RED : DIM
    console.log(`  val_bpb:        ${bpbColor}${bpbSign}${bpbDelta.toFixed(4)}${RESET}`)

    const bytesSign = bytesDelta >= 0 ? '+' : ''
    const bytesColor = bytesDelta < 0 ? GREEN : bytesDelta > 0 ? RED : DIM
    console.log(`  artifact bytes: ${bytesColor}${bytesSign}${bytesDelta}${RESET}`)
  }
}

main()
