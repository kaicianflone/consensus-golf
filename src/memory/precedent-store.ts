import { appendJsonl, readJsonl } from '../persistence/jsonl.js'
import type { Precedent } from '../schema/precedent.js'

export class PrecedentStore {
  constructor(private readonly filePath: string) {}

  append(precedent: Precedent): void {
    appendJsonl(this.filePath, precedent)
  }

  readAll(): Precedent[] {
    return readJsonl<Precedent>(this.filePath)
  }

  readFiltered(filter: { family?: string; outcome?: string }): Precedent[] {
    return this.readAll().filter(p => {
      if (filter.family !== undefined && p.family !== filter.family) return false
      if (filter.outcome !== undefined && p.outcome !== filter.outcome) return false
      return true
    })
  }

  readLast(n: number): Precedent[] {
    const all = this.readAll()
    return all.slice(Math.max(0, all.length - n))
  }

  readForAgent(agentCategory: string, limit = 20): Precedent[] {
    const all = this.readAll()
    const filtered = all.filter(
      p => p.category === agentCategory || p.tags.includes('general'),
    )
    return filtered.slice(Math.max(0, filtered.length - limit))
  }
}
