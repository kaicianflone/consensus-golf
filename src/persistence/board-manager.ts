import path from 'node:path'
import { readAtomicJson, writeAtomicJson } from './atomic-json.js'
import { BoardSchema, type Board } from '../schema/board.js'

export class BoardManager {
  constructor(private readonly boardsDir: string) {}

  filePath(boardId: string): string {
    return path.join(this.boardsDir, boardId + '.json')
  }

  load(boardId: string): Board | null {
    const raw = readAtomicJson<unknown>(this.filePath(boardId))
    if (raw === null) return null
    return BoardSchema.parse(raw)
  }

  loadOrCreate(
    boardId: string,
    defaults: { baselineValBpb: number; baselineArtifactBytes: number; commitRef: string },
  ): Board {
    const existing = this.load(boardId)
    if (existing !== null) return existing

    const board: Board = {
      id: boardId,
      name: boardId,
      description: '',
      baseline: {
        valBpb: defaults.baselineValBpb,
        artifactBytes: defaults.baselineArtifactBytes,
        commitRef: defaults.commitRef,
      },
      currentBest: {
        valBpb: defaults.baselineValBpb,
        artifactBytes: defaults.baselineArtifactBytes,
        commitRef: defaults.commitRef,
        proposalId: '',
      },
      activeCycle: 0,
      status: 'active',
    }

    this.save(board)
    return board
  }

  save(board: Board): void {
    writeAtomicJson(this.filePath(board.id), board)
  }

  updateBest(boardId: string, best: Board['currentBest']): Board {
    const board = this.load(boardId)
    if (board === null) throw new Error(`Board not found: ${boardId}`)
    board.currentBest = best
    this.save(board)
    return board
  }

  incrementCycle(boardId: string): number {
    const board = this.load(boardId)
    if (board === null) throw new Error(`Board not found: ${boardId}`)
    board.activeCycle += 1
    this.save(board)
    return board.activeCycle
  }
}
