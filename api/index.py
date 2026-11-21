"""
Vercel serverless entry point: runs the same /api/* gateway as server/app.py.
Static files (web/) are served by Vercel directly via rewrites in vercel.json.
"""
import sys
import urllib.parse
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "server"))
import app  # noqa: E402


class handler(app.Handler):
    def do_GET(self):
        u = urllib.parse.urlparse(self.path)
        # Depending on the rewrite, Vercel may hand us /api/index.py?path=... instead of the original path.
        if not u.path.startswith("/api/") or u.path.startswith("/api/index"):
            qs = urllib.parse.parse_qs(u.query)
            sub = (qs.pop("path", [""])[0] or "").lstrip("/")
            rest = urllib.parse.urlencode({k: v[0] for k, v in qs.items()})
            self.path = f"/api/{sub}" + (f"?{rest}" if rest else "")
        if not self.path.startswith("/api/"):
            self.path = "/api/health"
        return super().do_GET()
