#!/bin/bash
# download_qwen35.sh — Download Qwen3.5 models to /srv/models on .32
set -e

echo "=== QWEN 3.5 MODEL DOWNLOADS ==="
echo "Started: $(date)"

echo ""
echo "--- Downloading Qwen3.5-27B Q4_K_M (16.7 GB) ---"
mkdir -p /srv/models/qwen35-27b-q4km
cd /srv/models/qwen35-27b-q4km
python3 -c "
from huggingface_hub import hf_hub_download
print('Starting Qwen3.5-27B download...')
path = hf_hub_download('bartowski/Qwen_Qwen3.5-27B-GGUF', 'Qwen_Qwen3.5-27B-Q4_K_M.gguf', local_dir='/srv/models/qwen35-27b-q4km')
print(f'Done: {path}')
"
echo "27B download complete: $(date)"
ls -lh /srv/models/qwen35-27b-q4km/*.gguf

echo ""
echo "--- Downloading Qwen3.5-35B-A3B Q4_K_M ---"
mkdir -p /srv/models/qwen35-35b-a3b-q4km
cd /srv/models/qwen35-35b-a3b-q4km
python3 -c "
from huggingface_hub import hf_hub_download
print('Starting Qwen3.5-35B-A3B download...')
path = hf_hub_download('bartowski/Qwen_Qwen3.5-35B-A3B-GGUF', 'Qwen_Qwen3.5-35B-A3B-Q4_K_M.gguf', local_dir='/srv/models/qwen35-35b-a3b-q4km')
print(f'Done: {path}')
"
echo "35B-A3B download complete: $(date)"
ls -lh /srv/models/qwen35-35b-a3b-q4km/*.gguf

echo ""
echo "=== ALL DOWNLOADS COMPLETE ==="
echo "Finished: $(date)"
du -sh /srv/models/qwen35-27b-q4km /srv/models/qwen35-35b-a3b-q4km
df -h /srv/models/
