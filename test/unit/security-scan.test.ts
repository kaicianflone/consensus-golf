import { describe, it, expect } from 'vitest'
import { scanDiff } from '../../src/runner/security-scan.js'

const BASELINE = `import os
import math
import mlx
vocab_size = int(os.environ.get("VOCAB_SIZE", 1024))
model = GPT(vocab_size)
`

describe('scanDiff', () => {
  it('allows modifications that do not add dangerous patterns', () => {
    const modified = `import os
import math
import mlx
vocab_size = 512
model = GPT(vocab_size)
`
    const result = scanDiff(BASELINE, modified)
    expect(result.safe).toBe(true)
    expect(result.blockedPatterns).toHaveLength(0)
  })

  it('blocks added subprocess import', () => {
    const modified = BASELINE + 'import subprocess\n'
    const result = scanDiff(BASELINE, modified)
    expect(result.safe).toBe(false)
    expect(result.blockedPatterns).toContain('subprocess')
  })

  it('blocks added eval call', () => {
    const modified = BASELINE + 'result = eval("1 + 1")\n'
    const result = scanDiff(BASELINE, modified)
    expect(result.safe).toBe(false)
    expect(result.blockedPatterns).toContain('eval(')
  })

  it('does NOT block baseline import os (identical source)', () => {
    const result = scanDiff(BASELINE, BASELINE)
    expect(result.safe).toBe(true)
    expect(result.blockedPatterns).toHaveLength(0)
  })

  it('blocks added socket usage', () => {
    const modified = BASELINE + 'import socket\n'
    const result = scanDiff(BASELINE, modified)
    expect(result.safe).toBe(false)
    expect(result.blockedPatterns).toContain('socket')
  })

  it('does not flag os in string literals on new lines', () => {
    const modified = BASELINE + 'model_name = "gpt-os-test"\n'
    const result = scanDiff(BASELINE, modified)
    expect(result.safe).toBe(true)
    expect(result.blockedPatterns).toHaveLength(0)
  })
})
