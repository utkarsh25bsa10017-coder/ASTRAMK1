#!/usr/bin/env python3
"""
ASTRA server: serves the web app and the /api data gateway.

    python3 server/app.py            # http://localhost:8000
    python3 server/app.py --port 9000
"""
from __future__ import annotations

import argparse
import gzip
import json
import sys
import threading
import time
import traceback
import urllib.parse
from concurrent.futures import ThreadPoolExecutor
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import gateway  # noqa: E402
import sources  # noqa: E402
import hazard  # noqa: E402

WEB_DIR = gateway.ROOT / "web"


def _q(qs, name, default=None):
    v = qs.get(name)
    return v[0] if v else default


CACHE_PREFIX = {"sachet_": "sachet", "gdacs_": "gdacs", "usgs_": "usgs", "eonet_": "eonet", "om_": "openmeteo",
                "ibtracs_": "ibtracs", "s1_": "planetary", "satcat_": "satcat", "socrates_": "socrates",
                "gp_": "celestrak", "tlebak_": "tle-backup", "satnogs_": "satnogs", "swpc_": "swpc",
                "ncs_": "ncs", "emsc_": "emsc", "geo_": "geocode", "rev_": "geocode", "elev_": "openmeteo",
                "glofas_": "openmeteo", "hz_wx_": "openmeteo"}


def _health_with_cache():
    """Live fetch health, completed with the age of on-disk cache for sources not fetched since start."""
    h = gateway.health()
    newest = {}
    for f in gateway.CACHE_DIR.glob("raw_*"):
        key = f.name[4:]
        src = next((s for pre, s in CACHE_PREFIX.items() if key.startswith(pre)), None)
        if src and (src not in newest or f.stat().st_mtime > newest[src].stat().st_mtime):
            newest[src] = f
    for src, f in newest.items():
        if src not in h:
            h[src] = {"ok": 0, "fail": 0, "last_status": "cache", "last_time": f.stat().st_mtime,
                      "last_ms": None, "last_detail": "", "last_bytes": f.stat().st_size}
    return h


def route(path: str, qs: dict):
    """Return (payload, provenance)."""
    p = path.rstrip("/")
    if p == "/api/health":
        return {"ok": True, "time": time.time()}, "live"
    if p == "/api/alerts":
        return sources.alerts()
    if p == "/api/gdacs/geometry":
        return sources.gdacs_geometry(_q(qs, "type", ""), _q(qs, "id", ""), _q(qs, "episode", ""))
    if p == "/api/weather":
        return sources.weather(_q(qs, "lat"), _q(qs, "lon"))
    if p == "/api/weather/archive":
        return sources.weather_archive(_q(qs, "lat"), _q(qs, "lon"), _q(qs, "start", ""), _q(qs, "end", ""))
    if p == "/api/cyclones":
        return sources.cyclones()
    if p == "/api/flood/cases":
        return sources.flood_cases()
    if p.startswith("/api/flood/case/"):
        return sources.flood_case(p.rsplit("/", 1)[-1])
    if p == "/api/catalog/stats":
        return sources.catalog_stats()
    if p == "/api/catalog/orbits":
        return sources.catalog_orbits()
    if p.startswith("/api/orbits/"):
        return sources.orbit_set(p.rsplit("/", 1)[-1])
    if p == "/api/conjunctions":
        return sources.conjunctions()
    if p == "/api/spaceweather":
        return sources.spaceweather()
    if p == "/api/earthquakes":
        return hazard.earthquakes()
    if p == "/api/geocode":
        return hazard.geocode(_q(qs, "q", ""))
    if p == "/api/assess":
        return hazard.assess(_q(qs, "lat"), _q(qs, "lon"))
    if p == "/api/gateway":
        return {"sources": sources.registry(), "health": _health_with_cache()}, "live"
    raise KeyError(p)


class Handler(SimpleHTTPRequestHandler):
    server_version = "ASTRA/1.0"

    def __init__(self, *a, **kw):
        super().__init__(*a, directory=str(WEB_DIR), **kw)

    def log_message(self, fmt, *args):
        if "/api/" in (args[0] if args else ""):
            sys.stderr.write("[api] " + (fmt % args) + "\n")

    def end_headers(self):
        if not self.path.startswith("/api/"):
            self.send_header("Cache-Control", "no-cache" if self.path.endswith((".html", ".js", ".css", "/")) else "max-age=86400")
        super().end_headers()

    def do_GET(self):
        u = urllib.parse.urlparse(self.path)
        if not u.path.startswith("/api/"):
            return super().do_GET()
        qs = urllib.parse.parse_qs(u.query)
        try:
            payload, prov = route(u.path, qs)
            self._json(200, payload, prov)
        except KeyError:
            self._json(404, {"error": "unknown endpoint"}, "none")
        except ValueError as e:
            self._json(400, {"error": str(e)}, "none")
        except gateway.SourceUnavailable as e:
            self._json(503, {"error": "source unavailable", "detail": str(e)[:300]}, "none")
        except Exception as e:
            traceback.print_exc()
            self._json(500, {"error": type(e).__name__, "detail": str(e)[:300]}, "none")

    def _json(self, code, payload, prov):
        body = json.dumps(payload, separators=(",", ":")).encode()
        gz = "gzip" in (self.headers.get("Accept-Encoding") or "") and len(body) > 1024
        if gz:
            body = gzip.compress(body, compresslevel=5)
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("X-Astra-Provenance", prov)
        self.send_header("Access-Control-Expose-Headers", "X-Astra-Provenance")
        self.send_header("Cache-Control", "no-store")
        if gz:
            self.send_header("Content-Encoding", "gzip")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def warm():
    """Prefetch slow sources in the background so the first page load is fast."""
    jobs = [sources.alerts, hazard.earthquakes, sources.catalog_stats, sources.conjunctions, sources.spaceweather,
            sources.catalog_orbits, lambda: sources.orbit_set("gnss"), lambda: sources.orbit_set("gps"),
            sources.cyclones, lambda: sources.flood_case("dana-2024")]

    def run(fn):
        t0 = time.time()
        try:
            _, prov = fn()
            print(f"[warm] {getattr(fn, '__name__', 'job')}: {prov} in {time.time() - t0:.1f}s")
        except Exception as e:
            print(f"[warm] {getattr(fn, '__name__', 'job')} failed: {e}")

    with ThreadPoolExecutor(max_workers=4) as ex:
        list(ex.map(run, jobs))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8000)
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--no-warm", action="store_true")
    args = ap.parse_args()
    if not args.no_warm:
        threading.Thread(target=warm, daemon=True).start()
    srv = ThreadingHTTPServer((args.host, args.port), Handler)
    print(f"ASTRA running at http://{args.host}:{args.port}")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
