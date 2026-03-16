#!/usr/bin/env python3
import os
"""
sync_homelab_hub.py - Synchronise homelab_services Supabase -> Homelab Hub API
Déployé sur .230 - appelé par n8n workflow
"""

import requests
import json
import sys

SUPABASE_URL = "http://192.168.2.146:8000/rest/v1"
SUPABASE_KEY = os.environ.get("SUPABASE_KEY", "")
HUB_URL = "http://192.168.2.113:8050"

SUPABASE_HEADERS = {
    "apikey": SUPABASE_KEY,
    "Authorization": f"Bearer {SUPABASE_KEY}",
    "Accept": "application/json"
}

def get_supabase_services():
    r = requests.get(f"{SUPABASE_URL}/homelab_services?order=id.asc", headers=SUPABASE_HEADERS)
    r.raise_for_status()
    return r.json()

def get_hub_apps():
    r = requests.get(f"{HUB_URL}/api/apps")
    r.raise_for_status()
    return r.json().get("data", [])

def delete_hub_app(app_id):
    r = requests.delete(f"{HUB_URL}/api/apps/{app_id}")
    return r.status_code == 200

def create_hub_app(service):
    """Convertit un service Supabase en app Homelab Hub"""
    url = service.get("url") or ""
    https = url.startswith("https://")
    
    payload = {
        "name": service.get("name", ""),
        "description": service.get("role", ""),
        "hostname": service.get("host") or service.get("ip") or "",
        "ip_address": service.get("ip") or "",
        "port": service.get("port"),
        "https": https,
        "notes": f"category:{service.get('category','')}" + (f" | {service.get('notes','')}" if service.get("notes") else "")
    }
    
    r = requests.post(f"{HUB_URL}/api/apps", json=payload)
    return r.status_code == 201, r.json()

def main():
    print("=== Sync Supabase homelab_services -> Homelab Hub ===")
    
    # 1. Récupérer services Supabase
    services = get_supabase_services()
    print(f"Services Supabase: {len(services)}")
    
    # 2. Vider les apps Hub existantes (full resync)
    hub_apps = get_hub_apps()
    print(f"Apps Hub actuelles: {len(hub_apps)}")
    for app in hub_apps:
        delete_hub_app(app["id"])
    print(f"Apps Hub supprimées: {len(hub_apps)}")
    
    # 3. Insérer tous les services Supabase
    created = 0
    errors = 0
    for svc in services:
        ok, result = create_hub_app(svc)
        if ok:
            created += 1
        else:
            errors += 1
            print(f"  ERREUR {svc.get('name')}: {result}")
    
    print(f"\nRésultat: {created} créés, {errors} erreurs")
    print("Sync terminée ✓")

if __name__ == "__main__":
    main()
