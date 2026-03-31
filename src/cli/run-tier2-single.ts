#!/usr/bin/env tsx
/**
 * Run a single saved proposal on Tier 2 (RunPod GPU).
 * Usage: tsx src/cli/run-tier2-single.ts <work-dir-id>
 */
import * as fs from 'fs'
import * as path from 'path'
import { RunPodsClient } from '../runner/runpods-client.js'
import { parseMetrics } from '../runner/metrics-parser.js'
import { computeSimpleDiff } from '../runner/sandbox.js'

const workId = process.argv[2]
if (!workId) {
  console.error('Usage: tsx src/cli/run-tier2-single.ts <work-dir-id>')
  process.exit(1)
}

// Check for MLX script in work dir, but also allow direct PyTorch script path
let scriptPath = path.resolve(`data/work/work/${workId}/train_gpt_mlx.py`)
if (!fs.existsSync(scriptPath)) {
  scriptPath = path.resolve(workId) // allow passing direct path
}
if (!fs.existsSync(scriptPath)) {
  console.error(`Script not found: ${scriptPath}`)
  process.exit(1)
}

const noVolume = process.argv.includes('--no-volume')
const volumeOverride = process.argv.find(a => a.startsWith('--volume='))?.split('=')[1]

const apiKey = process.env.RUNPOD_API_KEY
if (!apiKey) {
  console.error('RUNPOD_API_KEY not set')
  process.exit(1)
}

// Load config
const policy = JSON.parse(fs.readFileSync('config/default-policy.json', 'utf-8'))
const tier2 = policy.tiers.tier2
const modifiedSource = fs.readFileSync(scriptPath, 'utf-8')
const baselineSource = fs.readFileSync('packages/parameter-golf/train_gpt_mlx.py', 'utf-8')

console.log(`Proposal diff:`)
const patch = computeSimpleDiff(baselineSource, modifiedSource)
console.log(patch || '(no diff)')
console.log()

const client = new RunPodsClient(apiKey)

// GPU fallback chain
const gpuTypes = [
  tier2.gpuType,
  'NVIDIA A100 80GB PCIe',
  'NVIDIA A100-SXM4-80GB',
  'NVIDIA GeForce RTX 4090',
].filter((v, i, a) => a.indexOf(v) === i)

let podId: string | null = null

async function main() {
  try {
    // Create pod
    for (let i = 0; i < gpuTypes.length; i++) {
      try {
        console.log(`Trying GPU: ${gpuTypes[i]}...`)
        podId = await client.createPod(
          {
            gpuType: gpuTypes[i],
            gpuCount: tier2.gpuCount,
            templateId: tier2.templateId,
            containerImage: tier2.containerImage,
            volumeId: noVolume ? '' : (volumeOverride || tier2.volumeId),
            containerDiskInGb: noVolume ? 50 : undefined,
          },
          `cgolf-single-test`,
        )
        console.log(`Pod created on ${gpuTypes[i]}: ${podId}`)
        break
      } catch (err) {
        if (i < gpuTypes.length - 1) {
          console.log(`${gpuTypes[i]} unavailable: ${String(err).slice(0, 100)}`)
          continue
        }
        throw err
      }
    }

    if (!podId) throw new Error('No GPU available')

    console.log('Waiting for RUNNING...')
    await client.waitForRunning(podId, 180_000)
    console.log('Pod running, installing dependencies...')

    await client.executeCommand(
      podId,
      'pip install sentencepiece 2>&1 | tail -2',
      60_000,
    )
    const verCheck = await client.executeCommand(podId,
      'PYTHONPATH=/workspace/site-packages python3 -c "import torch; print(torch.__version__, torch.version.cuda)"',
      30_000)
    console.log('PyTorch version:', verCheck.trim().split('\n').pop())
    console.log('Dependencies ready...')

    if (noVolume) {
      console.log('Setting up dataset on pod (--no-volume mode)...')
      const setupOutput = await client.executeCommand(podId, [
        'cd /workspace',
        'git clone --depth 1 https://github.com/KellerJordan/modded-nanogpt.git pgolf 2>&1 | tail -3',
        'pip install -q huggingface_hub',
        'cd pgolf && python data/cached_fineweb10B.py 0 2>&1',
        'echo "=== FILES ===" && find /workspace/pgolf/data -type f \\( -name "*.bin" -o -name "*.model" -o -name "*.vocab" \\) 2>/dev/null | head -20',
        // Symlink the downloaded data to where the training script expects it
        'mkdir -p /workspace/datasets/datasets /workspace/datasets/tokenizers',
        'ln -sfn /workspace/pgolf/data/fineweb10B /workspace/datasets/datasets/fineweb10B_sp1024',
        'ls -la /workspace/datasets/datasets/fineweb10B_sp1024/',
        `ls -la ${tier2.dataPath}/ && ls -la ${tier2.tokenizerPath}`,
      ].join(' && '), 600_000)
      console.log(setupOutput.slice(-500))
      // Upload tokenizer if not found on pod
      const tokCheck = await client.executeCommand(podId, `[ -f ${tier2.tokenizerPath} ] && echo TOK_EXISTS || echo TOK_MISSING`, 10_000)
      if (tokCheck.includes('TOK_MISSING')) {
        console.log('Uploading tokenizer (250KB)...')
        // Upload binary file via base64 heredoc directly
        const tokB64 = fs.readFileSync('packages/parameter-golf/data/tokenizers/fineweb_1024_bpe.model').toString('base64')
        await client.executeCommand(podId,
          `stty -echo 2>/dev/null\ncat > /tmp/tok.b64 << 'CGOLF_EOF'\n${tokB64}\nCGOLF_EOF\nbase64 -d /tmp/tok.b64 > ${tier2.tokenizerPath} && rm /tmp/tok.b64 && stty echo 2>/dev/null && echo TOK_UPLOADED $(wc -c < ${tier2.tokenizerPath}) bytes`,
          120_000)
        console.log('Tokenizer uploaded.')
      }
      console.log('Dataset ready on pod.')
    }

    console.log('Uploading script...')
    await client.uploadScript(podId, modifiedSource, `/workspace/${tier2.trainScript}`)
    console.log('Script uploaded, starting training...')

    const command = [
      'cd /workspace &&',
      'PYTHONPATH=/workspace/site-packages',
      'LOCAL_RANK=0 RANK=0 WORLD_SIZE=1 MASTER_ADDR=localhost MASTER_PORT=29500',
      `MAX_WALLCLOCK_SECONDS=${Math.floor(tier2.maxWallclockSec)}`,
      `DATA_PATH='${tier2.dataPath}'`,
      `TOKENIZER_PATH='${tier2.tokenizerPath}'`,
      'TRAIN_LOG_EVERY=5',
      'VAL_LOSS_EVERY=0',
      `python3 '/workspace/${tier2.trainScript}' 2>&1`,
    ].join(' ')

    console.log(`Command: ${command}`)
    console.log('Training started...\n')

    const stdout = await client.executeCommand(podId, command, (tier2.maxWallclockSec + 300) * 1000)

    // Parse results
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

    // Print last 80 lines of stdout for context
    const lines = stdout.split('\n')
    console.log('\n=== LAST 80 LINES ===')
    console.log(lines.slice(-80).join('\n'))

  } finally {
    if (podId) {
      console.log(`\nTerminating pod ${podId}...`)
      try {
        await client.terminatePod(podId)
        console.log('Pod terminated.')
      } catch (err) {
        console.error(`WARNING: Failed to terminate pod: ${err}`)
      }
    }
  }
}

main().catch(err => {
  console.error('Fatal:', err)
  process.exit(1)
})
