#!/usr/bin/env python3
"""
bruce_ingest.py — Pipeline ingestion BRUCE v2.0
Architecture: Fichier → Unstructured → TopicSplitter → vLLM → BGE → Supabase staging

Usage:
  python3 bruce_ingest.py <fichier.txt> [--dry-run] [--source "description"]
  python3 bruce_ingest.py /path/to/conversation.txt --source "ChatGPT - BRUCE x HA"

Composants:
  1. UnstructuredCleaner   — nettoie le document brut
  2. TopicSplitter         — découpe par sujet (fenêtre de 1500 tokens ~)
  3. VLLMExtractor         — extrait lessons/KB/decisions structurées via vLLM
  4. BGEEmbedder           — génère embeddings via BGE local
  5. SupabaseWriter        — pousse vers staging_queue (jamais écriture directe)

Auteur: Claude Opus session-opus2 (2026-02-21)
"""

import argparse
import hashlib
import json
import re
import sys
import time
import uuid
from datetime import datetime
from pathlib import Path
from difflib import SequenceMatcher
from typing import Any

import requests

# ─── INSTRUCTOR + PYDANTIC MODELS ────────────────────────────────────────────
try:
    import instructor
    from pydantic import BaseModel, Field
    INSTRUCTOR_AVAILABLE = True
except ImportError:
    INSTRUCTOR_AVAILABLE = False
    print("  [Instructor] Non disponible — fallback JSON manuel")

if INSTRUCTOR_AVAILABLE:
    class LessonItem(BaseModel):
        lesson_type: str = Field(description="architecture|decision|diagnostic|warning|solution|process")
        lesson_text: str = Field(description="Leçon complète et autonome en français (min 80 chars, concrète et spécifique)")
        importance: str = Field(description="critical|normal")
        confidence_score: float = Field(default=0.7, ge=0.0, le=1.0)

    class KBItem(BaseModel):
        question: str = Field(description="Sujet ou question précise en français")
        answer: str = Field(description="Réponse technique complète et réutilisable (min 60 chars)")
        category: str = Field(description="docker|infrastructure|architecture|runbook|workflow|services|tools|ssh|configuration|debugging|solution-validee|pipeline|api|governance")
        subcategory: str = Field(description="Sous-catégorie précise (ex: compose, networking, proxmox, backup, monitoring, zigbee, mqtt, ha-automation, prompt-engineering, gateway, embedding, n8n, grafana, loki)")
        tags: list[str] = Field(default_factory=list)

    class DecisionItem(BaseModel):
        decision_text: str = Field(description="Décision explicite prise (min 30 chars)")
        rationale: str = Field(description="Raison concrète de cette décision")
        importance: str = Field(description="critical|normal")

    class WishItem(BaseModel):
        wish_text: str = Field(description="Désir ou souhait de Yann (min 60 chars)")
        importance: str = Field(description="critical|normal")
        tags: list[str] = Field(default_factory=list)

    class ProfileItem(BaseModel):
        trait: str = Field(description="nom_du_trait (ex: style_travail, preference_outil)")
        value: str = Field(description="valeur observée")
        category: str = Field(description="preference|style|skill|goal|value")

    class DiscoveryItem(BaseModel):
        question: str = Field(description="Technologie ou service que Yann explorait")
        answer: str = Field(description="Ce qu'il en pensait, pourquoi ça l'intéressait (min 80 chars)")
        category: str = Field(description="infrastructure|tools|architecture|services|workflow|docker|automation")
        tags: list[str] = Field(default_factory=list)

    class QAItem(BaseModel):
        question: str = Field(description="Question posée par Yann ou sujet discuté (min 20 chars)")
        answer: str = Field(description="Réponse complète donnée par le LLM (min 40 chars)")
        category: str = Field(description="conversation-qa")
        tags: list[str] = Field(default_factory=list)

    class ExtractionResult(BaseModel):
        lessons: list[LessonItem] = Field(default_factory=list)
        knowledge_base: list[KBItem] = Field(default_factory=list)
        decisions: list[DecisionItem] = Field(default_factory=list)
        wishes: list[WishItem] = Field(default_factory=list)
        user_profile: list[ProfileItem] = Field(default_factory=list)
        conversation_qa: list[QAItem] = Field(default_factory=list)
        chunk_summary: str = Field(description="Résumé en 1-2 phrases")

    class ArchiveExtractionResult(BaseModel):
        wishes: list[WishItem] = Field(default_factory=list)
        user_profile: list[ProfileItem] = Field(default_factory=list)
        discoveries: list[DiscoveryItem] = Field(default_factory=list)
        chunk_summary: str = Field(description="Résumé en 1-2 phrases de l'archive")

# ─── CONFIG ───────────────────────────────────────────────────────────────────
SUPABASE_URL = "http://192.168.2.146:8000/rest/v1"
SUPABASE_KEY = (
    os.environ.get("SUPABASE_KEY", "")
    ".cCJJYdmcVWOV-qTZ8EW3NvqJKhAhvJ4GkWZCyfWyYEg"
)
VLLM_URL = "http://192.168.2.230:4100/v1"  # [731] Route via LiteLLM for Langfuse tracing
VLLM_API_KEY = "bruce-litellm-key-01"  # [731] LiteLLM auth
GATEWAY_URL = "http://192.168.2.230:4000"
GATEWAY_TOKEN = os.environ.get("BRUCE_AUTH_TOKEN", "")
BGE_MODEL = "BAAI/bge-m3"
CHUNK_SIZE = 1500          # tokens approximatifs (~6000 chars)
CHUNK_OVERLAP = 200
AUTHOR_SYSTEM = "bruce-ingest-v2"

# --- SUBCATEGORY FALLBACK [SESSION-1231] ------------------------------------------
SUBCATEGORY_DEFAULTS = {
    "docker": "compose",
    "infrastructure": "proxmox",
    "architecture": "design",
    "runbook": "procedure",
    "workflow": "automation",
    "services": "deployment",
    "tools": "cli",
    "ssh": "ssh-config",
    "configuration": "config-file",
    "debugging": "diagnostic",
    "solution-validee": "fix",
    "pipeline": "ingestion",
    "api": "api-gateway",
    "governance": "policy",
    "conversation-qa": "general",
}

SUBCATEGORY_KEYWORDS = {
    "compose": ["docker-compose", "compose", "docker compose", "service:", "volumes:", "ports:"],
    "networking": ["proxy", "traefik", "nginx", "port", "reverse proxy", "dns", "ip", "vlan", "firewall"],
    "proxmox": ["proxmox", "vm ", "lxc", "ct ", "qemu", "pve", "box1", "box2"],
    "backup": ["backup", "sauvegarde", "restore", "snapshot", "borg", "rsync"],
    "monitoring": ["grafana", "loki", "prometheus", "alert", "dashboard", "monitoring", "observability"],
    "zigbee": ["zigbee", "z2m", "zigbee2mqtt", "capteur", "sensor"],
    "mqtt": ["mqtt", "mosquitto", "broker", "topic", "publish", "subscribe"],
    "ha-automation": ["home assistant", "ha ", "automation", "blueprint", "trigger", "action"],
    "prompt-engineering": ["prompt", "few-shot", "instruction", "system prompt", "dspy"],
    "gateway": ["gateway", "bruce_gateway", "4000", "route", "endpoint"],
    "embedding": ["embedding", "bge", "vector", "embed", "similarity", "cosine"],
    "n8n": ["n8n", "workflow", "webhook", "node ", "automation n8n"],
    "grafana": ["grafana", "dashboard", "panel", "datasource"],
    "loki": ["loki", "logql", "log ", "logging"],
    "vllm": ["vllm", "llm", "qwen", "model", "inference", "token", "gpu", "vram"],
    "supabase": ["supabase", "postgres", "table", "rpc", "staging_queue", "rest api"],
    "docker-compose": ["docker-compose", "compose file", "docker compose"],
    "ssh-config": ["ssh", ".ssh", "authorized_keys", "identity", "key", "scp"],
    "api-gateway": ["api", "rest", "endpoint", "/v1", "bearer", "token"],
    "validation": ["validate", "validation", "gate-1", "gate-2", "staging", "promote"],
    "ingestion": ["ingest", "ingestion", "pipeline", "extract", "chunk"],
    "llm-config": ["temperature", "max_tokens", "model", "llm", "parallel"],
    "mcp-server": ["mcp", "tool", "claude code", "desktop commander"],
    "traefik": ["traefik", "reverse proxy", "label", "router", "middleware"],
    "postgres": ["postgres", "sql", "table", "index", "query", "rpc", "trigger"],
}


def infer_subcategory(category: str, text: str) -> str:
    """
    Inf\u00e8re la subcategory depuis category + contenu textuel.
    Utilis\u00e9 comme fallback quand le LLM ne g\u00e9n\u00e8re pas subcategory.
    """
    text_lower = text.lower()
    best_match = None
    best_score = 0
    for subcat, keywords in SUBCATEGORY_KEYWORDS.items():
        score = sum(1 for kw in keywords if kw.lower() in text_lower)
        if score > best_score:
            best_score = score
            best_match = subcat
    if best_match and best_score >= 1:
        return best_match
    return SUBCATEGORY_DEFAULTS.get(category, "general")



# ─── BEST-OF-N FUSION [OPUS-104] ─────────────────────────────────────────────
DEFAULT_BON_TEMPERATURES = [0.3, 0.5, 0.7]
BON_DEDUP_THRESHOLD = 0.6
BON_CONSENSUS_BOOST = 1.1

def _bon_similar(a, b, t=BON_DEDUP_THRESHOLD):
    return SequenceMatcher(None, a.lower().strip(), b.lower().strip()).ratio() >= t

def _bon_match(text, items, key):
    for i, ex in enumerate(items):
        if _bon_similar(text, ex.get(key, "")):
            return i
    return -1

def bon_fuse_lessons(exts):
    fused = []
    for ext in exts:
        for ls in ext.get("lessons", []):
            txt = ls.get("lesson_text", "")
            if len(txt) < 30:
                continue
            mi = _bon_match(txt, [f["d"] for f in fused], "lesson_text")
            if mi >= 0:
                fused[mi]["n"] += 1
                if ls.get("importance") == "critical":
                    fused[mi]["cv"] += 1
                if len(txt) > len(fused[mi]["d"]["lesson_text"]):
                    fused[mi]["d"] = dict(ls)
            else:
                fused.append({"d": dict(ls), "n": 1, "cv": 1 if ls.get("importance") == "critical" else 0})
    result = []
    for item in fused:
        d = item["d"]
        if item["cv"] >= 2:
            d["importance"] = "critical"
        elif item["cv"] == 0:
            d["importance"] = "normal"
        if item["n"] >= 2:
            d["confidence_score"] = min(1.0, d.get("confidence_score", 0.7) * BON_CONSENSUS_BOOST)
        result.append(d)
    return result

def bon_fuse_kb(exts):
    fused = []
    for ext in exts:
        for kb in ext.get("knowledge_base", []):
            ans = kb.get("answer", "")
            if len(ans) < 50:
                continue
            mi = _bon_match(ans, [f["d"] for f in fused], "answer")
            if mi >= 0:
                existing = fused[mi]["d"]
                if len(ans) > len(existing.get("answer", "")):
                    old_tags = existing.get("tags", [])
                    fused[mi]["d"] = dict(kb)
                    fused[mi]["d"]["tags"] = list(set(old_tags + kb.get("tags", [])))[:5]
                else:
                    existing["tags"] = list(set(existing.get("tags", []) + kb.get("tags", [])))[:5]
            else:
                fused.append({"d": dict(kb)})
    return [f["d"] for f in fused]

def bon_fuse_decisions(exts):
    fused = []
    for ext in exts:
        for dec in ext.get("decisions", []):
            txt = dec.get("decision_text", "")
            if len(txt) < 20:
                continue
            mi = _bon_match(txt, [f["d"] for f in fused], "decision_text")
            if mi >= 0:
                fused[mi]["n"] += 1
                if dec.get("importance") == "critical":
                    fused[mi]["cv"] += 1
                if len(dec.get("rationale", "")) > len(fused[mi]["d"].get("rationale", "")):
                    fused[mi]["d"] = dict(dec)
            else:
                fused.append({"d": dict(dec), "n": 1, "cv": 1 if dec.get("importance") == "critical" else 0})
    result = []
    for item in fused:
        d = item["d"]
        if item["cv"] >= 2:
            d["importance"] = "critical"
        elif item["cv"] == 0:
            d["importance"] = "normal"
        result.append(d)
    return result

def bon_fuse_archive(exts):
    wishes, profile, discoveries = [], [], []
    for ext in exts:
        for w in ext.get("wishes", []):
            txt = w.get("wish_text", "")
            if len(txt) < 30:
                continue
            mi = _bon_match(txt, wishes, "wish_text")
            if mi >= 0:
                if len(txt) > len(wishes[mi].get("wish_text", "")):
                    wishes[mi] = dict(w)
            else:
                wishes.append(dict(w))
    seen = set()
    for ext in exts:
        for tr in ext.get("user_profile", []):
            k = (tr.get("trait", "") + ":" + tr.get("value", "")).lower()
            if k not in seen:
                seen.add(k)
                profile.append(dict(tr))
    for ext in exts:
        for dc in ext.get("discoveries", []):
            ans = dc.get("answer", "")
            if len(ans) < 50:
                continue
            mi = _bon_match(ans, discoveries, "answer")
            if mi >= 0:
                if len(ans) > len(discoveries[mi].get("answer", "")):
                    discoveries[mi] = dict(dc)
            else:
                discoveries.append(dict(dc))
    sums = [e.get("chunk_summary", "") for e in exts if e.get("chunk_summary")]
    return {"wishes": wishes, "user_profile": profile, "discoveries": discoveries,
            "chunk_summary": max(sums, key=len) if sums else ""}

def bon_fuse_normal(exts):
    sums = [e.get("chunk_summary", "") for e in exts if e.get("chunk_summary")]
    return {"lessons": bon_fuse_lessons(exts), "knowledge_base": bon_fuse_kb(exts),
            "decisions": bon_fuse_decisions(exts),
            "chunk_summary": max(sums, key=len) if sums else ""}

def best_of_n_extract(chunk, source, extract_fn, temperatures=None, archive_mode=False, dry_run=False):
    """Best-of-N orchestrator: N extractions at different temperatures, fused."""
    if dry_run:
        return extract_fn(chunk, source, dry_run=True, archive_mode=archive_mode)
    temps = temperatures or DEFAULT_BON_TEMPERATURES
    n = len(temps)
    ci = chunk["chunk_index"] + 1
    ct = chunk["total_chunks"]
    print(f"    [Best-of-{n}] Chunk {ci}/{ct}: temperatures {temps}")
    exts = []
    fails = 0
    for temp in temps:
        try:
            r = extract_fn(chunk, source, dry_run=False, archive_mode=archive_mode, _override_temperature=temp)
            if r.get("_failed"):
                fails += 1
                print(f"    [Best-of-{n}] T={temp} FAILED")
            else:
                exts.append(r)
                if archive_mode:
                    ni = len(r.get("wishes",[])) + len(r.get("user_profile",[])) + len(r.get("discoveries",[]))
                else:
                    ni = len(r.get("lessons",[])) + len(r.get("knowledge_base",[])) + len(r.get("decisions",[]))
                print(f"    [Best-of-{n}] T={temp} -> {ni} items")
        except Exception as e:
            fails += 1
            print(f"    [Best-of-{n}] T={temp} EXCEPTION: {e}")
    if not exts:
        print(f"    [Best-of-{n}] ALL {n} failed!")
        return {"lessons": [], "knowledge_base": [], "decisions": [],
                "chunk_summary": "Best-of-N: all failed", "_failed": True}
    fused = bon_fuse_archive(exts) if archive_mode else bon_fuse_normal(exts)
    if archive_mode:
        nw = len(fused.get("wishes",[])); np2 = len(fused.get("user_profile",[])); nd = len(fused.get("discoveries",[]))
        raw = sum(len(e.get("wishes",[])) + len(e.get("user_profile",[])) + len(e.get("discoveries",[])) for e in exts)
        print(f"    [Best-of-{n}] FUSED: {nw}w+{np2}p+{nd}d (raw={raw}, ok={len(exts)}, fail={fails})")
    else:
        nl = len(fused.get("lessons",[])); nk = len(fused.get("knowledge_base",[])); ndc = len(fused.get("decisions",[]))
        raw = sum(len(e.get("lessons",[])) + len(e.get("knowledge_base",[])) + len(e.get("decisions",[])) for e in exts)
        print(f"    [Best-of-{n}] FUSED: {nl}l+{nk}kb+{ndc}d (raw={raw}, ok={len(exts)}, fail={fails})")
    return fused
# ─── END BEST-OF-N [OPUS-104] ────────────────────────────────────────────────


# ─── GAP DETECTION [423 Phase C] ─────────────────────────────────────────────
def fetch_existing_extractions(session_id: int) -> dict:
    """
    Récupère les lessons/KB déjà extraites pour cette session.
    Retourne {"lessons": [texts], "kb": [texts], "decisions": [texts]}
    """
    existing = {"lessons": [], "kb": [], "decisions": []}
    try:
        # Lessons de cette session
        resp = requests.get(
            f"{SUPABASE_URL}/lessons_learned",
            headers={**SUPABASE_HEADERS, "Prefer": ""},
            params={"session_id": f"eq.{session_id}", "select": "lesson_text,lesson_type"},
            timeout=10,
        )
        if resp.ok:
            for row in resp.json():
                text = row.get("lesson_text", "")
                ltype = row.get("lesson_type", "")
                if "decision" in ltype.lower():
                    existing["decisions"].append(text)
                else:
                    existing["lessons"].append(text)
        
        # KB de cette session
        resp2 = requests.get(
            f"{SUPABASE_URL}/knowledge_base",
            headers={**SUPABASE_HEADERS, "Prefer": ""},
            params={"session_id": f"eq.{session_id}", "select": "answer"},
            timeout=10,
        )
        if resp2.ok:
            for row in resp2.json():
                existing["kb"].append(row.get("answer", ""))
        
        total = sum(len(v) for v in existing.values())
        print(f"  [GapDetect] Session {session_id}: {total} extractions existantes "
              f"({len(existing['lessons'])} lessons, {len(existing['kb'])} KB, "
              f"{len(existing['decisions'])} decisions)")
        return existing
    except Exception as e:
        print(f"  [GapDetect] ERREUR fetch existing: {e}")
        return existing


def is_duplicate(new_text: str, existing_texts: list[str], threshold: float = 0.6) -> bool:
    """
    Vérifie si new_text est un doublon sémantique d'un texte existant.
    Utilise SequenceMatcher (ratio de similarité).
    threshold=0.6 = assez permissif pour attraper les reformulations.
    """
    new_lower = new_text.lower().strip()
    for existing in existing_texts:
        ratio = SequenceMatcher(None, new_lower, existing.lower().strip()).ratio()
        if ratio >= threshold:
            return True
    return False



SUPABASE_HEADERS = {
    "apikey": SUPABASE_KEY,
    "Authorization": f"Bearer {SUPABASE_KEY}",
    "Content-Type": "application/json",
    "Prefer": "return=representation",
}


# ─── COMPOSANT 1 : UnstructuredCleaner ───────────────────────────────────────
def unstructured_clean(file_path: Path) -> str:
    """
    Nettoie le document avec la bibliothèque unstructured.
    Supprime: tours de parole ChatGPT, markdown brut, métadonnées.
    Fallback: lecture directe si unstructured non disponible.
    """
    try:
        from unstructured.partition.text import partition_text
        from unstructured.partition.auto import partition
        elements = partition(filename=str(file_path))
        # Garder uniquement NarrativeText et Title
        kept = []
        for el in elements:
            el_type = type(el).__name__
            text = str(el).strip()
            if not text:
                continue
            # Supprimer tours de parole ChatGPT
            if re.match(r'^(ChatGPT said:|You said:|Claude said:)', text):
                # Garder le contenu après le préfixe
                text = re.sub(r'^(ChatGPT said:|You said:|Claude said:)\s*', '', text).strip()
            if text and len(text) > 30:
                kept.append(text)
        cleaned = "\n\n".join(kept)
        print(f"  [UnstructuredCleaner] {len(elements)} éléments → {len(kept)} gardés ({len(cleaned)} chars)")
        return cleaned
    except ImportError:
        print("  [UnstructuredCleaner] FALLBACK: lecture directe (unstructured non dispo)")
        return fallback_clean(file_path)
    except Exception as e:
        print(f"  [UnstructuredCleaner] ERREUR: {e} → fallback")
        return fallback_clean(file_path)


def fallback_clean(file_path: Path) -> str:
    """Nettoyage basique sans unstructured."""
    text = file_path.read_text(encoding="utf-8", errors="replace")
    # Supprimer tours de parole
    lines = []
    for line in text.split("\n"):
        line = line.strip()
        if not line:
            continue
        # Supprimer lignes purement de navigation/UI
        if re.match(r'^(ChatGPT said:|You said:|Claude said:)', line):
            remainder = re.sub(r'^(ChatGPT said:|You said:|Claude said:)\s*', '', line).strip()
            if remainder:
                lines.append(remainder)
        else:
            lines.append(line)
    return "\n\n".join(lines)


# ─── COMPOSANT 2 : TopicSplitter ─────────────────────────────────────────────
# Frontières conversationnelles détectées avant fallback taille (v2)
CONV_BOUNDARY_RE = re.compile(
    r'^(You said:|ChatGPT said:|Human:|Assistant:|Claude said:|Claude:|User:)\s*$',
    re.MULTILINE | re.IGNORECASE
)
# Groupes de tours de parole à fusionner (question + réponse = 1 chunk)
SPEAKER_RE = re.compile(
    r'^(You said:|ChatGPT said:|Human:|Assistant:|Claude said:|Claude:|User:)',
    re.IGNORECASE | re.MULTILINE
)

def _split_conversational(text: str) -> list[str]:
    """
    Détecte les tours de parole et regroupe question+réponse en unités cohérentes.
    Retourne une liste de blocs, chacun = 1 échange ou 1 thème.
    """
    lines = text.split("\n")
    segments = []
    current_lines = []
    speaker_count = 0

    for line in lines:
        if SPEAKER_RE.match(line.strip()):
            speaker_count += 1
            # Regrouper par paires (question + réponse = 1 unité)
            # Flush tous les 2 tours de parole pour garder cohérence
            if speaker_count > 1 and speaker_count % 2 == 1 and current_lines:
                block = "\n".join(current_lines).strip()
                if len(block) > 50:
                    segments.append(block)
                current_lines = []
        current_lines.append(line)

    # Dernier bloc
    if current_lines:
        block = "\n".join(current_lines).strip()
        if len(block) > 50:
            segments.append(block)

    return segments if segments else None


def topic_split(text: str, chunk_size_chars: int = 6000, overlap_chars: int = 400) -> list[dict]:
    """
    Découpe le texte en chunks par sujet — v2.
    Stratégie 1 (priorité): frontières conversationnelles (You said:/ChatGPT said:)
    Stratégie 2 (fallback): paragraphes → regrouper jusqu'à chunk_size_chars.
    """
    # Détecter si c'est une conversation avec tours de parole
    conv_count = len(SPEAKER_RE.findall(text))
    use_conv_split = conv_count >= 4  # au moins 2 échanges complets

    if use_conv_split:
        print(f"  [TopicSplitter] Mode CONVERSATIONNEL détecté ({conv_count} tours de parole)")
        segments = _split_conversational(text)
        if segments:
            # Fusionner les segments trop courts avec le suivant
            merged = []
            buffer = ""
            for seg in segments:
                if len(buffer) + len(seg) < chunk_size_chars:
                    buffer = (buffer + "\n\n" + seg).strip() if buffer else seg
                else:
                    if buffer:
                        merged.append(buffer)
                    buffer = seg
            if buffer:
                merged.append(buffer)

            chunks = []
            for i, m in enumerate(merged):
                chunks.append({
                    "text": m,
                    "para_count": m.count("\n"),
                    "char_count": len(m),
                    "chunk_index": i,
                    "total_chunks": len(merged),
                    "split_mode": "conversational",
                })
            print(f"  [TopicSplitter] {conv_count} tours → {len(chunks)} chunks conversationnels")
            return chunks

    # Fallback: paragraphes
    print(f"  [TopicSplitter] Mode PARAGRAPHES (pas de conv détectée)")
    paragraphs = [p.strip() for p in re.split(r'\n{2,}', text) if p.strip() and len(p.strip()) > 20]

    chunks = []
    current_text = ""
    current_paras = []

    for para in paragraphs:
        if len(current_text) + len(para) + 2 > chunk_size_chars and current_text:
            chunks.append({
                "text": current_text.strip(),
                "para_count": len(current_paras),
                "char_count": len(current_text),
            })
            overlap_text = ""
            for p in reversed(current_paras):
                if len(overlap_text) + len(p) < overlap_chars:
                    overlap_text = p + "\n\n" + overlap_text
                else:
                    break
            current_text = overlap_text + para
            current_paras = [p for p in current_paras if p in overlap_text] + [para]
        else:
            if current_text:
                current_text += "\n\n" + para
            else:
                current_text = para
            current_paras.append(para)

    if current_text.strip():
        chunks.append({
            "text": current_text.strip(),
            "para_count": len(current_paras),
            "char_count": len(current_text),
        })

    for i, c in enumerate(chunks):
        c["chunk_index"] = i
        c["total_chunks"] = len(chunks)
        c["split_mode"] = "paragraph"

    print(f"  [TopicSplitter] {len(paragraphs)} paragraphes → {len(chunks)} chunks")
    return chunks


# ─── COMPOSANT 3 : VLLMExtractor ─────────────────────────────────────────────
# ─── EXTRACTION PROMPT (DSPy optimisé 68.72% + règles BRUCE) [509] ──────────────
EXTRACTION_PROMPT = """/no_think
[DSPy-v3.2] Tu es un extracteur de mémoire pour BRUCE, homelab intelligent de Yann.
Ton objectif: extraire UNIQUEMENT les informations concrètes, spécifiques et actionnables. La qualité prime sur la quantité.

LANGUE: Réponds TOUJOURS en français, sans exception.

EXTRAIT À ANALYSER:
{text}

SOURCE: {source}

CONTEXTE BRUCE: homelab Proxmox + Docker + Supabase + vLLM (Qwen 7B) + n8n + Grafana/Loki + Claude API. Opéré par Yann (ingénieur, pragmatique, veut lautonomie). BRUCE doit devenir autonome et conscient.


FILTRE QUALITÉ — Chaque item extrait DOIT passer TOUS ces tests:
- CONCRET: contient au moins un élément spécifique (IP, port, service, commande, fichier, config, version)
- AUTONOME: compréhensible sans lire la conversation source
- ACTIONNABLE: quelquun peut agir dessus ou en tirer une décision
- NON-TRIVIAL: pas un truisme ("il faut tester", "centraliser cest mieux", "automatiser")
- MINIMUM 80 chars pour lessons, 100 chars pour KB, 60 chars pour decisions

NE PAS extraire:
- Aspirations vagues ("il faudrait améliorer...", "on pourrait utiliser X")
- Fragments de phrase sans contexte ni conclusion
- Réformulations de principes évidents (DRY, KISS, etc.)
- Décisions sans rationale concrète
- Informations triviales ou évidentes dans le contexte du projet

Réponds UNIQUEMENT avec ce JSON valide (pas de markdown, pas dexplication, pas de texte avant ou après):
{{
  "lessons": [
    {{
      "lesson_type": "architecture|decision|diagnostic|warning|solution|process",
      "lesson_text": "Leçon complète et autonome en français (min 40 chars). Contexte + apprentissage + pourquoi cest important.",
      "importance": "critical|normal",
      "confidence_score": 0.0-1.0
    }}
  ],
  "knowledge_base": [
    {{
      "question": "Sujet ou question précise en français",
      "answer": "Réponse complète et réutilisable en français (min 60 chars). Contexte, détails concrets, pourquoi ce choix.",
      "category": "docker|infrastructure|architecture|runbook|workflow|services|tools|ssh|configuration|debugging|solution-validee|pipeline|api|governance",
      "subcategory": "OBLIGATOIRE, TOUJOURS remplir. Sous-catégorie précise parmi: compose, networking, proxmox, backup, monitoring, zigbee, mqtt, ha-automation, prompt-engineering, gateway, embedding, n8n, grafana, loki, vllm, supabase, docker-compose, ssh-config, api-gateway, validation, ingestion, llm-config, mcp-server, traefik, postgres",
      "tags": ["tag1", "tag2"]
    }}
  ],
  "decisions": [
    {{
      "decision_text": "Décision explicite prise ou principe établi (min 20 chars)",
      "rationale": "Raison concrète de cette décision",
      "importance": "critical|normal"
    }}
  ],
  "wishes": [
    {{
      "wish_text": "Désir ou souhait explicite de Yann en français (min 40 chars). Ce quil VEUT avoir, automatiser, améliorer ou résoudre.",
      "importance": "critical|normal"
    }}
  ],
  "user_profile": [
    {{
      "trait": "nom_du_trait (ex: style_travail, preference_outil, valeur, objectif)",
      "value": "valeur observée en français (min 20 chars)",
      "category": "preference|style|skill|goal|value"
    }}
  ],
  "conversation_qa": [
    {{
      "question": "Question posée ou sujet soulevé dans la conversation (min 20 chars)",
      "answer": "Réponse ou explication donnée (min 40 chars). Autonome, compréhensible sans contexte.",
      "category": "conversation-qa",
      "tags": ["tag1"]
    }}
  ],
  "chunk_summary": "Résumé en 1-2 phrases en français de ce qui est discuté dans cet extrait"
}}

RÈGLES:
- TOUT en français
- lessons: apprentissages, patterns, diagnostics — tout ce qui a de la valeur future
- knowledge_base: infos techniques réutilisables (configs, outils, patterns, choix architecturaux). OBLIGATOIRE: chaque item KB DOIT avoir un champ subcategory non-vide (ex: compose, networking, proxmox, backup, monitoring, zigbee, mqtt, ha-automation, prompt-engineering, gateway, embedding, n8n, grafana, loki)
- decisions: décisions explicites de Yann ou principes établis
- wishes: ce que Yann VEUT, SOUHAITE, AIMERAIT voir dans son homelab
- user_profile: comment Yann travaille, ce quil valorise, ses préférences révélées
- conversation_qa: CHAQUE échange question/réponse substantiel de la conversation — cest la source la plus riche
- importance=critical: MAX 5% des items (seulement décisions architecturales majeures)
- Si rien dans une catégorie, retourner []
- Chaque item DOIT être autonome (compréhensible sans la source)

EXEMPLES KB (subcategory OBLIGATOIRE, copier le format):
  Ex1: {{"question":"Config reverse proxy Traefik pour n8n","answer":"Label traefik.http.routers.n8n.rule=Host(n8n.local) dans docker-compose.yml sur .230.","category":"docker","subcategory":"compose","tags":["traefik","n8n"]}}
  Ex2: {{"question":"Pourquoi vLLM timeout après 5min","answer":"--max-model-len trop haut (32768) pour la VRAM. Réduit à 8192, résolu.","category":"infrastructure","subcategory":"vllm","tags":["vllm","gpu"]}}
  Ex3: {{"question":"Validation items staging BRUCE","answer":"validate.py --auto lit staging_queue, applique Gate-1/Gate-2, promeut vers tables canon.","category":"pipeline","subcategory":"validation","tags":["validation"]}}
  ATTENTION: si subcategory est absent ou vide, l'item sera REJETÉ par le pipeline.
"""

EXTRACTION_PROMPT_ARCHIVE = """/no_think
Tu es un extracteur de mémoire pour BRUCE, homelab intelligent de Yann.
Tu traites un FICHIER ARCHIVE (conversation ou note ancienne).

RÈGLE FONDAMENTALE: Un désir ancien n'est pas un désir mort.
Extrais ce que YANN voulait, désirait, rêvait — même si ce n'est plus d'actualité.
NE PAS extraire des next_steps ni modifier l'état courant.

LANGUE: Réponds TOUJOURS en français.

EXTRAIT À ANALYSER:
{text}

SOURCE: {source}

Réponds UNIQUEMENT avec ce JSON valide (pas de markdown, pas d'explication):
{{
  "wishes": [
    {{
      "wish_text": "Désir ou souhait de Yann exprimé dans cette archive, en français. Min 60 chars. Ex: 'Yann souhaitait intégrer Home Assistant avec BRUCE pour automatiser l'éclairage selon sa présence.'",
      "importance": "critical|normal",
      "tags": ["historique", "tag_optionnel"]
    }}
  ],
  "user_profile": [
    {{
      "trait": "nom_du_trait (ex: style_travail, preference_outil, valeur, objectif)",
      "value": "valeur observée (ex: 'Préfère les scripts automatiques aux actions manuelles')",
      "category": "preference|style|skill|goal|value"
    }}
  ],
  "discoveries": [
    {{
      "question": "Technologie ou service que Yann découvrait ou voulait explorer",
      "answer": "Ce qu'il en pensait, pourquoi ça l'intéressait, contexte. Min 80 chars.",
      "category": "infrastructure|tools|architecture|services|workflow|docker|automation",
      "tags": ["archive", "tag2"]
    }}
  ],
  "chunk_summary": "Résumé en 1-2 phrases de ce que Yann discutait dans cet extrait (archive)"
}}

RÈGLES STRICTES:
- TOUT en français
- wishes: désirs/souhaits explicites de Yann — ce qu'il VOULAIT avoir ou faire
- user_profile: traits de personnalité, préférences de travail, valeurs révélées
- discoveries: technologies/services/outils qu'il explorait ou voulait essayer
- NE PAS extraire: next_steps, actions à faire, modifications d'état actuel
- Si rien dans une catégorie, retourner []
- importance=critical: SEULEMENT si ce désir est fondamental pour comprendre Yann
"""



# [v2.8] Charger le prompt DSPy optimise si disponible
_DSPY_PROMPT_PATH = Path("/home/furycom/bruce_optimized_prompt_v32.json")
_DSPY_OPTIMIZED_INSTRUCTIONS = None

def _load_dspy_prompt():
    global _DSPY_OPTIMIZED_INSTRUCTIONS
    try:
        import json
        data = json.load(open(_DSPY_PROMPT_PATH))
        sig = data.get("extractor.predict", {}).get("signature", {})
        instructions = sig.get("instructions", "")
        demos = data.get("extractor.predict", {}).get("demos", [])
        if instructions and len(instructions) > 50:
            _DSPY_OPTIMIZED_INSTRUCTIONS = {"instructions": instructions, "demos": demos}
            print(f"  [DSPy v2.8] Prompt optimise charge ({len(instructions)} chars, {len(demos)} demos)")
            return True
    except Exception as e:
        print(f"  [DSPy v2.8] Pas de prompt optimise: {e}")
    return False

_load_dspy_prompt()


def vllm_extract(chunk: dict, source: str, dry_run: bool = False, archive_mode: bool = False, _override_temperature: float = None) -> dict:
    """
    Appelle vLLM pour extraire les informations structurées d'un chunk.
    [508] Utilise Instructor (validation Pydantic + retry auto) si disponible.
    Fallback: parsing JSON manuel avec retry 3x [503].
    Retourne dict avec lessons, knowledge_base, decisions, chunk_summary.
    """
    if dry_run:
        return {
            "lessons": [],
            "knowledge_base": [],
            "decisions": [],
            "wishes": [],
            "user_profile": [],
            "discoveries": [],
            "chunk_summary": f"[DRY-RUN][{'ARCHIVE' if archive_mode else 'NORMAL'}] Chunk {chunk['chunk_index']+1}/{chunk['total_chunks']} ({chunk['char_count']} chars)",
        }

    # [v2.8] Utiliser instructions DSPy optimisees si disponibles (mode normal seulement)
    if not archive_mode and _DSPY_OPTIMIZED_INSTRUCTIONS:
        dspy_instr = _DSPY_OPTIMIZED_INSTRUCTIONS["instructions"]
        dspy_demos = _DSPY_OPTIMIZED_INSTRUCTIONS.get("demos", [])
        demo_text = ""
        for d in dspy_demos[:3]:  # [963] v32 uses 3 few-shot demos  # max 2 demos pour ne pas exploser le contexte
            if d.get("text") and d.get("lessons_json"):
                demo_text += f"\n---EXEMPLE---\nTexte: {d['text'][:500]}\nLessons: {d.get('lessons_json','[]')}\n"
        prompt = f"{dspy_instr}\n{demo_text}\n\nEXTRAIT A ANALYSER:\n{chunk['text'][:6000]}\n\nSOURCE: {source}\n\n" + EXTRACTION_PROMPT.split("Réponds UNIQUEMENT")[1]
        prompt = "Réponds UNIQUEMENT" + prompt
    else:
        prompt = (EXTRACTION_PROMPT_ARCHIVE if archive_mode else EXTRACTION_PROMPT).format(text=chunk["text"][:6000], source=source)

    # [508] INSTRUCTOR PATH: validation Pydantic + retry automatique
    if INSTRUCTOR_AVAILABLE:
        return _vllm_extract_instructor(chunk, prompt, archive_mode, _override_temperature=_override_temperature)

    # FALLBACK: parsing JSON manuel avec retry 3x [503]
    return _vllm_extract_manual(chunk, prompt, _override_temperature=_override_temperature)


def _vllm_extract_instructor(chunk: dict, prompt: str, archive_mode: bool, _override_temperature: float = None) -> dict:
    """[508] Extraction via Instructor — validation Pydantic + retry auto."""
    import time as _time
    try:
        import openai
        raw_client = openai.OpenAI(
            base_url=VLLM_URL,
            api_key=VLLM_API_KEY,
        )
        client = instructor.from_openai(raw_client, mode=instructor.Mode.JSON)

        result_class = ArchiveExtractionResult if archive_mode else ExtractionResult

        result = client.chat.completions.create(
            model="qwen3-32b",
            messages=[{"role": "user", "content": prompt}],
            response_model=result_class,
            max_retries=3,
            max_tokens=2000,
            temperature=_override_temperature if _override_temperature is not None else 0.1,
        )

        # Convertir en dict compatible avec le reste du pipeline
        extracted = result.model_dump()
        if not archive_mode:
            n_l = len(extracted.get("lessons", []))
            n_k = len(extracted.get("knowledge_base", []))
            n_d = len(extracted.get("decisions", []))
            print(f"    [Instructor] Chunk {chunk['chunk_index']+1}: {n_l} lessons, {n_k} KB, {n_d} decisions ✓")
        else:
            n_w = len(extracted.get("wishes", []))
            n_p = len(extracted.get("user_profile", []))
            n_d = len(extracted.get("discoveries", []))
            print(f"    [Instructor/Archive] Chunk {chunk['chunk_index']+1}: {n_w} wishes, {n_p} profil, {n_d} discoveries ✓")
        return extracted

    except Exception as e:
        print(f"    [Instructor] ERREUR chunk {chunk['chunk_index']}: {e} → fallback JSON manuel")
        return _vllm_extract_manual(chunk, (EXTRACTION_PROMPT_ARCHIVE if archive_mode else EXTRACTION_PROMPT).format(
            text=chunk.get("text", "")[:6000], source="fallback"), _override_temperature=_override_temperature)


def clean_vllm_json(raw: str) -> str:
    """[110] Nettoie le JSON brut du vLLM: apostrophes echappees invalides."""
    # Remplace \' par ' (apostrophe echappee invalide en JSON standard)
    raw = re.sub(r"\\'", "'", raw)
    return raw


def _vllm_extract_manual(chunk: dict, prompt: str, _override_temperature: float = None) -> dict:
    """Fallback: parsing JSON manuel avec retry 3x [503]."""
    import time as _time
    MAX_RETRY = 3
    last_error = None
    for attempt in range(1, MAX_RETRY + 1):
        try:
            resp = requests.post(
                f"{VLLM_URL}/chat/completions",
                headers={"Authorization": f"Bearer {VLLM_API_KEY}"},
                json={
                    "model": "qwen3-32b",
                    "messages": [{"role": "user", "content": prompt}],
                    "max_tokens": 2000,
                    "temperature": _override_temperature if _override_temperature is not None else 0.1,
                },
                timeout=900,
            )
            resp.raise_for_status()
            raw = resp.json()["choices"][0]["message"]["content"].strip()

            if "```json" in raw:
                raw = raw.split("```json")[1].split("```")[0].strip()
            elif "```" in raw:
                raw = raw.split("```")[1].split("```")[0].strip()

            raw = clean_vllm_json(raw)
            extracted = json.loads(raw)
            n_lessons = len(extracted.get("lessons", []))
            n_kb = len(extracted.get("knowledge_base", []))
            n_dec = len(extracted.get("decisions", []))
            print(f"    [Manual] Chunk {chunk['chunk_index']+1}: {n_lessons} lessons, {n_kb} KB, {n_dec} decisions")
            return extracted

        except json.JSONDecodeError as e:
            last_error = f"JSON invalide: {e}"
            print(f"    [VLLMExtractor] tentative {attempt}/{MAX_RETRY} -- JSON invalide chunk {chunk['chunk_index']}: {e}")
            if attempt < MAX_RETRY:
                _time.sleep(2)
        except Exception as e:
            last_error = str(e)
            print(f"    [VLLMExtractor] tentative {attempt}/{MAX_RETRY} -- ERREUR chunk {chunk['chunk_index']}: {e}")
            if attempt < MAX_RETRY:
                _time.sleep(2)

    print(f"    [CHUNK PERDU] chunk {chunk['chunk_index']+1}/{chunk['total_chunks']} apres {MAX_RETRY} tentatives -- {last_error}")
    return {"lessons": [], "knowledge_base": [], "decisions": [], "chunk_summary": "extraction failed", "_failed": True}


# ─── COMPOSANT 4 : BGEEmbedder ───────────────────────────────────────────────
def bge_embed(text: str) -> list[float] | None:
    """
    Génère un embedding via le service embed_worker sur .230.
    NOTE: bruce_chunks n'a pas de colonne embedding — on retourne None.
    L'embedding full-text (tsv) est géré automatiquement par Supabase trigger.
    Pour le futur: utiliser une table séparée si besoin de similarité vectorielle.
    """
    return None  # bruce_chunks utilise tsv full-text, pas de colonne embedding


# ─── COMPOSANT 5 : SupabaseWriter ────────────────────────────────────────────
def content_hash(text: str) -> str:
    return hashlib.md5(text.encode()).hexdigest()[:16]


def push_to_staging(table: str, content: dict, dry_run: bool = False) -> bool:
    """
    Pousse un item vers staging_queue.
    JAMAIS écriture directe dans les tables canon.
    """
    if dry_run:
        print(f"      [DRY-RUN] → staging_queue:{table} {list(content.keys())}")
        return True

    payload = {
        "table_cible": table,
        "contenu_json": json.dumps(content, ensure_ascii=False),
        "status": "pending",
        "created_at": datetime.now().isoformat(),
    }

    try:
        resp = requests.post(
            f"{SUPABASE_URL}/staging_queue",
            headers=SUPABASE_HEADERS,
            json=payload,
            timeout=10,
        )
        resp.raise_for_status()
        return True
    except Exception as e:
        print(f"      [SupabaseWriter] ERREUR push {table}: {e}")
        return False


def push_chunk_to_rag(chunk_text: str, embedding: list | None, doc_id: str,
                       chunk_index: int, anchor: dict, dry_run: bool = False) -> bool:
    """Pousse un chunk dans bruce_chunks (table RAG).
    Schéma réel: id(uuid auto), doc_id, chunk_index, text, embedding, anchor(jsonb), text_sha256, tsv(auto), created_at
    """
    if dry_run:
        print(f"      [DRY-RUN] → bruce_chunks chunk {chunk_index}")
        return True

    import hashlib as _hl
    sha256 = _hl.sha256(chunk_text.encode()).hexdigest()

    payload = {
        "doc_id": doc_id,
        "chunk_index": chunk_index,
        "text": chunk_text[:3000],
        "anchor": anchor,   # jsonb — Supabase accepte dict directement
        "text_sha256": sha256,
        "created_at": datetime.now().isoformat(),
    }

    try:
        resp = requests.post(
            f"{SUPABASE_URL}/bruce_chunks",
            headers=SUPABASE_HEADERS,
            json=payload,
            timeout=10,
        )
        if resp.status_code in (200, 201):
            return True
        if resp.status_code == 409:
            print(f"      [SupabaseWriter] bruce_chunks: doublon ignoré")
            return True
        print(f"      [SupabaseWriter] bruce_chunks status {resp.status_code}: {resp.text[:200]}")
        return False
    except Exception as e:
        print(f"      [SupabaseWriter] Erreur bruce_chunks: {e}")
        return False


# ─── PIPELINE PRINCIPAL ───────────────────────────────────────────────────────
def run_pipeline(file_path: Path, source: str, dry_run: bool = False, gap_detect: bool = False, session_id: int = None, archive_mode: bool = False, best_of_n: bool = False, bon_temperatures: list = None) -> dict:
    """
    Pipeline complet: Fichier → Unstructured → TopicSplitter → vLLM → BGE → Supabase.
    Retourne un receipt avec les statistiques.
    """
    doc_id = str(uuid.uuid4())
    start_time = time.time()

    # [423 Phase C] Gap detection: charger extractions existantes
    existing = {"lessons": [], "kb": [], "decisions": []}
    gap_stats = {"skipped_lessons": 0, "skipped_kb": 0, "skipped_decisions": 0}
    if gap_detect and session_id:
        existing = fetch_existing_extractions(session_id)

    print(f"\n{'='*60}")
    print(f"BRUCE INGEST v1.0 — {file_path.name}")
    print(f"Source: {source}")
    print(f"Doc ID: {doc_id}")
    print(f"Mode: {'DRY-RUN' if dry_run else 'ARCHIVE' if archive_mode else 'GAP-DETECT' if gap_detect else 'PRODUCTION'}")
    print(f"{'='*60}\n")

    # ÉTAPE 1 : Nettoyage — avec détection conversationnelle sur texte brut
    print("[1/5] UnstructuredCleaner...")
    raw_text = file_path.read_text(encoding="utf-8", errors="replace")
    conv_count_raw = len(SPEAKER_RE.findall(raw_text))

    if conv_count_raw >= 4:
        # Mode conversationnel: bypass Unstructured pour préserver les marqueurs de tour de parole
        # Unstructured les supprimerait, rendant la détection impossible
        print(f"  [Mode CONV] {conv_count_raw} tours détectés dans le brut → bypass Unstructured")
        cleaned_text = raw_text
    else:
        cleaned_text = unstructured_clean(file_path)

    if len(cleaned_text) < 100:
        print(f"  ERREUR: Texte trop court après nettoyage ({len(cleaned_text)} chars)")
        return {"ok": False, "error": "text too short after cleaning"}

    # ÉTAPE 2 : Découpage topique
    print("[2/5] TopicSplitter...")
    chunks = topic_split(cleaned_text)
    if not chunks:
        print("  ERREUR: Aucun chunk produit")
        return {"ok": False, "error": "no chunks produced"}

    # ÉTAPES 3-5 : Pour chaque chunk
    stats = {"lessons": 0, "kb": 0, "decisions": 0, "chunks_rag": 0, "errors": 0,
             "dedup_skipped": 0, "chunks_failed": 0,  # [503]
             "wishes": 0, "profile": 0}  # [507] archive mode
    # Set de hashes pour déduplication intra-run (évite doublons entre chunks)
    run_hashes: set = set()

    for chunk in chunks:
        idx = chunk["chunk_index"]
        print(f"\n[3-5/{len(chunks)}] Chunk {idx+1}/{len(chunks)} ({chunk['char_count']} chars)...")

        # ETAPE 3 : Extraction vLLM
        if best_of_n and not dry_run:
            print("  [3/5] VLLMExtractor (Best-of-N)...")
            extracted = best_of_n_extract(chunk, source, vllm_extract,
                                          temperatures=bon_temperatures,
                                          archive_mode=archive_mode, dry_run=dry_run)
        else:
            print("  [3/5] VLLMExtractor...")
            extracted = vllm_extract(chunk, source, dry_run, archive_mode=archive_mode)

        # [503] FIX: detecter chunk perdu apres tous les retries
        if extracted.get("_failed"):
            stats["chunks_failed"] += 1
            # On pousse quand meme le chunk RAG pour ne pas perdre le texte brut
            # mais on skip l'extraction lessons/KB/decisions

        # ETAPE 4 : Embedding (desactive -- bruce_chunks utilise tsv full-text)
        print("  [4/5] BGEEmbedder... (tsv géré par trigger Supabase)")

        # ÉTAPE 5 : Écriture Supabase
        print("  [5/5] SupabaseWriter...")

        anchor = {
            "source": source,
            "file": file_path.name,
            "chunk_index": idx,
            "total_chunks": chunk["total_chunks"],
            "doc_id": doc_id,
        }

        # 5a. Chunk RAG
        ok = push_chunk_to_rag(chunk["text"], None, doc_id, idx, anchor, dry_run)
        if ok:
            stats["chunks_rag"] += 1

        # [507] 5-ARCHIVE: Traitement spécial mode archive
        if archive_mode:
            # 5a-arch. Wishes → lessons_learned (lesson_type=user_wish, tag=historique)
            for wish in extracted.get("wishes", []):
                wish_text = wish.get("wish_text", "")
                if len(wish_text) < 30:
                    continue
                tags = wish.get("tags", ["historique"])
                if "historique" not in tags:
                    tags.append("historique")
                wish_payload = {
                    "lesson_type": "user_wish",
                    "lesson_text": wish_text,
                    "importance": "old",  # [session109] archive=historique, jamais critical
                    "confidence_score": 0.75,
                    "author_system": AUTHOR_SYSTEM + "-archive",
                    "validated": False,
                    "content_hash": content_hash(wish_text),
                    "actor": "yann",
                    "intent": "archive",
                }
                _whash = wish_payload["content_hash"]
                if _whash not in run_hashes:
                    run_hashes.add(_whash)
                    if push_to_staging("lessons_learned", wish_payload, dry_run):
                        stats["wishes"] += 1
                    else:
                        stats["errors"] += 1

            # 5b-arch. User Profile → user_profile table
            for trait in extracted.get("user_profile", []):
                trait_name = trait.get("trait", "")
                trait_value = trait.get("value", "")
                if not trait_name or not trait_value:
                    continue
                profile_payload = {
                    "trait_name": trait_name,
                    "trait_value": trait_value,
                    "category": trait.get("category", "preference"),
                    "source": source,
                    "confidence": 0.7,
                    "author_system": AUTHOR_SYSTEM + "-archive",
                    "validated": False,
                    "content_hash": content_hash(f"{trait_name}:{trait_value}"),
                }
                _phash = profile_payload["content_hash"]
                if _phash not in run_hashes:
                    run_hashes.add(_phash)
                    if push_to_staging("user_profile", profile_payload, dry_run):
                        stats["profile"] += 1
                    else:
                        stats["errors"] += 1

            # 5c-arch. Discoveries → knowledge_base
            for disc in extracted.get("discoveries", []):
                disc_tags = disc.get("tags", [])
                if "archive" not in disc_tags:
                    disc_tags.append("archive")
                # [SESSION-1231] Subcategory fallback pour discoveries archive
                disc_category = disc.get("category", "infrastructure")
                disc_subcategory = disc.get("subcategory", "")
                if not disc_subcategory or len(str(disc_subcategory).strip()) < 2:
                    disc_subcategory = infer_subcategory(disc_category, disc.get("question", "") + " " + disc.get("answer", ""))

                kb_payload = {
                    "question": disc.get("question", ""),
                    "answer": disc.get("answer", ""),
                    "category": disc_category,
                    "subcategory": disc_subcategory,
                    "tags": disc_tags[:5],
                    "author_system": AUTHOR_SYSTEM + "-archive",
                    "validated": False,
                    "content_hash": content_hash(disc.get("answer", "")),
                }
                if kb_payload["answer"] and kb_payload["question"]:
                    _dhash = kb_payload["content_hash"]
                    if _dhash not in run_hashes:
                        run_hashes.add(_dhash)
                        if push_to_staging("knowledge_base", kb_payload, dry_run):
                            stats["kb"] += 1
                        else:
                            stats["errors"] += 1
            # Pas de next_steps, pas de decisions d'action en mode archive
            continue  # skip les blocs 5b/5c/5d normaux

        # 5b. Lessons
        for lesson in extracted.get("lessons", []):
            lesson_payload = {
                "lesson_type": lesson.get("lesson_type", "architecture"),
                "lesson_text": lesson.get("lesson_text", ""),
                "importance": lesson.get("importance", "medium"),
                "confidence_score": lesson.get("confidence_score", 0.7),
                "author_system": AUTHOR_SYSTEM,
                "validated": False,
                "content_hash": content_hash(lesson.get("lesson_text", "")),
            }
            _lhash = lesson_payload["content_hash"]
            if len(lesson_payload["lesson_text"]) > 20:
                if _lhash in run_hashes:
                    stats["dedup_skipped"] += 1
                    continue
                run_hashes.add(_lhash)
                if gap_detect and is_duplicate(lesson_payload["lesson_text"], existing["lessons"] + existing["decisions"]):
                    gap_stats["skipped_lessons"] += 1
                    continue
                if push_to_staging("lessons_learned", lesson_payload, dry_run):
                    stats["lessons"] += 1
                else:
                    stats["errors"] += 1

        # 5c. Knowledge Base
        for kb in extracted.get("knowledge_base", []):
            # Limiter catégories à 3 max (évite le bruit multi-catégories)
            raw_category = kb.get("category", "infrastructure")
            if isinstance(raw_category, str) and "|" in raw_category:
                cats = [c.strip() for c in raw_category.split("|")][:3]
                clean_category = cats[0]  # Catégorie principale
            elif isinstance(raw_category, list):
                clean_category = raw_category[0] if raw_category else "infrastructure"
            else:
                clean_category = raw_category or "infrastructure"

            # [SESSION-1231] Subcategory: récupérer du LLM ou inférer par fallback
            raw_subcategory = kb.get("subcategory", "")
            if not raw_subcategory or len(str(raw_subcategory).strip()) < 2:
                inferred_text = kb.get("question", "") + " " + kb.get("answer", "")
                raw_subcategory = infer_subcategory(clean_category, inferred_text)
                print(f"      [SubcatFallback] KB '{kb.get('question', '')[:40]}...' -> subcategory='{raw_subcategory}' (inferred from content)")

            kb_payload = {
                "question": kb.get("question", kb.get("title", "")),
                "answer": kb.get("answer", kb.get("content", "")),
                "category": clean_category,
                "subcategory": raw_subcategory,
                "tags": kb.get("tags", [])[:5],  # Max 5 tags
                "author_system": AUTHOR_SYSTEM,
                "validated": False,
                "content_hash": content_hash(kb.get("answer", kb.get("content", ""))),
            }
            _kbhash = kb_payload["content_hash"]
            if kb_payload["answer"] and kb_payload["question"]:
                if _kbhash in run_hashes:
                    stats["dedup_skipped"] += 1
                    continue
                run_hashes.add(_kbhash)
                if gap_detect and is_duplicate(kb_payload["answer"], existing["kb"]):
                    gap_stats["skipped_kb"] += 1
                    continue
                if push_to_staging("knowledge_base", kb_payload, dry_run):
                    stats["kb"] += 1
                else:
                    stats["errors"] += 1

        # 5d. Decisions → lessons avec type decision
        for dec in extracted.get("decisions", []):
            dec_text = f"[DÉCISION] {dec.get('decision_text', '')} — Rationale: {dec.get('rationale', '')}"
            dec_payload = {
                "lesson_type": "decision",
                "lesson_text": dec_text,
                "importance": dec.get("importance", "medium"),
                "confidence_score": 0.85,
                "author_system": AUTHOR_SYSTEM,
                "validated": False,
                "content_hash": content_hash(dec_text),
            }
            if len(dec_text) > 30:
                if gap_detect and is_duplicate(dec_text, existing["decisions"] + existing["lessons"]):
                    gap_stats["skipped_decisions"] += 1
                    continue
                if push_to_staging("lessons_learned", dec_payload, dry_run):
                    stats["decisions"] += 1
                else:
                    stats["errors"] += 1

        # [v2.7] 5g. Conversation QA → knowledge_base category=conversation-qa
        for qa in extracted.get("conversation_qa", []):
            qa_q = qa.get("question", "")
            qa_a = qa.get("answer", "")
            if len(qa_q) < 15 or len(qa_a) < 30:
                continue
            qa_payload = {
                "question": qa_q,
                "answer": qa_a,
                "category": "conversation-qa",
                "subcategory": infer_subcategory("conversation-qa", qa_q + " " + qa_a),
                "tags": qa.get("tags", ["conversation"]),
                "author_system": AUTHOR_SYSTEM,
                "validated": False,
                "content_hash": content_hash(qa_q + qa_a),
            }
            _qhash = qa_payload["content_hash"]
            if _qhash not in run_hashes:
                run_hashes.add(_qhash)
                if push_to_staging("knowledge_base", qa_payload, dry_run):
                    stats["kb"] += 1
                else:
                    stats["errors"] += 1

        # [v2.6] 5e. Wishes en mode normal
        if not archive_mode:
            for wish in extracted.get("wishes", []):
                wish_text = wish.get("wish_text", "")
                if len(wish_text) < 40:
                    continue
                wish_payload = {
                    "lesson_type": "user_wish",
                    "lesson_text": wish_text,
                    "importance": wish.get("importance", "normal"),
                    "confidence_score": 0.80,
                    "author_system": AUTHOR_SYSTEM,
                    "validated": False,
                    "content_hash": content_hash(wish_text),
                    "actor": "yann",
                }
                _whash = wish_payload["content_hash"]
                if _whash not in run_hashes:
                    run_hashes.add(_whash)
                    if push_to_staging("lessons_learned", wish_payload, dry_run):
                        stats["wishes"] += 1
                    else:
                        stats["errors"] += 1

        # [v2.6] 5f. User Profile en mode normal
        if not archive_mode:
            for trait in extracted.get("user_profile", []):
                trait_name = trait.get("trait", "")
                trait_value = trait.get("value", "")
                if not trait_name or len(trait_value) < 20:
                    continue
                profile_payload = {
                    "trait_name": trait_name,
                    "observation": trait_value,
                    "category": trait.get("category", "preference"),
                    "author_system": AUTHOR_SYSTEM,
                    "content_hash": content_hash(trait_name + trait_value),
                }
                _phash = profile_payload["content_hash"]
                if _phash not in run_hashes:
                    run_hashes.add(_phash)
                    if push_to_staging("user_profile", profile_payload, dry_run):
                        stats["profile"] += 1
                    else:
                        stats["errors"] += 1

    elapsed = round(time.time() - start_time, 1)

    receipt = {
        "ok": True,
        "doc_id": doc_id,
        "file": file_path.name,
        "source": source,
        "dry_run": dry_run,
        "elapsed_s": elapsed,
        "chunks_total": len(chunks),
        "chunks_rag": stats["chunks_rag"],
        "lessons_pushed": stats["lessons"],
        "kb_pushed": stats["kb"],
        "decisions_pushed": stats["decisions"],
        "errors": stats["errors"],
        "chunks_failed": stats["chunks_failed"],  # [503]
        "text_chars": len(cleaned_text),
        "gap_detect": gap_detect,
        "gap_skipped": gap_stats if gap_detect else None,
        "archive_mode": archive_mode,
        "best_of_n": best_of_n,
        "wishes_pushed": stats["wishes"],
        "profile_pushed": stats["profile"],
    }

    print(f"\n{'='*60}")
    print(f"RECEIPT — {elapsed}s")
    print(f"  Chunks RAG  : {stats['chunks_rag']}/{len(chunks)}")
    print(f"  Lessons     : {stats['lessons']}")
    print(f"  KB          : {stats['kb']}")
    print(f"  Décisions   : {stats['decisions']}")
    print(f"  Dedup skip  : {stats['dedup_skipped']} (doublons intra-run éliminés)")
    print(f"  Erreurs     : {stats['errors']}")
    if stats["chunks_failed"] > 0:
        print(f"  ⚠️  CHUNKS PERDUS : {stats['chunks_failed']} chunks vLLM non extractibles apres 3 tentatives")
    if archive_mode:
        print(f"  --- MODE ARCHIVE ---")
        print(f"  Wishes (user_wish) : {stats['wishes']}")
        print(f"  Profil (user_profile): {stats['profile']}")
        print(f"  Discoveries (KB)   : {stats['kb']}")
        print(f"  ⚠️  Pas de next_steps produits (mode archive)")
    if gap_detect:
        print(f"  --- GAP DETECTION ---")
        print(f"  Skipped (déjà existants): {gap_stats['skipped_lessons']} lessons, {gap_stats['skipped_kb']} KB, {gap_stats['skipped_decisions']} decisions")
        print(f"  GAPS trouvés (nouveaux) : {stats['lessons']} lessons, {stats['kb']} KB, {stats['decisions']} decisions")
    print(f"{'='*60}\n")

    return receipt


# ─── DOCUMENTATION SUPABASE ───────────────────────────────────────────────────
def document_run(receipt: dict, dry_run: bool = False):
    """Enregistre le run dans les lessons BRUCE."""
    if dry_run:
        return
    lesson = {
        "lesson_type": "architecture",
        "lesson_text": (
            f"INGESTION bruce_ingest.py v1.0 (session Opus 2026-02-21): "
            f"Fichier '{receipt['file']}' (source: {receipt['source']}) ingéré. "
            f"{receipt['chunks_total']} chunks → {receipt['chunks_rag']} RAG, "
            f"{receipt['lessons_pushed']} lessons, {receipt['kb_pushed']} KB, "
            f"{receipt['decisions_pushed']} décisions. "
            f"Durée: {receipt['elapsed_s']}s. Doc ID: {receipt['doc_id']}."
        ),
        "importance": "medium",
        "confidence_score": 1.0,
        "author_system": AUTHOR_SYSTEM,
        "validated": True,
        "content_hash": content_hash(receipt["doc_id"]),
    }
    push_to_staging("lessons_learned", lesson)


# ─── MAIN ─────────────────────────────────────────────────────────────────────
if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="BRUCE Ingestion Pipeline v1.0")
    parser.add_argument("file", help="Fichier à ingérer (.txt, .md, .pdf)")
    parser.add_argument("--source", default="", help="Description de la source (ex: 'ChatGPT - BRUCE x HA')")
    parser.add_argument("--dry-run", action="store_true", help="Simuler sans écrire dans Supabase")
    parser.add_argument("--gap-detect", action="store_true", help="Mode gap detection: ne pousse que les items manquants")
    parser.add_argument("--archive", action="store_true", help="[507] Mode archive: produire user_wish+user_profile+discoveries, sans next_steps")
    parser.add_argument("--best-of-n", action="store_true", help="[OPUS-104] Best-of-N: N extractions multi-temperatures fusionnees")
    parser.add_argument("--bon-temps", default="0.3,0.5,0.7", help="Temperatures Best-of-N (defaut: 0.3,0.5,0.7)")
    parser.add_argument("--session-id", type=int, default=None, help="Session ID pour le gap detection")
    args = parser.parse_args()

    file_path = Path(args.file)
    if not file_path.exists():
        print(f"ERREUR: Fichier non trouvé: {file_path}")
        sys.exit(1)

    source = args.source or file_path.stem
    gap_detect = args.gap_detect
    session_id = args.session_id
    if gap_detect and not session_id:
        print("ERREUR: --gap-detect nécessite --session-id N")
        sys.exit(1)
    bon_temps_list = None
    if args.best_of_n:
        bon_temps_list = [float(t.strip()) for t in args.bon_temps.split(",")]
        print(f"[Best-of-N] Enabled: temperatures={bon_temps_list}")
    receipt = run_pipeline(file_path, source, dry_run=args.dry_run, gap_detect=gap_detect, session_id=session_id, archive_mode=args.archive, best_of_n=args.best_of_n, bon_temperatures=bon_temps_list)

    if receipt["ok"]:
        document_run(receipt, dry_run=args.dry_run)
        print(f"✅ Ingestion terminée. {receipt['lessons_pushed']} lessons + {receipt['kb_pushed']} KB en staging.")
        if not args.dry_run:
            print("   -> Lancement automatique de validate.py --auto...")
            import subprocess as _sp
            _result = _sp.run(
                ['python3', '/home/furycom/validate.py', '--auto'],
                capture_output=True, text=True, timeout=300
            )
            _out = _result.stdout
            print(_out[-2000:] if len(_out) > 2000 else _out)
            if _result.returncode != 0:
                print(f"[WARN] validate.py retourne code {_result.returncode}")
                print(_result.stderr[-500:])
    else:
        print(f"❌ Ingestion échouée: {receipt.get('error')}")
        sys.exit(1)
