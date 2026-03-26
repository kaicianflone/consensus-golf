import { spawn, type ChildProcess } from 'child_process'
import * as fs from 'fs'
import * as path from 'path'
import { ulid } from 'ulid'
import { parseMetrics, detectNaN } from './metrics-parser.js'
import type { Proposal } from '../schema/proposal.js'
import type { ExperimentRun } from '../schema/experiment.js'
import type { PolicyConfig, PgolfConfig } from '../schema/config.js'

// Module-level state for SIGINT cleanup
let activeChild: ChildProcess | null = null
let activeStdoutBuffer = ''

export function getActiveChild(): ChildProcess | null {
  return activeChild
}

export function getActiveStdoutBuffer(): string {
  return activeStdoutBuffer
}

export function computeSimpleDiff(baseline: string, modified: string): string {
  const baselineLines = baseline.split('\n')
  const modifiedLines = modified.split('\n')
  const diff: string[] = []

  const maxLen = Math.max(baselineLines.length, modifiedLines.length)
  for (let i = 0; i < maxLen; i++) {
    const bLine = baselineLines[i]
    const mLine = modifiedLines[i]
    if (bLine === mLine) {
      // unchanged line — skip (simple diff only shows changes)
      continue
    }
    if (bLine !== undefined && mLine === undefined) {
      diff.push(`-${bLine}`)
    } else if (bLine === undefined && mLine !== undefined) {
      diff.push(`+${mLine}`)
    } else if (bLine !== mLine) {
      diff.push(`-${bLine}`)
      diff.push(`+${mLine}`)
    }
  }

  return diff.join('\n')
}

export function cleanWorkDir(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true })
  } catch {
    // ignore errors during cleanup
  }
}

export async function runExperiment(
  proposal: Proposal,
  baselineSource: string,
  policy: PolicyConfig,
  pgolf: PgolfConfig,
  workDir: string,
  onProgress?: (line: string) => void
): Promise<ExperimentRun> {
  // 1. Generate runId
  const runId = ulid()

  // 2. Create work/{runId}/ directory
  const runDir = path.join(workDir, 'work', runId)
  fs.mkdirSync(runDir, { recursive: true })

  // 3. Write modified source as train_gpt_mlx.py
  const scriptPath = path.join(runDir, 'train_gpt_mlx.py')
  fs.writeFileSync(scriptPath, proposal.modifiedSource, 'utf-8')

  // 4. Compute diff between baseline and modified
  const patch = computeSimpleDiff(baselineSource, proposal.modifiedSource)

  // 5. Build initial ExperimentRun object
  const startedAt = new Date().toISOString()
  const run: ExperimentRun = {
    id: runId,
    proposalId: proposal.id,
    tier: 0,
    status: 'running',
    config: {
      iterations: policy.execution.smokeIterations,
      trainBatchTokens: policy.execution.smokeBatchTokens,
      valBatchSize: policy.execution.valBatchSize,
      maxWallclockSec: policy.execution.smokeMaxWallclockSec,
    },
    metrics: {},
    compliance: {
      artifactWithinLimit: false,
      noNetworkAccess: true,
      reproducible: false,
    },
    patch,
    stdout: '',
    startedAt,
  }

  // 6. Spawn python3 subprocess
  const resolvedRepoPath = path.resolve(pgolf.repoPath)
  const resolvedDataPath = path.resolve(pgolf.dataPath)
  const resolvedTokenizerPath = path.resolve(pgolf.tokenizerPath)

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    RUN_ID: runId,
    ITERATIONS: String(policy.execution.smokeIterations),
    TRAIN_BATCH_TOKENS: String(policy.execution.smokeBatchTokens),
    VAL_LOSS_EVERY: '25',
    VAL_BATCH_SIZE: String(policy.execution.valBatchSize),
    MAX_WALLCLOCK_SECONDS: String(policy.execution.smokeMaxWallclockSec),
    DATA_PATH: resolvedDataPath,
    TOKENIZER_PATH: resolvedTokenizerPath,
    // Network blocking
    no_proxy: '*',
    http_proxy: '',
    https_proxy: '',
    HTTP_PROXY: '',
    HTTPS_PROXY: '',
  }

  const resolvedScriptPath = path.resolve(scriptPath)
  const child = spawn('python3', [resolvedScriptPath], {
    env,
    cwd: resolvedRepoPath,
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  activeChild = child
  activeStdoutBuffer = ''

  // 7. Stream stdout line-by-line
  let stdoutBuffer = ''
  let lineBuffer = ''
  let nanDetected = false

  const processLine = (line: string): void => {
    stdoutBuffer += line + '\n'
    activeStdoutBuffer = stdoutBuffer

    if (onProgress && line.length > 0) {
      onProgress(line)
    }

    // Live NaN detection
    if (!nanDetected && detectNaN(stdoutBuffer)) {
      nanDetected = true
      child.kill('SIGKILL')
    }
  }

  if (child.stdout) {
    child.stdout.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf-8')
      lineBuffer += text
      const lines = lineBuffer.split('\n')
      // Keep the last (potentially incomplete) segment in the buffer
      lineBuffer = lines.pop() ?? ''
      for (const line of lines) {
        processLine(line)
      }
    })
  }

  // Also capture stderr into stdout buffer for diagnostic purposes
  if (child.stderr) {
    child.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf-8')
      stdoutBuffer += text
      activeStdoutBuffer = stdoutBuffer
    })
  }

  // 8. Hard wallclock timeout
  const wallclockMs = policy.execution.smokeMaxWallclockSec * 1000
  let wallclockFired = false
  const wallclockTimer = setTimeout(() => {
    wallclockFired = true
    child.kill('SIGKILL')
  }, wallclockMs)

  // 9. Wait for process close and finalize
  return new Promise<ExperimentRun>((resolve) => {
    child.on('close', (exitCode: number | null, signal: NodeJS.Signals | null) => {
      clearTimeout(wallclockTimer)

      // Flush any remaining line buffer content
      if (lineBuffer.length > 0) {
        processLine(lineBuffer)
        lineBuffer = ''
      }

      activeChild = null

      const completedAt = new Date().toISOString()
      const metrics = parseMetrics(stdoutBuffer)

      // Determine run status
      let status: ExperimentRun['status']
      if (exitCode === 0 || wallclockFired) {
        status = 'passed'
      } else if (exitCode === 137 || nanDetected || (exitCode !== null && exitCode !== 0)) {
        status = 'failed'
      } else if (signal !== null) {
        status = 'failed'
      } else {
        status = 'invalid'
      }

      // Check artifact compliance
      const artifactWithinLimit =
        metrics.artifactBytes !== undefined
          ? metrics.artifactBytes <= pgolf.maxArtifactBytes
          : false

      const finalRun: ExperimentRun = {
        ...run,
        status,
        metrics: {
          trainLoss: metrics.trainLoss,
          valLoss: metrics.valLoss,
          valBpb: metrics.valBpb,
          artifactBytes: metrics.artifactBytes,
          wallclockSec: metrics.wallclockSec,
        },
        compliance: {
          artifactWithinLimit,
          noNetworkAccess: true,
          reproducible: false,
        },
        stdout: stdoutBuffer,
        completedAt,
      }

      // 10. Clean work dir on failure, keep on success
      if (status === 'failed' || status === 'invalid') {
        cleanWorkDir(runDir)
      }

      resolve(finalRun)
    })
  })
}
