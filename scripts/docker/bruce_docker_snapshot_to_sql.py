#!/usr/bin/env python3
import json
import uuid
from datetime import datetime, timezone
from pathlib import Path


def read_hostname() -> str:
    # /proc/sys/kernel/hostname exists on Linux; strip newline
    return Path("/proc/sys/kernel/hostname").read_text(encoding="utf-8").strip()


HOST = read_hostname()
BASE = Path.home() / "docker_snapshots"
INFILE = BASE / f"docker_ps_{HOST}.json"
OUTFILE = BASE / f"docker_observed_{HOST}.sql"


def parse_ts(ts: str) -> str:
    # expected: 2025-12-23T03:08:50Z or ISO with offset
    if ts.endswith("Z"):
        dt = datetime.fromisoformat(ts.replace("Z", "+00:00"))
    else:
        dt = datetime.fromisoformat(ts)

    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)

    return dt.isoformat()


def main() -> None:
    data = json.loads(INFILE.read_text(encoding="utf-8"))

    hostname = data["hostname"]
    source = data.get("source", "docker")
    observed_at = data["observed_at"]

    row_id = str(uuid.uuid4())
    ts = parse_ts(observed_at)

    payload_json = json.dumps(data, ensure_ascii=False)

    # NOTE:
    # - We now use ON CONFLICT (source_id, hostname, ts) DO NOTHING
    #   to coexist with your unique index on (source_id, hostname, ts).
    sql = f"""\
INSERT INTO public.observed_snapshots (id, source_id, asset_id, hostname, ts, payload)
VALUES (
  '{row_id}',
  '{source}',
  NULL,
  '{hostname}',
  '{ts}',
  $json${payload_json}$json$::jsonb
)
ON CONFLICT (source_id, hostname, ts) DO NOTHING;
"""

    BASE.mkdir(parents=True, exist_ok=True)
    OUTFILE.write_text(sql, encoding="utf-8")

    print(f"[OK] INFILE:  {INFILE}")
    print(f"[OK] OUTFILE: {OUTFILE}")
    print(f"[OK] hostname={hostname} source={source} ts={ts} id={row_id}")


if __name__ == "__main__":
    main()
