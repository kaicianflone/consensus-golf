import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { BoardManager } from '../../src/persistence/board-manager.js'

let tmpDir: string
let manager: BoardManager

const DEFAULTS = {
  baselineValBpb: 1.23,
  baselineArtifactBytes: 100000,
  commitRef: 'abc123',
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'board-manager-test-'))
  manager = new BoardManager(tmpDir)
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

describe('BoardManager', () => {
  it('creates a default board if none exists', () => {
    const board = manager.loadOrCreate('test-board', DEFAULTS)

    expect(board.id).toBe('test-board')
    expect(board.name).toBe('test-board')
    expect(board.description).toBe('')
    expect(board.baseline).toEqual({
      valBpb: DEFAULTS.baselineValBpb,
      artifactBytes: DEFAULTS.baselineArtifactBytes,
      commitRef: DEFAULTS.commitRef,
    })
    expect(board.currentBest).toEqual({
      valBpb: DEFAULTS.baselineValBpb,
      artifactBytes: DEFAULTS.baselineArtifactBytes,
      commitRef: DEFAULTS.commitRef,
      proposalId: '',
    })
    expect(board.activeCycle).toBe(0)
    expect(board.status).toBe('active')
  })

  it('loads an existing board on second call', () => {
    manager.loadOrCreate('test-board', DEFAULTS)

    // Modify persisted board to confirm it's loaded (not re-created)
    const filePath = manager.filePath('test-board')
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'))
    raw.activeCycle = 5
    fs.writeFileSync(filePath, JSON.stringify(raw, null, 2), 'utf8')

    const loaded = manager.loadOrCreate('test-board', DEFAULTS)
    expect(loaded.activeCycle).toBe(5)
  })

  it('updates currentBest', () => {
    manager.loadOrCreate('test-board', DEFAULTS)

    const newBest = {
      valBpb: 0.99,
      artifactBytes: 80000,
      commitRef: 'def456',
      proposalId: 'proposal-1',
    }
    const updated = manager.updateBest('test-board', newBest)

    expect(updated.currentBest).toEqual(newBest)

    // Verify persisted
    const reloaded = manager.load('test-board')
    expect(reloaded?.currentBest).toEqual(newBest)
  })

  it('increments activeCycle', () => {
    manager.loadOrCreate('test-board', DEFAULTS)

    const cycle1 = manager.incrementCycle('test-board')
    expect(cycle1).toBe(1)

    const cycle2 = manager.incrementCycle('test-board')
    expect(cycle2).toBe(2)

    // Verify persisted
    const reloaded = manager.load('test-board')
    expect(reloaded?.activeCycle).toBe(2)
  })
})
