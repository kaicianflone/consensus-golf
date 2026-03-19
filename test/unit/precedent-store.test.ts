import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { PrecedentStore } from '../../src/memory/precedent-store.js'

const makePrecedent = (id: string, family: string, outcome: 'positive' | 'negative' | 'invalid' | 'uncertain') => ({
  id,
  sourceProposalId: 'p1',
  category: 'architecture',
  family,
  summary: `Test ${id}`,
  outcome,
  metrics: { baselineValBpb: 1.2244 },
  tags: [family],
  createdAt: new Date().toISOString(),
})

let tmpDir: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'precedent-store-test-'))
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

describe('PrecedentStore', () => {
  it('appends and reads precedents', () => {
    const store = new PrecedentStore(path.join(tmpDir, 'precedents.jsonl'))
    store.append(makePrecedent('1', 'familyA', 'positive'))
    store.append(makePrecedent('2', 'familyB', 'negative'))

    const all = store.readAll()
    expect(all).toHaveLength(2)
    expect(all[0].id).toBe('1')
    expect(all[1].id).toBe('2')
  })

  it('filters by family', () => {
    const store = new PrecedentStore(path.join(tmpDir, 'precedents.jsonl'))
    store.append(makePrecedent('1', 'familyA', 'positive'))
    store.append(makePrecedent('2', 'familyB', 'negative'))

    const filtered = store.readFiltered({ family: 'familyA' })
    expect(filtered).toHaveLength(1)
    expect(filtered[0].id).toBe('1')
  })

  it('filters by outcome', () => {
    const store = new PrecedentStore(path.join(tmpDir, 'precedents.jsonl'))
    store.append(makePrecedent('1', 'familyA', 'positive'))
    store.append(makePrecedent('2', 'familyB', 'negative'))

    const filtered = store.readFiltered({ outcome: 'negative' })
    expect(filtered).toHaveLength(1)
    expect(filtered[0].id).toBe('2')
  })

  it('returns last N precedents', () => {
    const store = new PrecedentStore(path.join(tmpDir, 'precedents.jsonl'))
    store.append(makePrecedent('1', 'familyA', 'positive'))
    store.append(makePrecedent('2', 'familyB', 'negative'))
    store.append(makePrecedent('3', 'familyC', 'uncertain'))

    const last2 = store.readLast(2)
    expect(last2).toHaveLength(2)
    expect(last2[0].id).toBe('2')
    expect(last2[1].id).toBe('3')
  })

  it('returns empty array when file does not exist', () => {
    const store = new PrecedentStore(path.join(tmpDir, 'nonexistent.jsonl'))
    expect(store.readAll()).toEqual([])
  })
})
