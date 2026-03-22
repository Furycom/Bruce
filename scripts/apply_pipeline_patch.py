#!/usr/bin/env python3
"""apply_pipeline_patch.py — Apply multi-LLM pipeline patches to bruce_screensaver.py
Usage: python3 apply_pipeline_patch.py [--dry-run] [--backup] [--force]
"""
import os, re, shutil, sys

SCREENSAVER_PATH = "/home/furycom/bruce_screensaver.py"
BACKUP_PATH = "/home/furycom/bruce_screensaver.py.pre_pipeline.bak"

def read_file(path):
    with open(path, "r", encoding="utf-8") as f:
        return f.read()

def write_file(path, content):
    with open(path, "w", encoding="utf-8") as f:
        f.write(content)

def patch(content):
    # PATCH 1: Add pipeline imports after HTTP = requests.Session()
    pipeline_import = '''
# -- [1231] Multi-LLM Pipeline support --
PIPELINE_ENABLED = False
_pipeline = None

def _init_pipeline():
    global PIPELINE_ENABLED, _pipeline
    try:
        import bruce_pipeline
        _pipeline = bruce_pipeline.get_pipeline()
        PIPELINE_ENABLED = True
        log("SYSTEM", logging.INFO, "[1231] Multi-LLM pipeline ENABLED. Model: %s" % _pipeline.get_current_model())
    except ImportError:
        log("SYSTEM", logging.INFO, "[1231] bruce_pipeline.py not found - single-model mode")
    except Exception as exc:
        log("SYSTEM", logging.WARNING, "[1231] Pipeline init failed: %s" % exc)

'''
    marker = "HTTP = requests.Session()\n"
    if marker in content:
        content = content.replace(marker, marker + pipeline_import, 1)
    else:
        print("WARNING: PATCH 1 marker not found")

    # PATCH 2: Replace llm_call() with pipeline-aware version
    new_llm_call = '''def llm_call(job: str, prompt: str, max_tokens: int) -> Optional[Any]:
    if not prompt.startswith("/no_think"):
        log(job, logging.ERROR, "Prompt missing /no_think")
        return None
    # [1231] Pipeline path
    if PIPELINE_ENABLED and _pipeline is not None:
        started = time.time()
        log(job, logging.INFO, f"[PIPELINE] Routing task_type={job} prompt_len={len(prompt)}")
        result = _pipeline.execute(job, prompt, max_tokens=max_tokens)
        elapsed = round(time.time() - started, 2)
        if result is not None:
            log(job, logging.INFO, f"[PIPELINE] Success model={_pipeline.get_current_model()} elapsed={elapsed}s")
        else:
            log(job, logging.ERROR, f"[PIPELINE] Failed after {elapsed}s")
        return result
    # Original direct-call path (fallback)
    started = time.time()
    payload = {
        "model": CONFIG["litellm"]["model"],
        "messages": [{"role": "user", "content": prompt}],
        "max_tokens": max_tokens,
        "temperature": CONFIG["litellm"]["temperature"],
        "reasoning_format": "none",
    }
    log(job, logging.INFO, f"LLM call prompt_len={len(prompt)} max_tokens={max_tokens}")
    resp = request_with_retry(
        "POST", CONFIG["litellm"]["url"], job,
        headers=CONFIG["litellm"]["headers"], json_body=payload,
        timeout=CONFIG["timeouts"]["llm"],
    )
    if not resp:
        log(job, logging.ERROR, "LLM call failed after retries")
        return None
    elapsed = round(time.time() - started, 2)
    try:
        raw = resp.json()["choices"][0]["message"]["content"]
    except Exception as exc:
        log(job, logging.ERROR, f"Failed parsing LLM envelope: {exc}")
        save_raw_llm(job, resp.text[:20000])
        return None
    parsed = parse_llm_json(job, raw)
    if parsed is None:
        log(job, logging.ERROR, f"LLM JSON parse failed elapsed={elapsed}s")
        return None
    log(job, logging.INFO, f"LLM success elapsed={elapsed}s")
    return parsed

'''
    llm_call_pattern = r'def llm_call\(job: str, prompt: str, max_tokens: int\) -> Optional\[Any\]:.*?(?=\ndef [a-z])'
    match = re.search(llm_call_pattern, content, re.DOTALL)
    if match:
        content = content[:match.start()] + new_llm_call + content[match.end():]
    else:
        print("WARNING: PATCH 2 - llm_call() not found")

    # PATCH 3: Replace run_cycle() with pipeline-aware version
    new_run_cycle = '''def run_cycle() -> str:
    metric_inc("cycles")
    if STATE["metrics"]["cycles"] % CONFIG["heartbeat_every_cycles"] == 0:
        heartbeat()
    if not check_idle():
        log("SYSTEM", logging.INFO, "LLM busy at cycle start")
        return "busy"
    # [1231] Pipeline-aware: run jobs matching current model first
    if PIPELINE_ENABLED and _pipeline is not None:
        current_model_jobs = set(_pipeline.get_jobs_for_current_model())
        current_model = _pipeline.get_current_model()
        log("SYSTEM", logging.INFO, f"[PIPELINE] model={current_model}, optimal_jobs={current_model_jobs}")
        remaining_jobs = []
        for job_name, job_fn in JOBS:
            if job_name in current_model_jobs:
                log("SYSTEM", logging.INFO, f"[PIPELINE] {job_name} (current model)")
                try:
                    result = job_fn()
                    log("SYSTEM", logging.INFO, f"Job={job_name} result={result}")
                    if result == "done":
                        return "done"
                    if result == "busy":
                        return "busy"
                except Exception as exc:
                    log(job_name, logging.ERROR, f"Unhandled exception: {exc}")
                    job_failure(job_name, str(exc))
            else:
                remaining_jobs.append((job_name, job_fn))
        for job_name, job_fn in remaining_jobs:
            log("SYSTEM", logging.INFO, f"[PIPELINE] {job_name} (may swap)")
            try:
                result = job_fn()
                log("SYSTEM", logging.INFO, f"Job={job_name} result={result}")
                if result == "done":
                    return "done"
                if result == "busy":
                    return "busy"
            except Exception as exc:
                log(job_name, logging.ERROR, f"Unhandled exception: {exc}")
                job_failure(job_name, str(exc))
        return "empty"
    # Original path (pipeline unavailable)
    job_executed = False
    for job_name, job_fn in JOBS:
        log("SYSTEM", logging.INFO, f"Considering job={job_name}")
        try:
            result = job_fn()
            log("SYSTEM", logging.INFO, f"Job={job_name} result={result}")
            if result == "done":
                job_executed = True
                break
            if result == "empty":
                continue
            if result == "busy":
                break
            if result == "error":
                continue
        except Exception as exc:
            log(job_name, logging.ERROR, f"Unhandled exception: {exc}")
            job_failure(job_name, str(exc))
            continue
    return "done" if job_executed else "empty"

'''
    run_cycle_pattern = r'def run_cycle\(\) -> str:.*?(?=\ndef main_loop)'
    match = re.search(run_cycle_pattern, content, re.DOTALL)
    if match:
        content = content[:match.start()] + new_run_cycle + content[match.end():]
    else:
        print("WARNING: PATCH 3 - run_cycle() not found")

    # PATCH 4: Add pipeline stats to heartbeat
    old_hb = 'def heartbeat() -> None:\n    metrics = STATE.get("metrics", {})\n    log("SYSTEM", logging.INFO, f"Heartbeat metrics={metrics}")'
    new_hb = '''def heartbeat() -> None:
    metrics = STATE.get("metrics", {})
    log("SYSTEM", logging.INFO, f"Heartbeat metrics={metrics}")
    if PIPELINE_ENABLED and _pipeline is not None:
        stats = _pipeline.get_stats()
        log("SYSTEM", logging.INFO, f"[PIPELINE] model={stats.get('current_model')} swaps={stats.get('swap_count',0)} avoided={stats.get('swaps_avoided',0)} tasks={stats.get('total_tasks_processed',0)}")'''
    if old_hb in content:
        content = content.replace(old_hb, new_hb, 1)
    else:
        print("WARNING: PATCH 4 - heartbeat() not found")

    # PATCH 5: Call _init_pipeline() in main()
    old_main = "    startup_log()"
    new_main = "    _init_pipeline()  # [1231] Multi-LLM pipeline\n    startup_log()"
    if old_main in content:
        content = content.replace(old_main, new_main, 1)
    else:
        print("WARNING: PATCH 5 - startup_log() not found")

    return content

def main():
    dry_run = "--dry-run" in sys.argv
    no_backup = "--no-backup" in sys.argv
    if not os.path.exists(SCREENSAVER_PATH):
        print(f"ERROR: {SCREENSAVER_PATH} not found")
        sys.exit(1)
    content = read_file(SCREENSAVER_PATH)
    print(f"Read {len(content)} bytes from {SCREENSAVER_PATH}")
    if "[1231]" in content:
        print("WARNING: File already has [1231] patches")
        if "--force" not in sys.argv:
            print("Use --force to re-apply")
            sys.exit(1)
    patched = patch(content)
    if dry_run:
        old_lines = content.splitlines()
        new_lines = patched.splitlines()
        print(f"DRY RUN: {len(old_lines)} -> {new_lines} lines ({len(new_lines)-len(old_lines):+d})")
        sys.exit(0)
    if not no_backup:
        shutil.copy2(SCREENSAVER_PATH, BACKUP_PATH)
        print(f"Backup: {BACKUP_PATH}")
    write_file(SCREENSAVER_PATH, patched)
    print(f"Patched! {len(patched)} bytes written.")
    print("Restart screensaver to activate pipeline.")

if __name__ == "__main__":
    main()
