# RunPods Setup Guide

One-time setup for Tier 2 GPU runs.

## Prerequisites
- RunPods account (https://runpod.io)
- API key (Settings → API Keys)
- SSH key configured in RunPods (Settings → SSH Keys)

## 1. Create a Network Volume

1. Go to RunPods → Storage → Network Volumes
2. Create a volume (50GB, pick a region close to GPU availability)
3. Note the `volumeId`

## 2. Upload Dataset to Volume

Create a temporary pod with the volume mounted, then upload the data:

```bash
# On the RunPods pod:
mkdir -p /workspace/data/datasets /workspace/data/tokenizers

# Download fineweb10B_sp1024 dataset
# (replace with your actual data source — HuggingFace, S3, etc.)
cd /workspace/data/datasets
# ... download fineweb10B_sp1024/ here ...

# Download tokenizer
cd /workspace/data/tokenizers
# ... download fineweb_1024_bpe.model here ...
```

Stop the temporary pod after upload. The network volume persists.

## 3. Create a Template (Optional)

If you want faster pod startup:
1. Go to RunPods → Templates → New Template
2. Container image: `runpod/pytorch:2.4.0-py3.11-cuda12.4.1-devel-ubuntu22.04`
3. Volume mount: `/workspace`
4. Expose port: `22/tcp` (SSH)
5. Note the `templateId`

## 4. Configure consensus-golf

Add to `.env.local`:
```
RUNPOD_API_KEY=your-api-key-here
```

Edit `config/default-policy.json`, set tier2 values:
```json
"tier2": {
  "templateId": "your-template-id",
  "volumeId": "your-volume-id",
  "enabled": true
}
```

## 5. Test

```bash
# Dry run (no GPU cost)
export $(grep -v '^#' .env.local | xargs)
npx tsx src/cli/run-cycle.ts --tier2 --gpu-budget 5 --board test --dry-run

# Live run (costs ~$1 per experiment)
npx tsx src/cli/run-cycle.ts --cycles 1 --tier2 --gpu-budget 5 --board pgolf-gpu-test
```

## Cost Reference

| GPU | Hourly Rate | 15-min Run |
|-----|-------------|------------|
| 1x H100 SXM | ~$3-4/hr | ~$0.75-1.00 |
| 1x A100 80GB | ~$2-3/hr | ~$0.50-0.75 |
| 8x H100 SXM | ~$25/hr | ~$6-7 |

Default: 1x H100 for iterative testing. Use 8x H100 only for final submissions.

## Troubleshooting

**Pod never starts:** Check GPU availability in your region. Try `cloudType: "ALL"` or a different GPU type.

**SSH connection fails:** Ensure your SSH key is added in RunPods settings. The connection uses `ssh {podId}@ssh.runpod.io`.

**Data not found on pod:** Verify the volume ID matches and the data paths in config match where you uploaded.

**Budget exceeded:** The cost tracker prevents overspend. Increase `--gpu-budget` or reduce `estimatedCostPerRun`.
