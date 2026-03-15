#!/usr/bin/env python3
"""Importe des inventaires médias XML (Excel 2003) vers Supabase."""

import argparse
import json
import os
import sys
import time
from datetime import datetime
from pathlib import Path
from typing import Dict, List, Optional, Tuple
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET

DEFAULT_XML_DIR = "/home/furycom/bruce-config/projets/media-library/"
XML_FILES = [
    "sata10.xml",
    "sata11.xml",
    "sata12.xml",
    "sata2_sata3.xml",
    "sata6_sata8.xml",
    "sata7_sata9.xml",
    "Nas3_film.xml",
    "tosh1.xml",
    "columbo_sata1.xml",
]

SUPABASE_URL = os.environ.get("SUPABASE_URL", "http://192.168.2.146:8000").rstrip("/")
SUPABASE_KEY = os.environ.get("SUPABASE_KEY", "")
BATCH_SIZE = 100

CREATE_TABLE_SQL = """
CREATE TABLE IF NOT EXISTS media_library (
    id BIGSERIAL PRIMARY KEY,
    title TEXT NOT NULL,
    original_title TEXT,
    year INTEGER,
    genres TEXT,
    rating TEXT,
    plot TEXT,
    resolution TEXT,
    video_codec TEXT,
    video_definition TEXT,
    duration_min INTEGER,
    country TEXT,
    actors TEXT,
    subtitles TEXT,
    disque TEXT NOT NULL,
    path TEXT,
    filename TEXT,
    file_size_bytes BIGINT,
    file_extension TEXT,
    imdb_id TEXT,
    imdb_link TEXT,
    tmdb_id TEXT,
    date_added TIMESTAMP,
    is_duplicate BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP DEFAULT NOW(),
    UNIQUE(imdb_id, disque)
);
CREATE INDEX IF NOT EXISTS idx_media_library_title ON media_library(title);
CREATE INDEX IF NOT EXISTS idx_media_library_disque ON media_library(disque);
CREATE INDEX IF NOT EXISTS idx_media_library_imdb_id ON media_library(imdb_id);
""".strip()


def _headers() -> Dict[str, str]:
    return {
        "apikey": SUPABASE_KEY,
        "Authorization": f"Bearer {SUPABASE_KEY}",
        "Content-Type": "application/json",
        "Prefer": "resolution=merge-duplicates",
    }


def _request_json(url: str, payload: dict) -> Tuple[Optional[dict], Optional[int], Optional[str]]:
    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(url, data=data, headers=_headers(), method="POST")
    try:
        with urllib.request.urlopen(req, timeout=30) as response:
            raw = response.read().decode("utf-8")
            return (json.loads(raw) if raw else {}), response.status, None
    except urllib.error.HTTPError as exc:
        err_body = exc.read().decode("utf-8", errors="replace")
        return None, exc.code, err_body
    except Exception as exc:  # noqa: BLE001
        return None, None, str(exc)


def create_table_if_needed() -> None:
    rpc_url = f"{SUPABASE_URL}/rest/v1/rpc/exec_sql"
    _, status, error = _request_json(rpc_url, {"sql": CREATE_TABLE_SQL})

    if status and 200 <= status < 300:
        print("[init] Table media_library vérifiée/créée.")
        return
    if status == 404:
        print(
            "[init] RPC exec_sql introuvable (404). "
            "Créez la table manuellement puis relancez si nécessaire."
        )
        return

    print(f"[init] Erreur création table (status={status}): {error}")
    print("[init] Le script continue et suppose que media_library existe déjà.")


def normalize_text(value: Optional[str], max_len: Optional[int] = None) -> Optional[str]:
    if value is None:
        return None
    cleaned = value.strip()
    if not cleaned:
        return None
    if max_len is not None:
        return cleaned[:max_len]
    return cleaned


def to_int(value: Optional[str]) -> Optional[int]:
    text = normalize_text(value)
    if text is None:
        return None
    if text.isdigit() or (text.startswith("-") and text[1:].isdigit()):
        return int(text)
    return None


def parse_bool(value: Optional[str]) -> bool:
    text = normalize_text(value)
    return bool(text and text.lower() == "true")


def parse_date_added(value: Optional[str]) -> Optional[str]:
    text = normalize_text(value)
    if text is None:
        return None
    for fmt in ("%Y-%m-%dT%H:%M:%S.%f", "%Y-%m-%dT%H:%M:%S"):
        try:
            return datetime.strptime(text, fmt).isoformat()
        except ValueError:
            continue
    return None


def to_minutes(seconds_value: Optional[str]) -> Optional[int]:
    seconds = to_int(seconds_value)
    if seconds is None:
        return None
    return seconds // 60


def parse_sheet_rows(xml_path: Path, disque: str) -> Tuple[List[dict], int]:
    ns = {"ss": "urn:schemas-microsoft-com:office:spreadsheet"}
    tree = ET.parse(xml_path)
    root = tree.getroot()
    rows = root.findall(".//ss:Row", ns)

    if not rows:
        return [], 0

    headers = extract_row_values(rows[0], ns)
    entries: List[dict] = []
    parse_errors = 0

    for row in rows[1:]:
        values = extract_row_values(row, ns)
        row_data = {headers[i]: values[i] if i < len(values) else None for i in range(len(headers))}
        title = normalize_text(row_data.get("Title"))
        if title is None:
            continue
        try:
            entries.append(
                {
                    "title": title,
                    "original_title": normalize_text(row_data.get("Original title")),
                    "year": to_int(row_data.get("Year")),
                    "genres": normalize_text(row_data.get("Genres")),
                    "rating": normalize_text(row_data.get("Rating")),
                    "plot": normalize_text(row_data.get("Plot"), max_len=1000),
                    "resolution": normalize_text(row_data.get("Video resolution")),
                    "video_codec": normalize_text(row_data.get("Video codec")),
                    "video_definition": normalize_text(row_data.get("Video definition")),
                    "duration_min": to_minutes(row_data.get("Duration (file)")),
                    "country": normalize_text(row_data.get("Country")),
                    "actors": normalize_text(row_data.get("Actors"), max_len=500),
                    "subtitles": normalize_text(row_data.get("Subtitles")),
                    "disque": disque,
                    "path": normalize_text(row_data.get("Path")),
                    "filename": normalize_text(row_data.get("File name")),
                    "file_size_bytes": to_int(row_data.get("File size")),
                    "file_extension": normalize_text(row_data.get("File extension")),
                    "imdb_id": normalize_text(row_data.get("Imdb Id")),
                    "imdb_link": normalize_text(row_data.get("Imdb Link")),
                    "tmdb_id": normalize_text(row_data.get("Tmdb Id")),
                    "date_added": parse_date_added(row_data.get("Date added")),
                    "is_duplicate": parse_bool(row_data.get("Is duplicate")),
                }
            )
        except Exception as exc:  # noqa: BLE001
            parse_errors += 1
            print(f"[{disque}] Erreur parsing ligne: {exc}")

    return entries, parse_errors


def extract_row_values(row: ET.Element, ns: Dict[str, str]) -> List[Optional[str]]:
    values: List[Optional[str]] = []
    current_idx = 1
    for cell in row.findall("ss:Cell", ns):
        idx_attr = cell.attrib.get(f"{{{ns['ss']}}}Index")
        if idx_attr:
            target_idx = int(idx_attr)
            while current_idx < target_idx:
                values.append(None)
                current_idx += 1
        data = cell.find("ss:Data", ns)
        values.append(data.text if data is not None else None)
        current_idx += 1
    return values


def upsert_batches(disque: str, records: List[dict], dry_run: bool = False) -> Tuple[int, int]:
    if dry_run:
        return 0, 0

    inserted = 0
    errors = 0
    base_url = f"{SUPABASE_URL}/rest/v1/media_library"
    query = urllib.parse.urlencode({"on_conflict": "imdb_id,disque"})
    url = f"{base_url}?{query}"

    for start in range(0, len(records), BATCH_SIZE):
        batch = records[start : start + BATCH_SIZE]
        _, status, error = _request_json(url, batch)
        if status and 200 <= status < 300:
            inserted += len(batch)
            print(f"[{disque}] {inserted}/{len(records)} insérées...")
        else:
            errors += len(batch)
            print(
                f"[{disque}] Erreur HTTP batch {start}-{start + len(batch) - 1} "
                f"(status={status}): {error}"
            )

    return inserted, errors


def find_targets(base_dir: Path, single_disque: Optional[str]) -> List[Path]:
    targets: List[Path] = []
    expected = {Path(name).stem: name for name in XML_FILES}

    if single_disque:
        file_name = expected.get(single_disque)
        if not file_name:
            print(f"Disque inconnu: {single_disque}")
            return []
        xml_path = base_dir / file_name
        if xml_path.exists():
            return [xml_path]
        print(f"Fichier introuvable: {xml_path}")
        return []

    for file_name in XML_FILES:
        xml_path = base_dir / file_name
        if xml_path.exists():
            targets.append(xml_path)
        else:
            print(f"[skip] Fichier introuvable: {xml_path}")
    return targets


def main() -> int:
    parser = argparse.ArgumentParser(description="Import XML media library vers Supabase")
    parser.add_argument("--dir", default=DEFAULT_XML_DIR, help="Répertoire des fichiers XML")
    parser.add_argument("--dry-run", action="store_true", help="Parse uniquement, sans insertion")
    parser.add_argument("--disque", help="Traiter un disque spécifique (ex: sata10)")
    args = parser.parse_args()

    start_ts = time.time()
    xml_dir = Path(args.dir)

    if not xml_dir.exists() or not xml_dir.is_dir():
        print(f"Répertoire invalide: {xml_dir}")
        return 1

    create_table_if_needed()

    targets = find_targets(xml_dir, args.disque)
    if not targets:
        print("Aucun fichier XML à traiter.")
        return 1

    summary = []
    total_parsed = 0
    total_inserted = 0
    total_errors = 0

    for xml_file in targets:
        disque = xml_file.stem
        print(f"\n[{disque}] Parsing {xml_file}...")
        try:
            records, parse_errors = parse_sheet_rows(xml_file, disque)
        except Exception as exc:  # noqa: BLE001
            print(f"[{disque}] Erreur lecture XML: {exc}")
            summary.append((disque, 0, 0, 1))
            total_errors += 1
            continue

        parsed_count = len(records)
        inserted_count, insert_errors = upsert_batches(disque, records, dry_run=args.dry_run)
        disk_errors = parse_errors + insert_errors

        summary.append((disque, parsed_count, inserted_count, disk_errors))
        total_parsed += parsed_count
        total_inserted += inserted_count
        total_errors += disk_errors

    elapsed = time.time() - start_ts

    print("\n=== RÉSUMÉ IMPORT MEDIA LIBRARY ===")
    for disque, parsed_count, inserted_count, disk_errors in summary:
        print(f"{disque:<14} {parsed_count:>6} parsées, {inserted_count:>6} insérées, {disk_errors:>3} erreurs")
    print(f"TOTAL:        {total_parsed:>6} parsées, {total_inserted:>6} insérées, {total_errors:>3} erreurs")
    print(f"Durée: {elapsed:.1f}s")

    return 0


if __name__ == "__main__":
    sys.exit(main())
