#!/usr/bin/env python3
import os
"""
bruce_ip_audit.py - Audit detaille des IPs orphelines dans KB/lessons/current_state
Usage: python3 bruce_ip_audit.py [--fix OLD_IP NEW_IP]

Sans args: genere un rapport detaille des IPs orphelines
Avec --fix: propose les corrections via staging_queue (dry-run par defaut, --apply pour executer)
"""
import json, re, sys, urllib.request

GATEWAY_URL = "http://192.168.2.230:4000"
GATEWAY_TOKEN = os.environ.get("BRUCE_AUTH_TOKEN", "")

def gateway_sql(sql):
    url = f"{GATEWAY_URL}/tools/supabase/exec-sql"
    headers = {"Authorization": f"Bearer {GATEWAY_TOKEN}", "Content-Type": "application/json"}
    body = json.dumps({"sql": sql}).encode()
    req = urllib.request.Request(url, data=body, headers=headers, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            data = json.loads(resp.read())
            return data.get("data", [])
    except Exception as e:
        print(f"ERROR: {e}")
        return []

def get_known_ips():
    rows = gateway_sql("SELECT DISTINCT ip, name FROM homelab_services WHERE ip IS NOT NULL")
    return {r["ip"]: r["name"] for r in rows} if rows else {}

def find_ip_references(ip, tables=None):
    """Trouve toutes les references a une IP dans KB, lessons, current_state."""
    if tables is None:
        tables = ["knowledge_base", "lessons_learned", "current_state"]
    results = {}
    for table in tables:
        if table == "knowledge_base":
            rows = gateway_sql(f"SELECT id, question, answer FROM knowledge_base WHERE answer LIKE '%{ip}%'")
            results[table] = [(r["id"], r.get("question","")[:60]) for r in (rows or [])]
        elif table == "lessons_learned":
            rows = gateway_sql(f"SELECT id, lesson_text FROM lessons_learned WHERE lesson_text LIKE '%{ip}%' AND archived = false")
            results[table] = [(r["id"], r.get("lesson_text","")[:60]) for r in (rows or [])]
        elif table == "current_state":
            rows = gateway_sql(f"SELECT key, value FROM current_state WHERE value LIKE '%{ip}%'")
            results[table] = [(r["key"], r.get("value","")[:60]) for r in (rows or [])]
    return results

def audit():
    known = get_known_ips()
    print(f"=== IPs connues dans homelab_services: {len(known)} ===")
    for ip in sorted(known.keys()):
        print(f"  {ip:18s} -> {known[ip]}")
    
    # Extraire toutes les IPs des 3 tables
    ip_pattern = re.compile(r'192\.168\.2\.(\d{1,3})')
    all_found_ips = set()
    
    for table, col in [("knowledge_base","answer"), ("lessons_learned","lesson_text"), ("current_state","value")]:
        where = f"AND archived = false" if table == "lessons_learned" else ""
        rows = gateway_sql(f"SELECT {col} FROM {table} WHERE {col} LIKE '%192.168.2.%' {where}")
        for r in (rows or []):
            for m in ip_pattern.findall(r.get(col, "")):
                all_found_ips.add(f"192.168.2.{m}")
    
    ignore = {"192.168.2.0", "192.168.2.1", "192.168.2.255"}
    orphans = sorted(all_found_ips - set(known.keys()) - ignore)
    
    if not orphans:
        print("\n=== Aucune IP orpheline detectee ===")
        return
    
    print(f"\n=== IPs ORPHELINES ({len(orphans)}) ===")
    for ip in orphans:
        print(f"\n--- {ip} ---")
        refs = find_ip_references(ip)
        total = sum(len(v) for v in refs.values())
        print(f"  Total references: {total}")
        for table, entries in refs.items():
            if entries:
                print(f"  [{table}]:")
                for eid, preview in entries:
                    print(f"    #{eid}: {preview}")

def fix(old_ip, new_ip, apply=False):
    print(f"=== Migration {old_ip} -> {new_ip} ===")
    refs = find_ip_references(old_ip)
    total = sum(len(v) for v in refs.values())
    print(f"References trouvees: {total}")
    
    if total == 0:
        print("Rien a corriger.")
        return
    
    if not apply:
        print("[DRY-RUN] Ajoutez --apply pour executer les corrections via staging/SQL")
        for table, entries in refs.items():
            for eid, preview in entries:
                print(f"  WOULD FIX [{table}] #{eid}: {old_ip} -> {new_ip}")
        return
    
    # Corrections effectives via gateway SQL
    fixed = 0
    for table, entries in refs.items():
        if table == "knowledge_base":
            for eid, _ in entries:
                gateway_sql(f"UPDATE knowledge_base SET answer = REPLACE(answer, '{old_ip}', '{new_ip}') WHERE id = {eid}")
                fixed += 1
        elif table == "lessons_learned":
            for eid, _ in entries:
                gateway_sql(f"UPDATE lessons_learned SET lesson_text = REPLACE(lesson_text, '{old_ip}', '{new_ip}') WHERE id = {eid}")
                fixed += 1
        elif table == "current_state":
            for key, _ in entries:
                gateway_sql(f"UPDATE current_state SET value = REPLACE(value, '{old_ip}', '{new_ip}') WHERE key = '{key}'")
                fixed += 1
    print(f"=== {fixed} corrections appliquees ===")

if __name__ == "__main__":
    if "--fix" in sys.argv:
        idx = sys.argv.index("--fix")
        if idx + 2 < len(sys.argv):
            old_ip = sys.argv[idx+1]
            new_ip = sys.argv[idx+2]
            apply = "--apply" in sys.argv
            fix(old_ip, new_ip, apply)
        else:
            print("Usage: --fix OLD_IP NEW_IP [--apply]")
    else:
        audit()