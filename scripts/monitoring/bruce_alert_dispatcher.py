#!/usr/bin/env python3
"""
bruce_alert_dispatcher.py - Boucle de retroaction qualite BRUCE [885]
Agregue les resultats de TOUS les scripts de monitoring et pousse
les anomalies dans bruce_alert_outbox (consomme par n8n workflow 40 -> NTFY).
"""
import os, re, sys, json, urllib.request, urllib.error
from datetime import datetime

GATEWAY_URL = "http://192.168.2.230:4000"
GATEWAY_TOKEN = os.environ.get("BRUCE_AUTH_TOKEN", "")
LOG_DIR = "/home/furycom/logs"
CRITICAL_LESSON_THRESHOLD = 15.0
EMBEDDING_GAP_THRESHOLD = 0
TRIVY_CRITICAL_THRESHOLD = 100

def log(msg):
    ts = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    print(f"[{ts}] {msg}")

def gateway_sql(sql):
    url = f"{GATEWAY_URL}/tools/supabase/exec-sql"
    headers = {"Authorization": f"Bearer {GATEWAY_TOKEN}", "Content-Type": "application/json"}
    body = json.dumps({"sql": sql}).encode()
    req = urllib.request.Request(url, data=body, headers=headers, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            data = json.loads(resp.read())
            return data.get("data", [])
    except Exception as e:
        log(f"  ERROR gateway_sql: {e}")
        return None

def _esc(s):
    return s.replace("'", "''")

def insert_alert(alert_type, message, source, alert_key, severity="warning"):
    check = gateway_sql(f"SELECT id FROM bruce_alert_outbox WHERE alert_key = '{alert_key}' AND sent = false LIMIT 1")
    if check and len(check) > 0:
        log(f"  SKIP (dedup): {alert_key}")
        return False
    sql = f"INSERT INTO bruce_alert_outbox (alert_type, message, source, alert_key, severity) VALUES ('{alert_type}', '{_esc(message)}', '{source}', '{alert_key}', '{severity}')"
    result = gateway_sql(sql)
    if result is not None:
        log(f"  ALERT CREATED: [{severity}] {alert_key}")
        return True
    return False

def read_log_tail(filename, lines=50):
    path = os.path.join(LOG_DIR, filename)
    if not os.path.exists(path):
        return None
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as f:
            all_lines = f.readlines()
        return all_lines[-lines:] if len(all_lines) > lines else all_lines
    except Exception as e:
        log(f"  ERROR reading {filename}: {e}")
        return None

def read_log_size(filename):
    path = os.path.join(LOG_DIR, filename)
    if not os.path.exists(path):
        return -1
    return os.path.getsize(path)

def check_watchdog():
    log("CHECK: watchdog")
    lines = read_log_tail("watchdog.log", 30)
    if lines is None:
        insert_alert("monitoring", "watchdog.log introuvable", "watchdog", "watchdog_missing", "warning")
        return
    for line in lines:
        m = re.search(r"Embedding gap: chunks=(\d+) embeddings=(\d+) delta=(\d+)", line)
        if m and int(m.group(3)) > EMBEDDING_GAP_THRESHOLD:
            insert_alert("data_quality", f"Embedding gap: {m.group(3)} chunks sans embedding", "watchdog", "embedding_gap", "critical")
        if "[WATCHDOG] ALERTE:" in line or "[WATCHDOG] FAIL:" in line:
            msg = line.strip().split("] ", 2)[-1] if "] " in line else line.strip()
            key = re.sub(r'[^a-z0-9_]', '_', msg[:50].lower())
            insert_alert("service_down", msg, "watchdog", f"watchdog_{key}", "critical")
    log("  OK: watchdog analyzed")

def check_monthly_review():
    log("CHECK: monthly_review")
    lines = read_log_tail("monthly_review.log", 30)
    if lines is None:
        insert_alert("monitoring", "monthly_review.log introuvable", "monthly_review", "monthly_review_missing", "warning")
        return
    for line in lines:
        m = re.search(r"(\d+\.?\d*)% des lessons sont critical", line)
        if m and float(m.group(1)) > CRITICAL_LESSON_THRESHOLD:
            insert_alert("data_quality", f"Lessons critical a {m.group(1)}% (seuil {CRITICAL_LESSON_THRESHOLD}%)", "monthly_review", "critical_lessons_high", "warning")
        m = re.search(r"(\d+) doublons hash", line)
        if m and int(m.group(1)) > 0:
            insert_alert("data_quality", f"{m.group(1)} doublons hash dans lessons", "monthly_review", "lessons_duplicates", "warning")
    log("  OK: monthly_review analyzed")

def check_quality_review():
    log("CHECK: quality_review")
    size = read_log_size("quality_review.log")
    if size <= 0:
        insert_alert("monitoring", "quality_review.py dead letter (0 bytes log). Verifier cron --dry-run.", "quality_review", "quality_review_dead", "warning")
    else:
        log(f"  OK: quality_review.log = {size} bytes")

def check_trivy():
    log("CHECK: trivy")
    lines = read_log_tail("trivy_scan.log", 5)
    if lines is None:
        insert_alert("monitoring", "trivy_scan.log introuvable", "trivy", "trivy_missing", "warning")
        return
    for line in lines:
        m = re.search(r"TRIVY CRITICAL: (\d+) CRITICAL", line)
        if m and int(m.group(1)) > TRIVY_CRITICAL_THRESHOLD:
            insert_alert("security", f"Trivy: {m.group(1)} CVE CRITICAL dans les images Docker", "trivy", "trivy_critical_high", "warning")
    log("  OK: trivy analyzed")

def check_pulse_sync():
    log("CHECK: pulse_sync")
    cron_lines = read_log_tail("pulse_sync_cron.log", 5)
    if cron_lines:
        for line in cron_lines:
            if "exit=1" in line:
                insert_alert("monitoring", "pulse_sync echoue (exit=1). Verifier script.", "pulse_sync", "pulse_sync_failing", "warning")
                break
    lines = read_log_tail("pulse_sync.log", 50)
    if lines:
        mismatches = sum(1 for l in lines if l.strip().startswith("!"))
        ghosts = sum(1 for l in lines if l.strip().startswith("?"))
        if mismatches > 0:
            insert_alert("data_quality", f"Pulse sync: {mismatches} status mismatches", "pulse_sync", "pulse_mismatches", "info")
        if ghosts > 5:
            insert_alert("data_quality", f"Pulse sync: {ghosts} ghosts sans correspondance Pulse", "pulse_sync", "pulse_ghosts", "info")
    log("  OK: pulse_sync analyzed")

def check_pulse_sync_cron_empty():
    log("CHECK: pulse_sync_cron")
    size = read_log_size("pulse_sync_cron.log")
    if size == 0:
        insert_alert("monitoring", "pulse_sync_cron.log vide (0 bytes)", "pulse_sync", "pulse_sync_cron_empty", "info")


def check_stale_ips():
    """Compare les IPs dans KB/lessons avec homelab_services (source de verite)."""
    log('CHECK: stale_ips')
    known = gateway_sql('SELECT DISTINCT ip FROM homelab_services WHERE ip IS NOT NULL')
    if not known:
        log('  SKIP: impossible de lire homelab_services')
        return
    known_ips = set(row.get("ip", "") for row in known)
    log(f'  IPs connues homelab_services: {len(known_ips)}')
    kb_ips_raw = gateway_sql("SELECT id, answer FROM knowledge_base WHERE answer LIKE '%192.168.2.%'")
    lesson_ips_raw = gateway_sql("SELECT id, lesson_text FROM lessons_learned WHERE lesson_text LIKE '%192.168.2.%' AND archived = false")
    ip_pattern = re.compile(r'192\.168\.2\.(\d{1,3})')
    stale_kb = set()
    stale_lesson = set()
    if kb_ips_raw:
        for row in kb_ips_raw:
            found_ips = set(f'192.168.2.{m}' for m in ip_pattern.findall(row.get('answer', '')))
            stale_kb |= found_ips - known_ips
    if lesson_ips_raw:
        for row in lesson_ips_raw:
            found_ips = set(f'192.168.2.{m}' for m in ip_pattern.findall(row.get('lesson_text', '')))
            stale_lesson |= found_ips - known_ips
    all_stale = stale_kb | stale_lesson
    if all_stale:
        ignore = {'192.168.2.0', '192.168.2.1', '192.168.2.255'}
        real_stale = all_stale - ignore
        if real_stale:
            ips_str = ', '.join(sorted(real_stale)[:10])
            insert_alert('data_quality', f'IPs orphelines dans KB/lessons (pas dans homelab_services): {ips_str}. {len(real_stale)} IPs inconnues.', 'ip_propagator', 'stale_ips_detected', 'warning')
        else:
            log('  OK: toutes les IPs connues ou ignorees')
    else:
        log('  OK: aucune IP orpheline')

def main():
    log("=== BRUCE Alert Dispatcher demarre ===")
    checks = [check_watchdog, check_monthly_review, check_quality_review, check_trivy, check_pulse_sync, check_pulse_sync_cron_empty, check_stale_ips]
    for check in checks:
        try:
            check()
        except Exception as e:
            log(f"  EXCEPTION in {check.__name__}: {e}")
    result = gateway_sql("SELECT count(*) as cnt FROM bruce_alert_outbox WHERE sent = false")
    pending = result[0].get("cnt", 0) if result and len(result) > 0 else "?"
    log(f"=== Dispatcher termine. Alertes pending: {pending} ===")

if __name__ == "__main__":
    main()