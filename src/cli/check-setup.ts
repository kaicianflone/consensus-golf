import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { PgolfConfigSchema } from '../schema/config.js'

const GREEN = '\x1b[32m'
const RED = '\x1b[31m'
const RESET = '\x1b[0m'

function pass(label: string): void {
  console.log(`  ${GREEN}PASS${RESET}  ${label}`)
}

function fail(label: string, detail?: string): void {
  const suffix = detail !== undefined ? ` (${detail})` : ''
  console.log(`  ${RED}FAIL${RESET}  ${label}${suffix}`)
}

function checkPython3(): boolean {
  const result = spawnSync('python3', ['--version'], { encoding: 'utf8' })
  if (result.status === 0) {
    pass(`Python 3 installed: ${(result.stdout || result.stderr).trim()}`)
    return true
  }
  fail('Python 3 installed', 'python3 not found')
  return false
}

function checkMlx(): boolean {
  const result = spawnSync('python3', ['-c', 'import mlx'], { encoding: 'utf8' })
  if (result.status === 0) {
    pass('MLX importable')
    return true
  }
  fail('MLX importable', 'import mlx failed')
  return false
}

function checkConfigFiles(): boolean {
  const configs = ['config/agents.json', 'config/default-policy.json', 'config/pgolf.json']
  const missing = configs.filter((c) => !fs.existsSync(c))
  if (missing.length === 0) {
    pass('Config files exist')
    return true
  }
  fail('Config files exist', `missing: ${missing.join(', ')}`)
  return false
}

function loadPgolfConfig(): ReturnType<typeof PgolfConfigSchema.parse> | null {
  try {
    const raw = JSON.parse(fs.readFileSync('config/pgolf.json', 'utf8'))
    return PgolfConfigSchema.parse(raw)
  } catch {
    return null
  }
}

function checkParameterGolfRepo(repoPath: string): boolean {
  if (fs.existsSync(repoPath)) {
    pass(`Parameter-golf repo exists: ${repoPath}`)
    return true
  }
  fail('Parameter-golf repo exists', `not found at ${repoPath}`)
  return false
}

function checkTrainingScript(repoPath: string, trainScript: string): boolean {
  const scriptPath = path.join(repoPath, trainScript)
  if (fs.existsSync(scriptPath)) {
    pass(`Training script exists: ${scriptPath}`)
    return true
  }
  fail('Training script exists', `not found at ${scriptPath}`)
  return false
}

function checkTrainingData(dataPath: string): boolean {
  if (fs.existsSync(dataPath)) {
    pass(`Training data exists: ${dataPath}`)
    return true
  }
  fail('Training data exists', `not found at ${dataPath}`)
  return false
}

function checkTokenizer(tokenizerPath: string): boolean {
  if (fs.existsSync(tokenizerPath)) {
    pass(`Tokenizer exists: ${tokenizerPath}`)
    return true
  }
  fail('Tokenizer exists', `not found at ${tokenizerPath}`)
  return false
}

function checkAnthropicApiKey(): boolean {
  if (process.env.ANTHROPIC_API_KEY !== undefined && process.env.ANTHROPIC_API_KEY.length > 0) {
    pass('ANTHROPIC_API_KEY set')
    return true
  }
  fail('ANTHROPIC_API_KEY set', 'environment variable not set')
  return false
}

function main(): void {
  console.log('Checking setup...\n')

  const results: boolean[] = []

  results.push(checkPython3())
  results.push(checkMlx())
  results.push(checkConfigFiles())

  const pgolfConfig = loadPgolfConfig()
  if (pgolfConfig !== null) {
    results.push(checkParameterGolfRepo(pgolfConfig.repoPath))
    results.push(checkTrainingScript(pgolfConfig.repoPath, pgolfConfig.trainScript))
    results.push(checkTrainingData(pgolfConfig.dataPath))
    results.push(checkTokenizer(pgolfConfig.tokenizerPath))
  } else {
    fail('Parameter-golf repo exists', 'could not load pgolf config')
    fail('Training script exists', 'could not load pgolf config')
    fail('Training data exists', 'could not load pgolf config')
    fail('Tokenizer exists', 'could not load pgolf config')
    results.push(false, false, false, false)
  }

  results.push(checkAnthropicApiKey())

  console.log()
  const allPassed = results.every(Boolean)
  if (allPassed) {
    console.log(`${GREEN}All checks passed.${RESET}`)
  } else {
    const failCount = results.filter((r) => !r).length
    console.log(`${RED}${failCount} check(s) failed.${RESET}`)
    process.exit(1)
  }
}

main()
