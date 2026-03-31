#!/usr/bin/env tsx
/**
 * Run a proposal on RunPod using the Parameter Golf template.
 * No volume needed — template has all deps, data downloads from HF.
 * Usage: tsx src/cli/run-pgolf-template.ts <script-path> [--tier3]
 */
import * as fs from 'fs'
import { RunPodsClient } from '../runner/runpods-client.js'
import { parseMetrics } from '../runner/metrics-parser.js'

const scriptPath = process.argv[2]
const isTier3 = process.argv.includes('--tier3')
if (!scriptPath) { console.error('Usage: tsx src/cli/run-pgolf-template.ts <script>'); process.exit(1) }

const apiKey = process.env.RUNPOD_API_KEY!
const client = new RunPodsClient(apiKey)
const script = fs.readFileSync(scriptPath, 'utf-8')

const gpuCount = isTier3 ? 8 : 1
const gpuType = 'NVIDIA H100 80GB HBM3'
const templateId = 'y5cejece4j' // Parameter Golf official template

async function main() {
  console.log(`Creating ${gpuCount}xH100 pod (PGolf template)...`)
  const podId = await client.createPod(
    { gpuType, gpuCount, templateId, containerImage: '', volumeId: '' },
    `cgolf-pgolf-${isTier3 ? 't3' : 't2'}`,
  )
  console.log(`Pod: ${podId}`)

  try {
    console.log('Waiting for RUNNING...')
    await client.waitForRunning(podId, 300_000) // 5 min for template pull
    console.log('Pod running.')

    // Download sp1024 data using the template's built-in tools
    console.log('Downloading sp1024 dataset...')
    await client.executeCommand(podId, [
      'cd /workspace',
      'git clone --depth 1 https://github.com/openai/parameter-golf.git pgolf 2>&1 | tail -3',
      'cd pgolf',
      'pip install -q huggingface_hub',
      'python3 data/cached_challenge_fineweb.py --variant sp1024 --train-shards 80 2>&1 | tail -5',
      'ls -la data/datasets/fineweb10B_sp1024/',
      'python3 -c "import torch; print(torch.__version__)"',
    ].join(' && '), 600_000)
    console.log('Data ready.')

    // Upload our modified script
    console.log('Uploading proposal...')
    await client.uploadScript(podId, script, '/workspace/pgolf/train_gpt.py')

    // Build command
    const launcher = isTier3
      ? `torchrun --standalone --nproc_per_node=${gpuCount}`
      : 'LOCAL_RANK=0 RANK=0 WORLD_SIZE=1 MASTER_ADDR=localhost MASTER_PORT=29500 python3'

    const cmd = [
      'cd /workspace/pgolf &&',
      'MAX_WALLCLOCK_SECONDS=600',
      'DATA_PATH=./data/datasets/fineweb10B_sp1024/',
      'TOKENIZER_PATH=./data/tokenizers/fineweb_1024_bpe.model',
      'TRAIN_LOG_EVERY=5 VAL_LOSS_EVERY=0',
      `${launcher} train_gpt.py 2>&1`,
    ].join(' ')

    console.log(`Training (${gpuCount}xH100, 600s)...`)
    const stdout = await client.executeCommand(podId, cmd, 900_000)

    const metrics = parseMetrics(stdout)
    console.log('\n=== RESULTS ===')
    console.log(`val_bpb: ${metrics.valBpb}`)
    console.log(`val_loss: ${metrics.valLoss}`)
    console.log(`train_loss: ${metrics.trainLoss}`)
    console.log(`wallclock: ${metrics.wallclockSec}s`)
    console.log(`artifact_bytes: ${metrics.artifactBytes}`)
    console.log(`Baseline val_bpb: 1.2244`)
    if (metrics.valBpb !== undefined) {
      const delta = metrics.valBpb - 1.2244
      console.log(`Delta: ${delta > 0 ? '+' : ''}${delta.toFixed(4)}`)
      console.log(delta < 0 ? 'IMPROVEMENT!' : 'No improvement')
    }

    const lines = stdout.split('\n')
    console.log('\n=== LAST 30 LINES ===')
    console.log(lines.slice(-30).join('\n'))

  } finally {
    console.log(`\nTerminating pod ${podId}...`)
    await client.terminatePod(podId).catch(() => {})
    console.log('Done.')
  }
}

main().catch(e => { console.error('Fatal:', e); process.exit(1) })
