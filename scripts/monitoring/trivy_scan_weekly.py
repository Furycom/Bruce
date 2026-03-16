#!/usr/bin/env python3
"""
trivy_scan_weekly.py — Scan sécurité hebdomadaire images Docker
Hôtes: .230 (local), .146 (furycom), .32 (furycom), .174 (yann), .154 (yann)
Critiques → ntfy bruce-alerts | Rapports → ~/trivy_reports/
Session Code 176 — 2026-03-02
"""

import subprocess
import json
import os
import sys
import datetime
from urllib.request import Request, urlopen
from urllib.error import URLError

# ── Configuration ──────────────────────────────────────────────────────────────

TRIVY_BIN  = os.path.expanduser("~/bin/trivy")
REPORT_DIR = os.path.expanduser("~/trivy_reports")
NTFY_URL   = "http://192.168.2.174:8080/bruce-alerts"
NTFY_TOKEN = None  # pas de token requis sur ce ntfy interne

HOSTS = [
    {"name": "furymcp-230",  "ip": "local"},
    {"name": "furysupa-146", "ip": "192.168.2.146", "user": "furycom", "key": os.path.expanduser("~/.ssh/bruce_collect_ed25519")},
    {"name": "furyai-32",    "ip": "192.168.2.32",  "user": "furycom", "key": os.path.expanduser("~/.ssh/bruce_collect_ed25519")},
    {"name": "automation-174","ip": "192.168.2.174", "user": "yann",   "key": os.path.expanduser("~/.ssh/id_ed25519")},
    {"name": "observ-154",   "ip": "192.168.2.154", "user": "yann",    "key": os.path.expanduser("~/.ssh/id_ed25519")},
]

SKIP_IMAGES = {"<none>:<none>", "scratch:latest"}

# ── Helpers ─────────────────────────────────────────────────────────────────────

def log(msg):
    ts = datetime.datetime.now().strftime("%H:%M:%S")
    print(f"[{ts}] {msg}", flush=True)


def get_images_local():
    r = subprocess.run(
        ["docker", "images", "--format", "{{.Repository}}:{{.Tag}}"],
        capture_output=True, text=True, timeout=10
    )
    return [l.strip() for l in r.stdout.splitlines() if l.strip() and l.strip() not in SKIP_IMAGES and "<none>" not in l]


def get_images_remote(host):
    r = subprocess.run(
        ["ssh",
         "-o", "StrictHostKeyChecking=no",
         "-o", "ConnectTimeout=5",
         "-o", "BatchMode=yes",
         "-i", host["key"],
         f"{host['user']}@{host['ip']}",
         'docker images --format "{{.Repository}}:{{.Tag}}"'],
        capture_output=True, text=True, timeout=15
    )
    if r.returncode != 0:
        log(f"  ⚠ SSH {host['ip']} échoué: {r.stderr.strip()}")
        return []
    return [l.strip() for l in r.stdout.splitlines() if l.strip() and l.strip() not in SKIP_IMAGES and "<none>" not in l]


def scan_image_registry(image):
    """Scan depuis le registry (images publiques)."""
    r = subprocess.run(
        [TRIVY_BIN, "image",
         "--format", "json",
         "--severity", "CRITICAL,HIGH",
         "--timeout", "5m",
         "--quiet",
         "--no-progress",
         image],
        capture_output=True, text=True, timeout=400
    )
    if r.returncode not in (0, 1):
        return None, r.stderr.strip()
    try:
        return json.loads(r.stdout), None
    except Exception as e:
        return None, f"JSON parse error: {e}"


def scan_image_remote_save(image, host):
    """Pour images custom/locales sur hôte distant: docker save | trivy --input."""
    ssh_args = [
        "ssh", "-o", "StrictHostKeyChecking=no",
        "-o", "BatchMode=yes",
        "-i", host["key"],
        f"{host['user']}@{host['ip']}",
        f"docker save '{image}'"
    ]
    trivy_args = [
        TRIVY_BIN, "image",
        "--format", "json",
        "--severity", "CRITICAL,HIGH",
        "--quiet", "--no-progress",
        "--input", "-"
    ]
    try:
        p1 = subprocess.Popen(ssh_args, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        p2 = subprocess.Popen(trivy_args, stdin=p1.stdout, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        p1.stdout.close()
        out, _ = p2.communicate(timeout=300)
        p1.wait()
        data = json.loads(out.decode())
        return data, None
    except Exception as e:
        return None, str(e)


def scan_image_local_save(image):
    """Pour images custom locales sur .230."""
    p1 = subprocess.Popen(
        ["docker", "save", image],
        stdout=subprocess.PIPE, stderr=subprocess.PIPE
    )
    p2 = subprocess.Popen(
        [TRIVY_BIN, "image", "--format", "json",
         "--severity", "CRITICAL,HIGH",
         "--quiet", "--no-progress", "--input", "-"],
        stdin=p1.stdout, stdout=subprocess.PIPE, stderr=subprocess.PIPE
    )
    p1.stdout.close()
    try:
        out, _ = p2.communicate(timeout=300)
        p1.wait()
        return json.loads(out.decode()), None
    except Exception as e:
        return None, str(e)


def count_by_severity(data):
    counts = {"CRITICAL": 0, "HIGH": 0}
    if not data:
        return counts
    for result in data.get("Results", []):
        for v in result.get("Vulnerabilities") or []:
            sev = v.get("Severity", "")
            if sev in counts:
                counts[sev] += 1
    return counts


def is_public_image(image):
    """Heuristique: image publique si contient un domaine ou slash."""
    name = image.split(":")[0]
    # ghcr.io/..., lscr.io/..., docker.io/..., prom/..., etc.
    return "/" in name or "." in name.split("/")[0]


def send_ntfy(title, body, priority="high"):
    try:
        req = Request(NTFY_URL, data=body.encode(), method="POST")
        req.add_header("Title", title.encode("utf-8").decode("latin-1", errors="replace"))
        req.add_header("Priority", priority)
        req.add_header("Tags", "warning,docker,security")
        with urlopen(req, timeout=10):
            pass
        log(f"  📱 ntfy envoyé: {title}")
    except URLError as e:
        log(f"  ⚠ ntfy échoué: {e}")


# ── Main ────────────────────────────────────────────────────────────────────────

def main():
    os.makedirs(REPORT_DIR, exist_ok=True)
    now = datetime.datetime.now()
    date_str = now.strftime("%Y-%m-%d")
    report_path = os.path.join(REPORT_DIR, f"trivy_{date_str}.json")

    log("=== Trivy Scan hebdomadaire démarré ===")
    log(f"Date: {now.isoformat()}")

    # 1. Collecter toutes les images par hôte
    all_images = {}  # image -> [hôtes]
    for host in HOSTS:
        if host["ip"] == "local":
            images = get_images_local()
            host_name = host["name"]
        else:
            images = get_images_remote(host)
            host_name = host["name"]
        log(f"{host_name}: {len(images)} images")
        for img in images:
            all_images.setdefault(img, []).append(host)

    log(f"\nTotal images uniques: {len(all_images)}")

    # 2. Scanner chaque image unique
    scan_results = []
    total_critical = 0
    total_high = 0
    critical_images = []

    for image, hosts in sorted(all_images.items()):
        log(f"\n→ Scan: {image}")
        data = None
        err = None

        if is_public_image(image):
            data, err = scan_image_registry(image)
            if err and "MANIFEST_UNKNOWN" in err or (err and "not found" in err.lower()):
                # Image publique mais pas trouvée dans registry → essayer local save
                local_hosts = [h for h in hosts if h["ip"] == "local"]
                if local_hosts:
                    data, err = scan_image_local_save(image)
        else:
            # Image custom locale
            local_hosts = [h for h in hosts if h["ip"] == "local"]
            remote_hosts = [h for h in hosts if h["ip"] != "local"]
            if local_hosts:
                data, err = scan_image_local_save(image)
            elif remote_hosts:
                data, err = scan_image_remote_save(image, remote_hosts[0])

        if err and data is None:
            log(f"  ✗ Erreur: {err[:80]}")
            scan_results.append({"image": image, "hosts": [h.get("name", h.get("ip")) for h in hosts], "error": err, "CRITICAL": 0, "HIGH": 0})
            continue

        counts = count_by_severity(data)
        total_critical += counts["CRITICAL"]
        total_high += counts["HIGH"]

        marker = ""
        if counts["CRITICAL"] > 0:
            marker = " 🔴 CRITICAL"
            critical_images.append({"image": image, "critical": counts["CRITICAL"], "high": counts["HIGH"]})
        elif counts["HIGH"] > 0:
            marker = " 🟠 HIGH"

        log(f"  CRITICAL={counts['CRITICAL']} HIGH={counts['HIGH']}{marker}")
        scan_results.append({
            "image": image,
            "hosts": [h.get("name", h.get("ip")) for h in hosts],
            "CRITICAL": counts["CRITICAL"],
            "HIGH": counts["HIGH"],
            "results": data.get("Results", []) if data else []
        })

    # 3. Rapport JSON
    report = {
        "scan_date": now.isoformat(),
        "summary": {
            "total_images": len(all_images),
            "total_critical": total_critical,
            "total_high": total_high,
            "critical_images_count": len(critical_images)
        },
        "critical_images": critical_images,
        "details": scan_results
    }
    with open(report_path, "w") as f:
        json.dump(report, f, indent=2)
    log(f"\nRapport sauvegardé: {report_path}")

    # 4. Résumé
    log(f"\n{'='*50}")
    log(f"RÉSUMÉ: {len(all_images)} images | CRITICAL={total_critical} | HIGH={total_high}")
    if critical_images:
        log("Images critiques:")
        for ci in critical_images:
            log(f"  🔴 {ci['image']} — {ci['critical']} CRITICAL, {ci['high']} HIGH")

    # 5. Notification ntfy si critiques
    if total_critical > 0:
        body_lines = [f"🔴 {total_critical} vulnérabilités CRITIQUES détectées ({total_high} HIGH)", ""]
        for ci in critical_images[:5]:
            body_lines.append(f"• {ci['image']}: {ci['critical']} CRIT, {ci['high']} HIGH")
        if len(critical_images) > 5:
            body_lines.append(f"... et {len(critical_images)-5} autres")
        body_lines.append(f"\nRapport: {report_path}")
        send_ntfy(f"TRIVY CRITICAL: {total_critical} CRITICAL ({date_str})", "\n".join(body_lines), "urgent")
    elif total_high > 0:
        send_ntfy(f"TRIVY HIGH: {total_high} HIGH ({date_str})",
                  f"{total_high} vulnérabilités HIGH sur {len(all_images)} images. Aucun CRITICAL.", "high")
    else:
        log("✅ Aucune vulnérabilité CRITICAL ou HIGH détectée.")

    log("=== Scan terminé ===")
    return 0 if total_critical == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
