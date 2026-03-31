import * as fs from 'fs'
import * as path from 'path'
import { writeAtomicJson, readAtomicJson } from './atomic-json.js'
import type { StepLoss } from '../runner/metrics-parser.js'
import type { LossCurveSignal } from '../runner/loss-curve-analyzer.js'

export interface BaselineCurve {
  boardId: string
  capturedAt: string
  config: { iterations: number; batchTokens: number }
  stepLosses: StepLoss[]
  signal: LossCurveSignal
  tier?: number
  valBpb?: number
}

export class BaselineManager {
  constructor(private readonly dir: string) {}

  private filePath(boardId: string): string {
    return path.join(this.dir, `${boardId}-baseline.json`)
  }

  exists(boardId: string): boolean {
    return fs.existsSync(this.filePath(boardId))
  }

  load(boardId: string): BaselineCurve | null {
    return readAtomicJson<BaselineCurve>(this.filePath(boardId))
  }

  save(curve: BaselineCurve): void {
    writeAtomicJson(this.filePath(curve.boardId), curve)
  }

  private tierFilePath(boardId: string, tier: number): string {
    return path.join(this.dir, `${boardId}-baseline-tier${tier}.json`)
  }

  existsForTier(boardId: string, tier: number): boolean {
    return fs.existsSync(this.tierFilePath(boardId, tier))
  }

  loadForTier(boardId: string, tier: number): BaselineCurve | null {
    return readAtomicJson<BaselineCurve>(this.tierFilePath(boardId, tier))
  }

  saveForTier(curve: BaselineCurve & { tier: number }): void {
    writeAtomicJson(this.tierFilePath(curve.boardId, curve.tier), curve)
  }

  isStale(boardId: string, currentConfig: { iterations: number; batchTokens: number }): boolean {
    const existing = this.load(boardId)
    if (!existing) return true
    return (
      existing.config.iterations !== currentConfig.iterations ||
      existing.config.batchTokens !== currentConfig.batchTokens
    )
  }
}
