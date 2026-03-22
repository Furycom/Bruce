#!/bin/bash
# Recreate llama-server with --metrics enabled
# Run this AFTER DSPy finishes (check: ps aux | grep bruce_dspy | grep -v grep | wc -l = 0)
set -e
echo "Stopping llama-server..."
docker stop llama-server
docker rm llama-server

echo "Starting llama-server with --metrics..."
docker run -d \
  --name llama-server \
  --gpus all \
  -v /srv/models:/models:ro \
  -p 8000:8080 \
  --restart unless-stopped \
  ghcr.io/ggml-org/llama.cpp:server-cuda \
  --model /models/qwen3-32b-q4km/Qwen_Qwen3-32B-Q4_K_M.gguf \
  --host 0.0.0.0 --port 8080 \
  --n-gpu-layers auto \
  --ctx-size 16384 \
  --threads 24 \
  --parallel 1 \
  --cont-batching \
  --flash-attn auto \
  --metrics \
  --api-key token-abc123

echo "Waiting for health..."
for i in $(seq 1 30); do
  sleep 2
  STATUS=$(curl -s http://localhost:8000/health 2>/dev/null | python3 -c "import sys,json; print(json.load(sys.stdin).get('status',''))" 2>/dev/null || echo "")
  if [ "$STATUS" = "ok" ]; then
    echo "llama-server healthy after $((i*2))s"
    # Test metrics endpoint
    curl -s -H "Authorization: Bearer token-abc123" http://localhost:8000/metrics | head -5
    echo "DONE - metrics enabled"
    exit 0
  fi
done
echo "TIMEOUT waiting for health"
