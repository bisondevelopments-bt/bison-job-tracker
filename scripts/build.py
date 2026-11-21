#!/usr/bin/env python3
"""Build the live site into ./site from app/tracker.html (the tracker as built in Claude).

Reads SUPABASE_URL, SUPABASE_ANON_KEY and TEAM_EMAIL from the environment
(GitHub repository variables in the deploy workflow). These are public by design.
"""
import json, os, re, shutil, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SITE = os.path.join(ROOT, "site")
SUPABASE_JS = "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/dist/umd/supabase.min.js"

url = os.environ.get("SUPABASE_URL", "").strip().rstrip("/")
anon = os.environ.get("SUPABASE_ANON_KEY", "").strip()
team = os.environ.get("TEAM_EMAIL", "").strip()
if not url or not anon:
    sys.exit("Set SUPABASE_URL and SUPABASE_ANON_KEY (GitHub: Settings > Secrets and variables > Actions > Variables).")

shutil.rmtree(SITE, ignore_errors=True)
os.makedirs(SITE)

HEAD = f"""<meta name="theme-color" content="#1D2733">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="apple-mobile-web-app-title" content="Job Tracker">
<link rel="manifest" href="manifest.webmanifest">
<link rel="apple-touch-icon" href="icon-180.png">
<link rel="icon" href="icon-192.png">
<script src="config.js"></script>
<script src="{SUPABASE_JS}"></script>
<script src="jt-adapter.js"></script>
"""

def page(src_name, out_name):
    html = open(os.path.join(ROOT, src_name), encoding="utf-8").read()
    # Uploaded files: Claude served them at /_blob/<id>; here sw.js serves them at blob/<id> (inside the site).
    html = html.replace("/_blob/", "blob/")
    # Wording that pointed people to Claude's own settings.
    html = html.replace("Open the tracker in Claude and allow it to ask Claude when prompted.", "The assistant isn't available right now. Try again in a minute.")
    html = html.replace("Connect the Bison Gmail in claude.ai settings.", "Check the Gmail app password in the server settings.")
    if "</head>" not in html:
        sys.exit(f"{src_name}: no </head> found")
    html = html.replace("</head>", HEAD + "</head>", 1)
    open(os.path.join(SITE, out_name), "w", encoding="utf-8").write(html)

page("app/tracker.html", "index.html")
page("app/import.html", "import.html")

open(os.path.join(SITE, "config.js"), "w").write(
    "window.JT_CONFIG=" + json.dumps({"url": url, "anon": anon, "teamEmail": team}) + ";\n")
for f in ("jt-adapter.js", "sw.js"):
    shutil.copy(os.path.join(ROOT, f), SITE)
for f in os.listdir(os.path.join(ROOT, "static")):
    shutil.copy(os.path.join(ROOT, "static", f), SITE)
json.dump({
    "name": "Bison Job Tracker", "short_name": "Job Tracker", "start_url": "./", "scope": "./",
    "display": "standalone", "background_color": "#1D2733", "theme_color": "#1D2733",
    "icons": [{"src": "icon-192.png", "sizes": "192x192", "type": "image/png"},
              {"src": "icon-512.png", "sizes": "512x512", "type": "image/png"}],
}, open(os.path.join(SITE, "manifest.webmanifest"), "w"))
open(os.path.join(SITE, ".nojekyll"), "w").close()
print("Built", sorted(os.listdir(SITE)))
