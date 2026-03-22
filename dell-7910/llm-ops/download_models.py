#!/usr/bin/env python3
"""Download GGUF models for multi-LLM pipeline [1030]"""
import os, time, sys

os.environ["HF_HUB_ENABLE_HF_TRANSFER"] = "1"
from huggingface_hub import hf_hub_download

MODELS = [
    {
        "repo": "unsloth/Qwen3-14B-GGUF",
        "filename": "Qwen3-14B-UD-Q4_K_XL.gguf",
        "dest": "/srv/models/qwen3-14b-q4km",
        "label": "Qwen3-14B Q4"
    },
    {
        "repo": "unsloth/Qwen3.5-9B-GGUF",
        "filename": "Qwen3.5-9B-Q4_K_M.gguf",
        "dest": "/srv/models/qwen35-9b-q4km",
        "label": "Qwen3.5-9B Q4"
    },
    {
        "repo": "unsloth/Qwen3-30B-A3B-GGUF",
        "filename": "Qwen3-30B-A3B-UD-Q4_K_XL.gguf",
        "dest": "/srv/models/qwen3-30b-a3b-q4km",
        "label": "Qwen3-30B-A3B MoE Q4"
    },
]

for m in MODELS:
    ts = time.strftime("%H:%M:%S")
    print(f"\n[{ts}] Downloading {m['label']}...", flush=True)
    t0 = time.time()
    try:
        path = hf_hub_download(
            repo_id=m["repo"],
            filename=m["filename"],
            local_dir=m["dest"],
            local_dir_use_symlinks=False,
        )
        elapsed = round(time.time() - t0, 1)
        size_gb = round(os.path.getsize(path) / 1e9, 2)
        ts2 = time.strftime("%H:%M:%S")
        print(f"[{ts2}] OK: {m['label']} -> {path} ({size_gb} GB in {elapsed}s)", flush=True)
    except Exception as e:
        ts2 = time.strftime("%H:%M:%S")
        print(f"[{ts2}] FAILED {m['label']}: {e}", flush=True)

ts = time.strftime("%H:%M:%S")
print(f"\n[{ts}] All downloads complete.", flush=True)
