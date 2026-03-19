import { spawn } from 'child_process'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { scanDiff, type ScanResult } from '../runner/security-scan.js'

export interface ComplianceResult {
  syntaxValid: boolean
  syntaxError?: string
  securityScan: ScanResult
}

function runPyCompile(filePath: string): Promise<{ valid: boolean; error?: string }> {
  return new Promise((resolve) => {
    const proc = spawn('python3', ['-m', 'py_compile', filePath])

    let stderr = ''
    proc.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString()
    })

    const timer = setTimeout(() => {
      proc.kill()
      resolve({ valid: false, error: 'py_compile timed out after 10s' })
    }, 10_000)

    proc.on('close', (code) => {
      clearTimeout(timer)
      if (code === 0) {
        resolve({ valid: true })
      } else {
        resolve({ valid: false, error: stderr.trim() || `py_compile exited with code ${code}` })
      }
    })

    proc.on('error', (err) => {
      clearTimeout(timer)
      resolve({ valid: false, error: err.message })
    })
  })
}

export async function checkCompliance(
  modifiedSource: string,
  baselineSource: string,
): Promise<ComplianceResult> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'compliance-'))
  const tmpFile = path.join(tmpDir, 'candidate.py')

  try {
    fs.writeFileSync(tmpFile, modifiedSource, 'utf8')

    const pyResult = await runPyCompile(tmpFile)
    const securityScan = scanDiff(baselineSource, modifiedSource)

    const result: ComplianceResult = {
      syntaxValid: pyResult.valid,
      securityScan,
    }

    if (!pyResult.valid && pyResult.error) {
      result.syntaxError = pyResult.error
    }

    return result
  } finally {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    } catch {
      // best-effort cleanup
    }
  }
}
