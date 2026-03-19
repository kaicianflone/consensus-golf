export interface ScanResult {
  safe: boolean
  blockedPatterns: string[]
}

const DENY_PATTERNS = [
  'subprocess', 'socket', 'urllib', 'requests', 'http.client', 'ftplib',
  'shutil.rmtree', 'os.remove', 'os.unlink', 'os.rmdir',
  'eval(', 'exec(', 'compile(', '__import__',
]

function stripStringLiterals(line: string): string {
  return line
    .replace(/"[^"]*"/g, '""')
    .replace(/'[^']*'/g, "''")
}

export function scanDiff(baseline: string, modified: string): ScanResult {
  const baselineLines = new Set(baseline.split('\n').map(l => l.trim()))
  const modifiedLines = modified.split('\n')

  const blockedPatterns: string[] = []

  for (const line of modifiedLines) {
    const trimmed = line.trim()

    // Skip lines that already exist in baseline
    if (baselineLines.has(trimmed)) continue

    // Skip comment lines
    if (trimmed.startsWith('#')) continue

    const stripped = stripStringLiterals(trimmed)

    for (const pattern of DENY_PATTERNS) {
      if (stripped.includes(pattern) && !blockedPatterns.includes(pattern)) {
        blockedPatterns.push(pattern)
      }
    }
  }

  return {
    safe: blockedPatterns.length === 0,
    blockedPatterns,
  }
}
