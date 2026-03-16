#!/usr/bin/env python3
"""bruce_lesson_review.py v2 — Review lessons with LLM, output CSV
Changes v2: timeout 300s, retry per-request, slot check, LiteLLM routing, better error handling"""
import json, sys, time, os, urllib.request, urllib.error

# === CONFIG ===
# Route via LiteLLM (gère retries, timeout 600s côté proxy)
LLAMA_URL = "http://192.168.2.230:4100/v1/chat/completions"
LLAMA_KEY = "" + os.environ.get("BRUCE_LITELLM_KEY", "") + ""
# Fallback direct si LiteLLM down
LLAMA_DIRECT_URL = "http://192.168.2.32:8000/v1/chat/completions"
LLAMA_DIRECT_KEY = "token-abc123"

SUPA_URL = "http://192.168.2.146:8000/rest/v1"
OUTPUT_DIR = "/home/furycom/lesson_review_results"
TIMEOUT = 300  # per-request timeout (5 min)
MAX_LESSONS = 300
SLOT_CHECK_URL = "http://192.168.2.32:8000/health"
MAX_RETRIES_PER_LESSON = 2
BACKOFF_SECONDS = 30

os.makedirs(OUTPUT_DIR, exist_ok=True)

# Load Supabase key
supa_key = open("/home/furycom/.supabase_key").read().strip()

# State file for resume
state_file = os.path.join(OUTPUT_DIR, ".review_state")
last_id = 0
if os.path.exists(state_file):
    last_id = int(open(state_file).read().strip())
    print(f"Resuming from id > {last_id}")

# CSV output
csv_file = os.path.join(OUTPUT_DIR, f"review_{time.strftime('%Y%m%d_%H%M')}.csv")
log_file = os.path.join(OUTPUT_DIR, f"review_{time.strftime('%Y%m%d_%H%M')}.log")

def log(msg):
    line = f"[{time.strftime('%H:%M:%S')}] {msg}"
    print(line, flush=True)
    with open(log_file, "a") as f:
        f.write(line + "\n")

def check_llm_health():
    """Check if llama-server is healthy and slot is free"""
    try:
        req = urllib.request.Request(SLOT_CHECK_URL)
        with urllib.request.urlopen(req, timeout=5) as resp:
            data = json.loads(resp.read())
            return data.get("status") == "ok"
    except:
        return False

def call_llm(payload_bytes, use_litellm=True):
    """Call LLM with retry, fallback to direct if LiteLLM fails"""
    url = LLAMA_URL if use_litellm else LLAMA_DIRECT_URL
    key = LLAMA_KEY if use_litellm else LLAMA_DIRECT_KEY

    req = urllib.request.Request(
        url,
        data=payload_bytes,
        headers={"Content-Type": "application/json", "Authorization": f"Bearer {key}"}
    )
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
            return json.loads(resp.read()), None
    except urllib.error.HTTPError as e:
        return None, f"HTTP {e.code}: {e.read().decode()[:100]}"
    except Exception as e:
        # If LiteLLM failed, try direct
        if use_litellm:
            log(f"  LiteLLM failed ({e}), trying direct...")
            return call_llm(payload_bytes, use_litellm=False)
        return None, str(e)[:100]

# Fetch lessons
req = urllib.request.Request(
    f"{SUPA_URL}/lessons_learned?archived=eq.false&id=gt.{last_id}&select=id,lesson_type,importance,lesson_text,confidence_score,author_system&order=id.asc&limit={MAX_LESSONS}",
    headers={"apikey": supa_key, "Authorization": f"Bearer {supa_key}"}
)
lessons = json.loads(urllib.request.urlopen(req, timeout=15).read())
log(f"Fetched {len(lessons)} lessons to review")

if not lessons:
    log("No lessons. Exiting.")
    sys.exit(0)

# Check LLM before starting
if not check_llm_health():
    log("LLM not healthy. Waiting 60s...")
    time.sleep(60)
    if not check_llm_health():
        log("LLM still not healthy. Exiting.")
        sys.exit(1)

# Write CSV header
with open(csv_file, "w") as f:
    f.write("id,lesson_type,importance,verdict,confidence,reason\n")

done = 0
consecutive_errors = 0

for i, lesson in enumerate(lessons):
    lid = lesson["id"]
    ltype = lesson.get("lesson_type", "unknown")
    limp = lesson.get("importance", "normal")
    ltext = lesson.get("lesson_text", "")[:500]
    lconf = lesson.get("confidence_score", 0)
    lauthor = lesson.get("author_system", "unknown")

    prompt = f"""/no_think
You are a knowledge base quality reviewer for a homelab AI system called BRUCE.
Evaluate this lesson and decide: KEEP (valuable, accurate, actionable), ARCHIVE (outdated, redundant, vague, or too specific to one session), or MERGE (duplicate of common pattern).

Lesson #{lid}:
- Type: {ltype}
- Importance: {limp}
- Confidence: {lconf}
- Author: {lauthor}
- Text: {ltext}

Respond in EXACTLY this format (one line, pipe-separated):
VERDICT|CONFIDENCE|REASON
Where VERDICT is KEEP or ARCHIVE or MERGE, CONFIDENCE is 0.0-1.0, REASON is max 50 words."""

    payload = json.dumps({
        "model": "alpha",
        "messages": [{"role": "user", "content": prompt}],
        "max_tokens": 150,
        "temperature": 0.1
    }).encode()

    success = False
    for attempt in range(MAX_RETRIES_PER_LESSON):
        result, err = call_llm(payload)
        if err:
            log(f"  attempt {attempt+1}/{MAX_RETRIES_PER_LESSON} id={lid}: {err}")
            if attempt < MAX_RETRIES_PER_LESSON - 1:
                time.sleep(BACKOFF_SECONDS)
            continue

        content = result.get("choices", [{}])[0].get("message", {}).get("content", "")
        if not content:
            content = result.get("choices", [{}])[0].get("message", {}).get("reasoning_content", "")

        parts = content.strip().split("|", 2)
        if len(parts) >= 3:
            verdict = parts[0].strip().upper()
            conf = parts[1].strip()
            reason = parts[2].strip().replace('"', "'").replace(",", ";").replace("\n", " ")
            if verdict not in ("KEEP", "ARCHIVE", "MERGE"):
                verdict = "UNKNOWN"
        else:
            verdict = "PARSE_ERROR"
            conf = "0"
            reason = content[:100].replace('"', "'").replace(",", ";").replace("\n", " ")

        with open(csv_file, "a") as f:
            f.write(f'{lid},{ltype},{limp},{verdict},{conf},{reason}\n')

        done += 1
        consecutive_errors = 0
        log(f"{done}/{len(lessons)} id={lid} -> {verdict} ({conf})")
        success = True
        break

    if not success:
        consecutive_errors += 1
        with open(csv_file, "a") as f:
            f.write(f'{lid},{ltype},{limp},ERROR,0,all retries failed\n')
        log(f"ERROR id={lid}: all {MAX_RETRIES_PER_LESSON} retries failed")

        if consecutive_errors >= 5:
            log("5 consecutive errors. LLM probably down. Exiting.")
            break
        if consecutive_errors >= 3:
            log("3 errors in a row. Checking LLM health...")
            if not check_llm_health():
                log("LLM confirmed down. Waiting 120s...")
                time.sleep(120)
                if not check_llm_health():
                    log("LLM still down after wait. Exiting.")
                    break
            else:
                log("LLM healthy, continuing...")
                consecutive_errors = 0  # reset if LLM is actually healthy

    # Save state
    with open(state_file, "w") as f:
        f.write(str(lid))

    time.sleep(2)  # gentle pace between requests

log(f"COMPLETE: {done} reviewed out of {len(lessons)} total")