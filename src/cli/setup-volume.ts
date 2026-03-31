#!/usr/bin/env tsx
import * as fs from 'fs'
import { RunPodsClient } from '../runner/runpods-client.js'

const volumeId = process.argv[2] || 'fmbckw29gp'
const client = new RunPodsClient(process.env.RUNPOD_API_KEY!)

async function main() {
  console.log(`Setting up volume ${volumeId} with dataset...`)

  // Try any available GPU — setup only needs a running pod, not specific GPU
  const gpuTypes = ['NVIDIA GeForce RTX 4090', 'NVIDIA A100 80GB PCIe', 'NVIDIA H100 80GB HBM3', 'NVIDIA RTX A6000']
  let podId: string | undefined
  for (const gpu of gpuTypes) {
    try {
      console.log(`Trying ${gpu}...`)
      podId = await client.createPod(
        { gpuType: gpu, gpuCount: 1, templateId: '', containerImage: 'runpod/pytorch:2.4.0-py3.11-cuda12.4.1-devel-ubuntu22.04', volumeId },
        'cgolf-data-setup'
      )
      console.log(`Got ${gpu}`)
      break
    } catch (err) {
      if (String(err).includes('SUPPLY_CONSTRAINT')) continue
      throw err
    }
  }
  if (!podId) throw new Error('No GPUs available in any type')
  console.log('Pod:', podId)

  try {
    console.log('Waiting for RUNNING...')
    await client.waitForRunning(podId, 180_000)
    console.log('Pod running.')

    // Step 0: Install PyTorch 2.5 to persistent volume path
    console.log('Installing PyTorch 2.5 to volume (this takes ~3 min)...')
    const torchOut = await client.executeCommand(podId, [
      'pip install torch==2.5.1 --index-url https://download.pytorch.org/whl/cu124 --target=/workspace/site-packages 2>&1 | tail -5',
      'PYTHONPATH=/workspace/site-packages python3 -c "import torch; print(torch.__version__, torch.version.cuda)"',
    ].join(' && '), 600_000)
    console.log('Torch:', torchOut.slice(-200))

    // Step 1: Clone repo and download data
    console.log('Downloading dataset (this takes ~2 min)...')
    const dlOutput = await client.executeCommand(podId, [
      'pip install -q huggingface_hub sentencepiece',
      'pip install -q huggingface_hub 2>&1 | tail -1',
      // Download sp1024 data from the parameter-golf HF dataset repo
      'python3 -c "' +
        'from huggingface_hub import hf_hub_download; import shutil, os; ' +
        'os.makedirs(\\\"/workspace/datasets/datasets/fineweb10B_sp1024\\\", exist_ok=True); ' +
        'os.makedirs(\\\"/workspace/datasets/tokenizers\\\", exist_ok=True); ' +
        '[shutil.copy(hf_hub_download(\\\"willdepueoai/parameter-golf\\\", f, subfolder=\\\"datasets/datasets/fineweb10B_sp1024\\\", repo_type=\\\"dataset\\\"), ' +
          '\\\"/workspace/datasets/datasets/fineweb10B_sp1024/\\\" + f) ' +
          'for f in [\\\"fineweb_train_000000.bin\\\", \\\"fineweb_val_000000.bin\\\"]]; ' +
        'shutil.copy(hf_hub_download(\\\"willdepueoai/parameter-golf\\\", \\\"fineweb_1024_bpe.model\\\", subfolder=\\\"datasets/tokenizers\\\", repo_type=\\\"dataset\\\"), ' +
          '\\\"/workspace/datasets/tokenizers/fineweb_1024_bpe.model\\\"); ' +
        'print(\\\"DOWNLOAD_DONE\\\")' +
        '" 2>&1',
      'echo "=== DOWNLOADED ==="',
      'find /workspace/pgolf/data -name "*.bin" -type f',
      'find /workspace/pgolf/data -name "*.model" -type f',
    ].join(' && '), 600_000)
    console.log(dlOutput.slice(-1000))


    // Clean up old GPT-2 shard and verify
    await client.executeCommand(podId,
      'rm -f /workspace/datasets/datasets/fineweb10B_sp1024/fineweb_train_000001.bin 2>/dev/null; echo CLEANED',
      30_000)
    const verify = await client.executeCommand(podId,
      'echo "=== DATASETS ===" && ls -la /workspace/datasets/datasets/fineweb10B_sp1024/ && echo "=== TOKENIZERS ===" && ls -la /workspace/datasets/tokenizers/ && echo "=== MD5 ===" && md5sum /workspace/datasets/datasets/fineweb10B_sp1024/*.bin',
      60_000)
    console.log(verify.slice(-500))

    // Clean up cloned repo to save volume space
    await client.executeCommand(podId, 'rm -rf /workspace/pgolf', 30_000)
    console.log('Cleaned up repo clone.')

  } finally {
    console.log('Terminating setup pod...')
    await client.terminatePod(podId)
    console.log(`Done! Volume ${volumeId} ready.`)
  }
}

main().catch(e => { console.error(e); process.exit(1) })
