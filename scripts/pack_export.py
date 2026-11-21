#!/usr/bin/env python3
"""Pack an export of the old (Claude-hosted) tracker into job-tracker-export.zip for import.html.

Usage: pack_export.py <export_dir> <files_dir> <out.zip>
  export_dir/<collection>/<doc_id>.json   one JSON file per record
  files_dir/<asset_id>[.ext]              uploaded files, named by their asset id
"""
import json, mimetypes, os, sys, zipfile

exp, files_dir, out = sys.argv[1:4]
collections, files = {}, {}
for coll in sorted(os.listdir(exp)):
    d = os.path.join(exp, coll)
    if not os.path.isdir(d):
        continue
    for f in sorted(os.listdir(d)):
        if f.endswith(".json"):
            data = json.load(open(os.path.join(d, f)))
            data.pop("id", None)
            collections.setdefault(coll, {})[f[:-5]] = data
with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
    for f in sorted(os.listdir(files_dir)) if os.path.isdir(files_dir) else []:
        aid = f.split(".")[0]
        files[aid] = {"type": mimetypes.guess_type(f)[0] or "application/pdf"}
        z.write(os.path.join(files_dir, f), "files/" + aid)
    z.writestr("data.json", json.dumps({"collections": collections, "files": files}))
print(f"{sum(len(v) for v in collections.values())} records, {len(files)} files -> {out}")
