#!/usr/bin/env python3
import os
"""
gate2_eval.py — Evaluate Gate-2 quality filter on gold set
Tests the current quality_gates.py vllm_quality_check against 50 known examples.
Run: python3 gate2_eval.py (requires 32B Alpha to be loaded and free)
"""
import json, time, sys
sys.path.insert(0, '/home/furycom')
from quality_gates import vllm_quality_check

# Gold set: 25 ACCEPT (specific, actionable) + 25 REJECT (vague truisms from Qwen 7B)
ACCEPT_IDS = [2613,2612,2611,2610,2609,2600,2559,2555,2554,2546,2536,2520,2517,2516,2514,2507,2504,2503,2502,2500,2499,2498,2497,2496,2494]
REJECT_IDS = [3250,3241,3173,3265,3222,3178,3240,3236,3198,3249,3026,3172,3029,3239,3025,3209,3111,3208,3156,2989,3131,3009,3243,3227,3221]

import requests
SUPA = "http://192.168.2.146:8000/rest/v1"
SK = open('/home/furycom/.supabase_key').read().strip() if __import__('os').path.exists('/home/furycom/.supabase_key') else os.environ.get("SUPABASE_KEY", "")
H = {"apikey": SK, "Authorization": f"Bearer {SK}"}

def fetch_lessons(ids):
    """Fetch lesson texts by IDs"""
    results = []
    for lid in ids:
        r = requests.get(f"{SUPA}/lessons_learned?id=eq.{lid}&select=id,lesson_type,lesson_text", headers=H, timeout=5)
        if r.status_code == 200 and r.json():
            results.append(r.json()[0])
    return results

print("=== Gate-2 Evaluation v1 ===")
print(f"Testing {len(ACCEPT_IDS)} accept + {len(REJECT_IDS)} reject examples")
print()

# Warmup check
print("Checking LLM availability...")
try:
    h = requests.get("http://192.168.2.32:8000/health", timeout=5)
    slots = requests.get("http://192.168.2.32:8000/slots", headers={"Authorization": "Bearer token-abc123"}, timeout=5).json()
    if slots[0].get('is_processing'):
        print("ERROR: LLM slot busy. Wait for DSPy to finish first.")
        sys.exit(1)
    print("LLM ready.")
except Exception as e:
    print(f"ERROR: LLM not available: {e}")
    sys.exit(1)

# Fetch data
print("Fetching gold set from Supabase...")
accept_lessons = fetch_lessons(ACCEPT_IDS)
reject_lessons = fetch_lessons(REJECT_IDS)
print(f"  Fetched {len(accept_lessons)} accept, {len(reject_lessons)} reject")

# Test Gate-2
tp, fp, tn, fn = 0, 0, 0, 0
results = []
total = len(accept_lessons) + len(reject_lessons)

print(f"\nTesting Gate-2 on {total} examples (~{total*5}s estimated)...\n")

# Test ACCEPT examples (should pass)
for i, l in enumerate(accept_lessons):
    t0 = time.time()
    passed, reason = vllm_quality_check(l['lesson_text'], l['lesson_type'], 'lessons_learned')
    dt = time.time() - t0
    if passed:
        tp += 1
        tag = "TP"
    else:
        fn += 1
        tag = "FN"
    results.append({"id": l['id'], "expected": "accept", "got": "accept" if passed else "reject", "tag": tag, "reason": reason, "time": round(dt,1)})
    print(f"  [{i+1}/{total}] {tag} id={l['id']} ({dt:.1f}s) {reason}")

# Test REJECT examples (should fail)
for i, l in enumerate(reject_lessons):
    t0 = time.time()
    passed, reason = vllm_quality_check(l['lesson_text'], l['lesson_type'], 'lessons_learned')
    dt = time.time() - t0
    if not passed:
        tn += 1
        tag = "TN"
    else:
        fp += 1
        tag = "FP"
    results.append({"id": l['id'], "expected": "reject", "got": "accept" if passed else "reject", "tag": tag, "reason": reason, "time": round(dt,1)})
    print(f"  [{len(accept_lessons)+i+1}/{total}] {tag} id={l['id']} ({dt:.1f}s) {reason}")

# Results
precision = tp / (tp + fp) if (tp + fp) > 0 else 0
recall = tp / (tp + fn) if (tp + fn) > 0 else 0
accuracy = (tp + tn) / total if total > 0 else 0
f1 = 2 * precision * recall / (precision + recall) if (precision + recall) > 0 else 0

print(f"\n=== RESULTATS ===")
print(f"TP={tp} FP={fp} TN={tn} FN={fn}")
print(f"Precision: {precision:.1%}")
print(f"Recall:    {recall:.1%}")
print(f"F1:        {f1:.1%}")
print(f"Accuracy:  {accuracy:.1%}")
print(f"\nSeuil activation: precision > 70%")
print(f"Verdict: {'ACTIVER Gate-2' if precision > 0.7 else 'NE PAS activer - precision insuffisante'}")

# Save results
with open('/home/furycom/gate2_eval_results.json', 'w') as f:
    json.dump({"tp": tp, "fp": fp, "tn": tn, "fn": fn, "precision": precision, "recall": recall, "f1": f1, "accuracy": accuracy, "results": results}, f, indent=2)
print(f"\nResultats sauvegardes: /home/furycom/gate2_eval_results.json")