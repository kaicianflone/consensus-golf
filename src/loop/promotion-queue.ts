import * as fs from 'fs'
import * as path from 'path'
import type { Proposal } from '../schema/proposal.js'

interface QueueEntry {
  proposal: Proposal
  sourceTier: number
  targetTier: number
  queuedAt: string
  cycleNum: number
  relativeDescentRate?: number
  valBpb?: number
}

/**
 * Persists Tier 1 winners across cycles so they can be retried on GPU
 * when availability returns. Prevents losing good proposals to transient
 * supply constraints.
 */
export class PromotionQueue {
  private readonly filePath: string

  constructor(dataDir: string, boardId: string) {
    this.filePath = path.join(dataDir, `${boardId}-promotion-queue.json`)
  }

  /** Get all queued proposals for a target tier */
  getForTier(targetTier: number): QueueEntry[] {
    const all = this.readAll()
    return all.filter(e => e.targetTier === targetTier)
  }

  /** Add proposals to the queue */
  enqueue(entries: QueueEntry[]): void {
    const all = this.readAll()
    all.push(...entries)
    // Cap at 20 entries per tier to prevent unbounded growth
    const capped = this.capPerTier(all, 20)
    this.write(capped)
  }

  /** Remove proposals that have been executed (pass or fail) */
  dequeue(proposalIds: string[]): void {
    const idSet = new Set(proposalIds)
    const all = this.readAll()
    const remaining = all.filter(e => !idSet.has(e.proposal.id))
    this.write(remaining)
  }

  /** Get queue size per tier */
  size(): Record<number, number> {
    const all = this.readAll()
    const counts: Record<number, number> = {}
    for (const entry of all) {
      counts[entry.targetTier] = (counts[entry.targetTier] ?? 0) + 1
    }
    return counts
  }

  private readAll(): QueueEntry[] {
    try {
      const raw = fs.readFileSync(this.filePath, 'utf-8')
      return JSON.parse(raw)
    } catch {
      return []
    }
  }

  private write(entries: QueueEntry[]): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true })
    fs.writeFileSync(this.filePath, JSON.stringify(entries, null, 2))
  }

  private capPerTier(entries: QueueEntry[], maxPerTier: number): QueueEntry[] {
    const byTier = new Map<number, QueueEntry[]>()
    for (const e of entries) {
      const list = byTier.get(e.targetTier) ?? []
      list.push(e)
      byTier.set(e.targetTier, list)
    }
    const result: QueueEntry[] = []
    for (const [, list] of byTier) {
      // Keep newest entries
      result.push(...list.slice(-maxPerTier))
    }
    return result
  }
}

export type { QueueEntry }
