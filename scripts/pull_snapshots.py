#!/usr/bin/env python3
"""
Refresh data/snapshots/ from a running ASTRA deployment (for example the Vercel site),
one endpoint at a time. Useful right before a demo, or when CelesTrak rate-limits your laptop.

    python3 scripts/pull_snapshots.py https://astramk1.vercel.app
"""
import gzip
import json
import sys
import time
import urllib.request
from pathlib import Path

SNAP = Path(__file__).resolve().parent.parent / "data" / "snapshots"


def get(base, path):
    req = urllib.request.Request(base.rstrip("/") + path, headers={"Accept-Encoding": "gzip", "User-Agent": "ASTRA-snapshot/1.0"})
    with urllib.request.urlopen(req, timeout=180) as r:
        body = r.read()
        if r.headers.get("Content-Encoding") == "gzip":
            body = gzip.decompress(body)
        return json.loads(body), r.headers.get("X-Astra-Provenance")


def save(name, obj):
    (SNAP / f"{name}.json").write_text(json.dumps(obj, separators=(",", ":")))
    print(f"  saved {name}.json ({(SNAP / f'{name}.json').stat().st_size // 1024} KB)")


def main():
    base = sys.argv[1] if len(sys.argv) > 1 else "https://astramk1.vercel.app"
    SNAP.mkdir(parents=True, exist_ok=True)
    jobs = [
        ("conjunctions", "/api/conjunctions", lambda d: "closest" in d),
        ("catalog_stats", "/api/catalog/stats", lambda d: "onOrbit" in d),
        ("earthquakes", "/api/earthquakes", lambda d: "events" in d),
        ("spaceweather", "/api/spaceweather", lambda d: "kp" in d),
        ("orbits_gnss", "/api/orbits/gnss", lambda d: "sats" in d),
        ("orbits_gps", "/api/orbits/gps", lambda d: "sats" in d),
    ]
    for name, path, ok in jobs:              # one at a time, never in parallel
        try:
            d, prov = get(base, path)
            print(f"{path}: {prov}")
            if ok(d):
                save(name, d)
        except Exception as e:
            print(f"{path}: FAILED {e}")
        time.sleep(1)
    for part in ("payloads", "rocket-bodies", "debris"):
        try:
            d, prov = get(base, f"/api/catalog/orbits?part={part}")
            print(f"orbits {part}: {prov} · {d.get('source')} · {d.get('count')}")
            if d.get("sats") and d.get("count", 0) > 500:
                save(f"orbits_part_{part}", {"part": part, "source": f"{d.get('source')} (snapshot)", "fetched": d.get("generated"),
                                             "sats": [r[:4] for r in d["sats"]]})
        except Exception as e:
            print(f"orbits {part}: FAILED {e}")
        time.sleep(1)
    try:
        d, prov = get(base, "/api/alerts")
        print(f"/api/alerts: {prov}")
        by = {}
        for a in d.get("alerts", []):
            by.setdefault(a["source"], []).append(a)
        for src, rows in by.items():
            save(f"alerts_{src}", rows)
    except Exception as e:
        print(f"/api/alerts: FAILED {e}")


if __name__ == "__main__":
    main()
