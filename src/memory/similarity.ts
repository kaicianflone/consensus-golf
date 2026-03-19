import type { Precedent } from '../schema/precedent.js'

export function isSameFamily(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase()
}

export function familyOverlap(precedents: Precedent[], family: string): Precedent[] {
  return precedents.filter(p => isSameFamily(p.family, family))
}
