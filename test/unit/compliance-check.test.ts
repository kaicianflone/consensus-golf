import { describe, it, expect } from 'vitest'
import { checkCompliance } from '../../src/judges/compliance-check.js'

describe('checkCompliance', () => {
  it('passes valid Python source', async () => {
    const source = 'x = 1\nprint(x)\n'
    const result = await checkCompliance(source, source)
    expect(result.syntaxValid).toBe(true)
    expect(result.syntaxError).toBeUndefined()
    expect(result.securityScan.safe).toBe(true)
  })

  it('fails on syntax error', async () => {
    const source = 'def foo(\n'
    const result = await checkCompliance(source, source)
    expect(result.syntaxValid).toBe(false)
    expect(result.syntaxError).toBeDefined()
    expect(typeof result.syntaxError).toBe('string')
    expect(result.syntaxError!.length).toBeGreaterThan(0)
  })

  it('fails on added dangerous import', async () => {
    const baseline = 'import math\nx = math.sqrt(4)\n'
    const modified = 'import math\nimport subprocess\nx = math.sqrt(4)\n'
    const result = await checkCompliance(modified, baseline)
    expect(result.syntaxValid).toBe(true)
    expect(result.securityScan.safe).toBe(false)
    expect(result.securityScan.blockedPatterns).toContain('subprocess')
  })
})
