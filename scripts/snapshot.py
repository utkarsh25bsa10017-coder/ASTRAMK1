#!/usr/bin/env python3
"""
Freeze the current API results into data/snapshots/ so the dashboard works
offline (e.g. on a venue Wi-Fi that blocks APIs, or if a source rate-limits us).

Usage (with the server running on :8000, after visiting every view once):
    python3 scripts/snapshot.py            # snapshot everything currently cached
    python3 scripts/snapshot.py --warm     # first request every endpoint, then snapshot
"""
import argparse
import json
import shutil
import sys
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CACHE, SNAP = ROOT / "data" / "cache", ROOT / "data" / "snapshots"
ENDPOINTS = ["/api/alerts", "/api/earthquakes", "/api/catalog/stats", "/api/catalog/orbits", "/api/conjunctions", "/api/spaceweather",
             "/api/orbits/gnss", "/api/orbits/gps", "/api/cyclones", "/api/flood/case/dana-2024",
             "/api/flood/case/assam-2024", "/api/flood/case/wayanad-2024"]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--warm", action="store_true")
    ap.add_argument("--base", default="http://127.0.0.1:8000")
    a = ap.parse_args()
    if a.warm:
        for ep in ENDPOINTS:
            try:
                with urllib.request.urlopen(a.base + ep, timeout=300) as r:
                    print(f"warm {ep}: {r.status} ({r.headers.get('X-Astra-Provenance')})")
            except Exception as e:
                print(f"warm {ep}: FAILED {e}")
    SNAP.mkdir(parents=True, exist_ok=True)
    n = 0
    for f in sorted(CACHE.glob("api_*.json")):
        name = f.name[4:]
        if name.startswith(("weather_", "wx_arch_", "gdacs_geom_", "assess_", "geocode_")):
            continue  # per-point/per-event results: not useful as global snapshots
        try:
            json.loads(f.read_text())
        except ValueError:
            continue
        shutil.copy2(f, SNAP / name)
        print(f"snapshot {name:40s} {f.stat().st_size / 1024:8.0f} KB")
        n += 1
    print(f"{n} snapshots written to {SNAP}")
    return 0 if n else 1


if __name__ == "__main__":
    sys.exit(main())
