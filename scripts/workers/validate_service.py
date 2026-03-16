#!/usr/bin/env python3
import os
"""
validate_service.py — Micro-service HTTP sur port 4001
Expose: POST /run/validate  -> conflict_detector --scan + validate --auto
        GET  /run/status    -> staging_queue counts
        GET  /health        -> ok
"""
import http.server, json, subprocess, urllib.request, os, sys

PORT = 4001
SUPABASE = "http://192.168.2.146:8000/rest/v1"
APIKEY = os.environ.get("SUPABASE_KEY", "")
TOKEN = os.environ.get("BRUCE_AUTH_TOKEN", "")
SCRIPTS = "/home/furycom"

def sb_get(path):
    req = urllib.request.Request(f"{SUPABASE}/{path}",
        headers={"apikey": APIKEY, "Authorization": f"Bearer {APIKEY}", "Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=10) as r:
        return json.loads(r.read())

def run_script(script, *args):
    try:
        r = subprocess.run(
            [sys.executable, f"{SCRIPTS}/{script}"] + list(args),
            capture_output=True, text=True, timeout=60, cwd=SCRIPTS
        )
        return {"exit": r.returncode, "stdout": r.stdout[-800:], "stderr": r.stderr[-400:]}
    except Exception as e:
        return {"exit": -1, "stdout": "", "stderr": str(e)}

class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        print(f"[validate_service] {fmt % args}", flush=True)

    def send_json(self, code, data):
        body = json.dumps(data, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", len(body))
        self.end_headers()
        self.wfile.write(body)

    def check_auth(self):
        return self.headers.get("X-BRUCE-TOKEN") == TOKEN

    def do_GET(self):
        if self.path == "/health":
            self.send_json(200, {"ok": True, "service": "validate_service", "port": PORT})
        elif self.path == "/run/status":
            if not self.check_auth():
                return self.send_json(401, {"error": "unauthorized"})
            try:
                rows = sb_get("staging_queue?select=status&limit=500")
                counts = {}
                for r in rows:
                    counts[r["status"]] = counts.get(r["status"], 0) + 1
                self.send_json(200, {"ok": True, "total": len(rows), "counts": counts})
            except Exception as e:
                self.send_json(500, {"ok": False, "error": str(e)})
        else:
            self.send_json(404, {"error": "not found"})

    def do_POST(self):
        if self.path == "/run/validate":
            if not self.check_auth():
                return self.send_json(401, {"error": "unauthorized"})
            detector = run_script("conflict_detector.py", "--scan")
            validate  = run_script("validate.py", "--auto")
            ok = detector["exit"] == 0 and validate["exit"] == 0
            self.send_json(200, {"ok": ok, "detector": detector, "validate": validate})
        else:
            self.send_json(404, {"error": "not found"})

if __name__ == "__main__":
    import socketserver
    socketserver.TCPServer.allow_reuse_address = True
    with socketserver.TCPServer(("0.0.0.0", PORT), Handler) as srv:
        print(f"validate_service listening on :{PORT}", flush=True)
        srv.serve_forever()
