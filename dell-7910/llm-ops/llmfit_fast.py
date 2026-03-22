#!/usr/bin/env python3
import json, subprocess
r = subprocess.run(["/home/furycom/.local/bin/llmfit", "--memory", "14G", "recommend", "-n", "15", "--use-case", "general", "--runtime", "llamacpp", "--min-fit", "good", "--json"], capture_output=True, text=True)
data = json.loads(r.stdout)
print(f"{'Model':55} {'Params':>8} {'t/s':>8} {'Mem GB':>7} {'Score':>6} {'Type':>6}")
print("-" * 95)
for m in data.get("models", []):
    moe = "MoE" if m.get("is_moe") else "Dense"
    print(f"{m['name']:55} {m['parameter_count']:>8} {m.get('estimated_tps',0):>7.1f} {m.get('memory_required_gb',0):>6.1f} {m.get('score',0):>6.1f} {moe:>6}")
