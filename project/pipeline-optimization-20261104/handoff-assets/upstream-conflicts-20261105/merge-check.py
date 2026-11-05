#!/usr/bin/env python3
"""Re-run three-way merge-file checks on exact GitHub blob snapshots."""
import json
import pathlib
import subprocess

ROOT = pathlib.Path(__file__).parent
INPUTS = ROOT / "input-blobs"
RESULTS = ROOT / "merge-results"
RESULTS.mkdir(exist_ok=True)
manifest = [json.loads(line) for line in (ROOT / "manifest.jsonl").read_text().splitlines() if line]
entries = [row for row in manifest if row.get("category") == "both_modified_text"]
summary = {"clean": 0, "conflict_files": 0, "conflict_regions": 0, "errors": []}
for row in entries:
    i = row["merge_index"]
    p = subprocess.run(
        ["git", "merge-file", "-p", "-L", "feature", "-L", "base", "-L", "upstream",
         str(INPUTS / f"{i}.ours"), str(INPUTS / f"{i}.base"), str(INPUTS / f"{i}.upstream")],
        capture_output=True,
    )
    markers = p.stdout.count(b"<<<<<<< ")
    (RESULTS / f"{i}.merged").write_bytes(p.stdout)
    if p.returncode == 0 and markers == 0:
        summary["clean"] += 1
    elif p.returncode == markers and markers > 0:
        summary["conflict_files"] += 1
        summary["conflict_regions"] += markers
        row["conflict_regions"] = markers
    else:
        summary["errors"].append({"path": row["path"], "code": p.returncode, "markers": markers,
                                  "stderr": p.stderr.decode("utf-8", errors="replace")})
(ROOT / "merge-results.json").write_text(json.dumps(summary, indent=2) + "\n")
print(json.dumps(summary, indent=2))
