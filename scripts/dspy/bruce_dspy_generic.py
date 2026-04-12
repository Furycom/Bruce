#!/usr/bin/env python3
"""
bruce_dspy_generic.py - Generic DSPy optimizer for BRUCE tasks.
Env: DSPY_TASK (dedup|session_summary|kb_audit), DSPY_RESULTS_DIR, DSPY_MODEL_NAME, DSPY_GOLD_FILE
"""
import dspy, json, os, sys, time, logging, signal, re, shutil

LLM_BASE_URL = "http://192.168.2.32:8000/v1"
LLM_API_KEY = "token-abc123"
MODEL_NAME = os.environ.get("DSPY_MODEL_NAME", "openai/local")
TIMEOUT_SEC = 180
MAX_TOKENS = 800
RESULTS_DIR = os.environ.get("DSPY_RESULTS_DIR", "/tmp/dspy_results")
GOLD_FILE = os.environ.get("DSPY_GOLD_FILE", "")
TASK = os.environ.get("DSPY_TASK", "dedup")
os.makedirs(RESULTS_DIR, exist_ok=True)
LOG_FILE = f"{RESULTS_DIR}/optimizer.log"
logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s",
    handlers=[logging.FileHandler(LOG_FILE, mode='w'), logging.StreamHandler(sys.stdout)])
log = logging.getLogger(f"dspy-{TASK}")
signal.signal(signal.SIGTERM, lambda s, f: sys.exit(0))

def safe_parse_json(text):
    if not text: return None
    m = re.search(r'\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\}', text, re.DOTALL)
    if not m: return None
    try: return json.loads(m.group())
    except: return None

def parse_bool(val):
    if isinstance(val, bool): return val
    if isinstance(val, str): return val.lower().strip() in ("true","1","yes","oui")
    return bool(val) if isinstance(val, (int, float)) else False

def parse_float(val, default=0.5):
    if isinstance(val, (int, float)): return float(val)
    if isinstance(val, str):
        try: return float(val.strip().rstrip("%")) / (100 if "%" in val else 1)
        except: return default
    return default

# ===== DEDUP =====
class DedupSignature(dspy.Signature):
    """Compare deux lessons BRUCE, determine si doublons semantiques. JSON: {is_duplicate, keep_id, archive_id, reason, confidence}."""
    input_pair: str = dspy.InputField(desc="JSON: {id_a, text_a, id_b, text_b}")
    expected_verdict: str = dspy.OutputField(desc="JSON verdict")
class DedupModule(dspy.Module):
    def __init__(self): super().__init__(); self.predict = dspy.Predict(DedupSignature)
    def forward(self, input_pair): return self.predict(input_pair=input_pair)
def dedup_metric(example, prediction, trace=None):
    try:
        def pv(t):
            r = safe_parse_json(t); return {"is_duplicate":parse_bool(r.get("is_duplicate",False)),"keep_id":r.get("keep_id"),"archive_id":r.get("archive_id"),"confidence":parse_float(r.get("confidence",0.5))} if r else None
        e,p = pv(example.expected_verdict), pv(prediction.expected_verdict)
        if not e or not p: return 0.0
        s = 0.0
        if e["is_duplicate"] == p["is_duplicate"]: s += 0.50
        else: return 0.0
        if e["is_duplicate"] and p["is_duplicate"]:
            if e.get("keep_id")==p.get("keep_id") and e.get("archive_id")==p.get("archive_id"): s+=0.30
            elif e.get("keep_id")==p.get("keep_id") or e.get("archive_id")==p.get("archive_id"): s+=0.15
        else: s+=0.30
        if abs(e["confidence"]-p["confidence"])<=0.15: s+=0.20
        elif abs(e["confidence"]-p["confidence"])<=0.30: s+=0.10
        return round(s,4)
    except: return 0.0

# ===== SESSION SUMMARY =====
class SummarySignature(dspy.Signature):
    """Resume concis session BRUCE depuis lessons. JSON: {summary: "texte"}. 1-3 phrases factuelles."""
    input_lessons: str = dspy.InputField(desc="JSON array [{id, lesson_text, importance}]")
    expected_summary: str = dspy.OutputField(desc='JSON: {summary: "..."}')
class SummaryModule(dspy.Module):
    def __init__(self): super().__init__(); self.predict = dspy.Predict(SummarySignature)
    def forward(self, input_lessons): return self.predict(input_lessons=input_lessons)
def summary_metric(example, prediction, trace=None):
    try:
        e,p = safe_parse_json(example.expected_summary), safe_parse_json(prediction.expected_summary)
        if not e or not p: return 0.0
        et,pt = e.get("summary","").lower(), p.get("summary","").lower()
        if not et or not pt: return 0.0
        sw = {"dans","avec","pour","plus","sans","mais","apres","avant","cette","entre","depuis"}
        ew = set(w for w in re.findall(r'\b\w+\b',et) if len(w)>4 and w not in sw)
        if not ew: return 0.5
        hits = sum(1 for w in ew if w in set(re.findall(r'\b\w+\b',pt)))
        cov = hits/len(ew)
        ls = 0.3 if len(pt)<30 else (0.7 if len(pt)>400 else 1.0)
        return round(cov*0.7+ls*0.3, 4)
    except: return 0.0

# ===== KB AUDIT =====
class KbAuditSignature(dspy.Signature):
    """Auditeur EXIGEANT de la base de connaissances BRUCE (homelab AI).
    Garantir que chaque fiche est UTILE, PRECISE et NON REDONDANTE.
    TECHNOLOGIES OBSOLETES (archiver si presentees comme actuelles):
    - vLLM -> REMPLACE PAR llama.cpp server-cuda
    - Qwen 7B / Qwen2.5-7B / Qwen 2.5 8B -> REMPLACE PAR Qwen3-32B Q4_K_M
    - Ollama sur .32 -> REMPLACE PAR llama.cpp
    - 192.168.2.206 (ancien Supabase) -> REMPLACE PAR 192.168.2.146. .206 est MORT
    - Gate-2 validation vLLM -> REMPLACE PAR Gate-1 schema + triggers PG
    - CURRENT_STATE table / handoff via current_state JSON -> REMPLACE PAR Memory MCP 5-tier (BRUCE_STATE + PIEGES_ACTIFS)
    - vllm service name -> REMPLACE PAR llama-server
    - llm_swapper.py -> OBSOLETE, ne plus utiliser
    ARCHITECTURE ACTUELLE: Supabase .146, Gateway .230:4000, LLM Qwen3-32B .32:8000, n8n .174, embedder BGE-M3 .85:8081.
    CRITERES:
    - ARCHIVE si: mentionne une techno/IP obsolete ci-dessus, incorrecte, trop vague, ou couverte par une autre fiche.
    - UPDATE si: correct mais incomplet, IP/version a corriger, ou texte trop court. improved_text OBLIGATOIRE.
    - KEEP si: correct, specifique, actionable, coherent avec architecture actuelle.
    IMPORTANT: Proposer ARCHIVE ou UPDATE pour au moins 30% des fiches. Ne pas tamponner KEEP.
    JSON: {reviews: [{id, verdict: keep|archive|update, reason, improved_text}]}."""
    input_kb: str = dspy.InputField(desc="JSON array [{id, question, answer}]")
    expected_review: str = dspy.OutputField(desc="JSON: {reviews: [{id, verdict: keep|archive|update, reason, improved_text or null}]}")
class KbAuditModule(dspy.Module):
    def __init__(self): super().__init__(); self.predict = dspy.Predict(KbAuditSignature)
    def forward(self, input_kb): return self.predict(input_kb=input_kb)

def kb_audit_metric(example, prediction, trace=None):
    """Score kb_audit: verdict match (60%) + improved_text quality for updates (40%)."""
    try:
        def parse_reviews(text):
            raw = safe_parse_json(text)
            if not raw: return None
            revs = raw.get("reviews", [])
            if not revs and "verdict" in raw: revs = [raw]
            return {r["id"]: r for r in revs} if revs else None
        e_map = parse_reviews(example.expected_review)
        p_map = parse_reviews(prediction.expected_review)
        if not e_map or not p_map: return 0.0
        scores = []
        for kid, exp in e_map.items():
            pred = p_map.get(kid)
            if not pred: scores.append(0.0); continue
            s = 0.0
            if exp.get("verdict") == pred.get("verdict"): s += 0.60
            else: scores.append(0.0); continue
            if exp["verdict"] == "update" and exp.get("improved_text") and pred.get("improved_text"):
                sw = {"dans","avec","pour","plus","sans","mais","apres","avant"}
                ew = set(w for w in re.findall(r'\b\w+\b', exp["improved_text"].lower()) if len(w)>4 and w not in sw)
                pw = set(re.findall(r'\b\w+\b', pred["improved_text"].lower()))
                if ew: s += 0.40 * (sum(1 for w in ew if w in pw) / len(ew))
                else: s += 0.20
            elif exp["verdict"] in ("keep", "archive"):
                s += 0.40
            scores.append(round(s, 4))
        return round(sum(scores)/len(scores), 4) if scores else 0.0
    except: return 0.0

# ===== GENERIC EVALUATE =====
def evaluate(module, dataset, label, task):
    FIELDS = {"dedup":("input_pair","expected_verdict"), "session_summary":("input_lessons","expected_summary"), "kb_audit":("input_kb","expected_review")}
    METRICS = {"dedup":dedup_metric, "session_summary":summary_metric, "kb_audit":kb_audit_metric}
    inf, outf = FIELDS[task]
    metric_fn = METRICS[task]
    scores = []
    for i, ex in enumerate(dataset):
        t0 = time.time()
        try:
            pred = module(**{inf: getattr(ex, inf)})
            s = metric_fn(ex, pred)
            elapsed = round(time.time()-t0, 1)
            log.info(f"  [{label}] {i+1}/{len(dataset)}: score={s:.3f} ({elapsed}s) raw={str(getattr(pred, outf, ''))[:250]}")
            scores.append(s)
        except Exception as e:
            log.error(f"  [{label}] {i+1}/{len(dataset)}: ERROR {e} ({round(time.time()-t0,1)}s)")
            scores.append(0.0)
    avg = round(sum(scores)/len(scores), 4) if scores else 0
    log.info(f"  [{label}] Average: {avg:.4f}")
    return avg, scores

# ===== MAIN =====
if __name__ == "__main__":
    log.info("=" * 60)
    log.info(f"DSPy Optimization: {TASK} on {MODEL_NAME}")
    log.info(f"Gold: {GOLD_FILE}, Results: {RESULTS_DIR}")
    log.info(f"PID={os.getpid()}")
    log.info("=" * 60)
    cache_dir = os.path.expanduser("~/.dspy_cache")
    if os.path.exists(cache_dir): shutil.rmtree(cache_dir)
    # [S1483] Disable DSPy global disk cache (FanoutCache/SQLite) — root cause of BFSRS crash
    # cache=False in dspy.LM() only prevents LM from using cache, but the global
    # dspy.cache object still creates a FanoutCache with SQLite that crashes under
    # concurrent writes from BFSRS parallelizer
    dspy.cache.enable_disk_cache = False
    dspy.cache.disk_cache = {}
    log.info("DSPy global disk cache DISABLED (FanoutCache SQLite fix)")
    lm = dspy.LM(model=MODEL_NAME, api_base=LLM_BASE_URL, api_key=LLM_API_KEY,
                  max_tokens=MAX_TOKENS, timeout=TIMEOUT_SEC, cache=False)  # [S1482] cache=False prevents SQLite crash in BFSRS
    dspy.configure(lm=lm)
    with open(GOLD_FILE) as f: raw_gold = json.load(f)

    TASK_CONFIG = {
        "dedup": {"module": DedupModule, "metric": dedup_metric, "input": "input_pair", "output": "expected_verdict",
                  "build": lambda g: dspy.Example(input_pair=g["input_pair"], expected_verdict=g["expected_verdict"]).with_inputs("input_pair")},
        "session_summary": {"module": SummaryModule, "metric": summary_metric, "input": "input_lessons", "output": "expected_summary",
                  "build": lambda g: dspy.Example(input_lessons=g["input_lessons"], expected_summary=g["expected_summary"]).with_inputs("input_lessons")},
        "kb_audit": {"module": KbAuditModule, "metric": kb_audit_metric, "input": "input_kb", "output": "expected_review",
                  "build": lambda g: dspy.Example(input_kb=g["input_kb"], expected_review=g["expected_review"]).with_inputs("input_kb")},
    }
    cfg = TASK_CONFIG[TASK]
    ModuleClass, metric_fn = cfg["module"], cfg["metric"]
    ALL = [cfg["build"](g) for g in raw_gold]
    n = len(ALL)
    TRAIN = ALL[0:max(1,int(n*0.5))]
    DEV = ALL[max(1,int(n*0.5)):max(2,int(n*0.85))]
    TEST = ALL[max(2,int(n*0.85)):]
    if len(TEST)==0: TEST=ALL[-1:]
    if len(DEV)==0: DEV=ALL[int(n*0.5):]
    log.info(f"Split: {len(TRAIN)}T {len(DEV)}D {len(TEST)}Te (total {n})")

    # Baseline
    log.info("\n--- BASELINE DEV ---")
    baseline = ModuleClass()
    t0=time.time()
    bs,_ = evaluate(baseline, DEV, "BASE", TASK)
    log.info(f"BASELINE: {bs:.4f} in {round(time.time()-t0,1)}s")

    # LabeledFewShot
    log.info("\n--- LabeledFewShot ---")
    t0=time.time()
    try:
        opt_labeled = dspy.LabeledFewShot(k=min(8,len(TRAIN))).compile(ModuleClass(), trainset=TRAIN)
        log.info(f"LabeledFewShot done in {round(time.time()-t0,1)}s")
    except Exception as e: log.error(f"LFS FAILED: {e}"); opt_labeled=baseline
    ts_l,_ = evaluate(opt_labeled, DEV, "LABELED-DEV", TASK)

    # BootstrapFewShot
    log.info("\n--- BootstrapFewShot ---")
    if os.path.exists(cache_dir): shutil.rmtree(cache_dir)
    t0=time.time()
    try:
        opt_bfs = dspy.BootstrapFewShot(metric=metric_fn, max_bootstrapped_demos=4, max_labeled_demos=4, max_rounds=1).compile(ModuleClass(), trainset=TRAIN)
        log.info(f"BFS done in {round(time.time()-t0,1)}s")
    except Exception as e: log.error(f"BFS FAILED: {e}"); opt_bfs=baseline
    ts_bfs,_ = evaluate(opt_bfs, DEV, "BFS-DEV", TASK)

    # BFSRS
    log.info("\n--- BFSRS ---")
    if os.path.exists(cache_dir): shutil.rmtree(cache_dir)
    t0=time.time()
    try:
        opt_bfsrs = dspy.BootstrapFewShotWithRandomSearch(metric=metric_fn, max_bootstrapped_demos=4, max_labeled_demos=4, num_candidate_programs=6, num_threads=1).compile(ModuleClass(), trainset=TRAIN, valset=DEV)
        log.info(f"BFSRS done in {round(time.time()-t0,1)}s")
    except Exception as e: log.error(f"BFSRS FAILED: {e}"); opt_bfsrs=baseline
    ts_bfsrs,_ = evaluate(opt_bfsrs, DEV, "BFSRS-DEV", TASK)

    # Final TEST
    log.info("\n" + "="*60)
    log.info("FINAL COMPARISON ON TEST")
    log.info("="*60)
    ts_base,_ = evaluate(baseline, TEST, "BASE-TEST", TASK)
    ts_lab,_ = evaluate(opt_labeled, TEST, "LABELED-TEST", TASK)
    ts_bfs_t,_ = evaluate(opt_bfs, TEST, "BFS-TEST", TASK)
    ts_bfsrs_t,_ = evaluate(opt_bfsrs, TEST, "BFSRS-TEST", TASK)
    log.info(f"\n  Baseline TEST:     {ts_base:.4f}")
    log.info(f"  LabeledFewShot:    {ts_lab:.4f} (delta {ts_lab-ts_base:+.4f})")
    log.info(f"  BootstrapFS:       {ts_bfs_t:.4f} (delta {ts_bfs_t-ts_base:+.4f})")
    log.info(f"  BFSRS:             {ts_bfsrs_t:.4f} (delta {ts_bfsrs_t-ts_base:+.4f})")
    best_name, best_mod, best_score = "baseline", baseline, ts_base
    for nm,md,sc in [("labeled",opt_labeled,ts_lab),("bfs",opt_bfs,ts_bfs_t),("bfsrs",opt_bfsrs,ts_bfsrs_t)]:
        if sc > best_score: best_name,best_mod,best_score = nm,md,sc
    log.info(f"\n  WINNER: {best_name} ({best_score:.4f})")
    try: best_mod.save(f"{RESULTS_DIR}/best_module_{best_name}.json"); log.info(f"  Saved: best_module_{best_name}.json")
    except: pass
    with open(f"{RESULTS_DIR}/final_results.json","w") as f:
        json.dump({"baseline":ts_base,"labeled":ts_lab,"bootstrap":ts_bfs_t,"bfsrs":ts_bfsrs_t,"winner":best_name,"winner_score":best_score},f,indent=2)
    log.info("="*60)
    log.info("DONE")
