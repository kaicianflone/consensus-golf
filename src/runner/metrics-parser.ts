export interface ParsedMetrics {
  trainLoss?: number
  valLoss?: number
  valBpb?: number
  artifactBytes?: number
  wallclockSec?: number
  stoppedEarly?: string
  lastStep?: number
  totalSteps?: number
}

export function parseMetrics(stdout: string): ParsedMetrics {
  const metrics: ParsedMetrics = {}

  // 1. Try final_int8_zlib_roundtrip_exact first (most accurate)
  const exactMatch = stdout.match(
    /final_int8_zlib_roundtrip_exact val_loss:([\d.]+) val_bpb:([\d.]+)/
  )
  if (exactMatch) {
    metrics.valLoss = parseFloat(exactMatch[1])
    metrics.valBpb = parseFloat(exactMatch[2])
  } else {
    // 2. Fall back to final_int8_zlib_roundtrip
    const roundtripMatch = stdout.match(
      /final_int8_zlib_roundtrip val_loss:([\d.]+) val_bpb:([\d.]+)/
    )
    if (roundtripMatch) {
      metrics.valLoss = parseFloat(roundtripMatch[1])
      metrics.valBpb = parseFloat(roundtripMatch[2])
    } else {
      // 3. Fall back to last step-level val metrics
      const stepValRegex = /step:\d+\/\d+ val_loss:([\d.]+) val_bpb:([\d.]+)/g
      let stepValMatch: RegExpExecArray | null
      let lastStepVal: RegExpExecArray | null = null
      while ((stepValMatch = stepValRegex.exec(stdout)) !== null) {
        lastStepVal = stepValMatch
      }
      if (lastStepVal) {
        metrics.valLoss = parseFloat(lastStepVal[1])
        metrics.valBpb = parseFloat(lastStepVal[2])
      }
    }
  }

  // 4. Last train_loss (skip if 'nan')
  const trainLossRegex = /train_loss:([\d.]+|nan)/gi
  let trainLossMatch: RegExpExecArray | null
  let lastTrainLoss: string | null = null
  while ((trainLossMatch = trainLossRegex.exec(stdout)) !== null) {
    lastTrainLoss = trainLossMatch[1]
  }
  if (lastTrainLoss !== null && lastTrainLoss.toLowerCase() !== 'nan') {
    metrics.trainLoss = parseFloat(lastTrainLoss)
  }

  // 5. Artifact size
  const artifactMatch = stdout.match(
    /Total submission size int8\+zlib:\s*(\d+)\s*bytes/
  )
  if (artifactMatch) {
    metrics.artifactBytes = parseInt(artifactMatch[1], 10)
  }

  // 6. Stopping reason
  const stoppingMatch = stdout.match(/stopping_early:\s*(\w+)/)
  if (stoppingMatch) {
    metrics.stoppedEarly = stoppingMatch[1]
  }

  // 7. Last step/total
  const stepRegex = /step:(\d+)\/(\d+)/g
  let stepMatch: RegExpExecArray | null
  let lastStep: RegExpExecArray | null = null
  while ((stepMatch = stepRegex.exec(stdout)) !== null) {
    lastStep = stepMatch
  }
  if (lastStep) {
    metrics.lastStep = parseInt(lastStep[1], 10)
    metrics.totalSteps = parseInt(lastStep[2], 10)
  }

  // 8. Wallclock from last train_time (convert ms to seconds)
  const trainTimeRegex = /train_time:(\d+)ms/g
  let trainTimeMatch: RegExpExecArray | null
  let lastTrainTime: RegExpExecArray | null = null
  while ((trainTimeMatch = trainTimeRegex.exec(stdout)) !== null) {
    lastTrainTime = trainTimeMatch
  }
  if (lastTrainTime) {
    metrics.wallclockSec = parseInt(lastTrainTime[1], 10) / 1000
  }

  return metrics
}

export function detectNaN(stdout: string): boolean {
  return /train_loss:nan/i.test(stdout)
}
