#!/usr/bin/env python3
"""Issue #18: audited Git-history rewrite plan; GitHub refs only with atomic leases.

prepare: fetch full private bare mirror, scrub local copy, verify all branch and
tag trees/paths retained, save SHA mapping. NEVER pushes.
apply: require externally encrypted backup, frozen remote heads, no open PRs,
and perform one atomic lease-guarded push. Does NOT clear GitHub PR refs/cache.
No credential values or replacement patterns are printed.
"""
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys

REPOSITORY = "gest0r1/my-opencode"
REMOTE = "https://github.com/" + REPOSITORY + ".git"
FIVE_KEYS = (
    "exchange_header", "itop_token", "gdrive_client_id",
    "gdrive_client_secret", "gdrive_refresh_token",
)

def run(args, *, cwd=None, env=None):
    p = subprocess.run(args, cwd=cwd, env=env, stdout=subprocess.PIPE,
                       stderr=subprocess.PIPE, text=True, errors="replace")
    if p.returncode:
        # Git stderr can contain sensitive paths/transport information. Never echo it.
        raise RuntimeError("Git/subprocess operation failed: " + str(args[0]) +
                           " (exit=" + str(p.returncode) + ")")
    return p.stdout

def git(repo, *args, env=None):
    return run(["git", "-C", str(repo), *args], env=env)

def refs(repo):
    output = git(repo, "for-each-ref", "--format=%(refname) %(objectname)",
                 "refs/heads", "refs/tags")
    return dict(line.split(" ", 1) for line in output.splitlines() if line.strip())

def tree_entries(repo, ref):
    raw = subprocess.run(["git", "-C", str(repo), "ls-tree", "-r", "-z", ref],
                         stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if raw.returncode: raise RuntimeError("Cannot inspect tree")
    result = []
    for row in raw.stdout.split(b"\0"):
        if not row: continue
        meta, sep, path = row.partition(b"\t")
        if not sep: raise RuntimeError("Malformed tree entry")
        parts = meta.split()
        if len(parts) != 3: raise RuntimeError("Invalid tree entry")
        # Preserve every path, file type and mode; blob SHA is expected to change.
        result.append((parts[0], parts[1], path))
    return result

def git_env(root):
    askpass = root / "private-askpass.sh"
    askpass.write_text("#!/bin/sh\n"
                       "case \"$1\" in\n"
                       " *Username*|*username*) printf 'x-access-token' ;;\n"
                       " *Password*|*password*) printf '%s' \"$GH_TOKEN\" ;;\n"
                       " *) exit 1 ;;\n"
                       "esac\n", encoding="utf-8")
    askpass.chmod(0o700)
    return dict(os.environ, GIT_ASKPASS=str(askpass), GIT_TERMINAL_PROMPT="0")

def prepare(root):
    if os.environ.get("GITHUB_REPOSITORY") != REPOSITORY:
        raise RuntimeError("Wrong repository")
    if root.exists(): raise RuntimeError("Working directory already exists")
    root.mkdir(mode=0o700)
    original, clean = root / "original.git", root / "clean.git"
    env = git_env(root)
    run(["git", "clone", "--mirror", REMOTE, str(original)], env=env)
    # GitHub pull refs are read for analysis, not writable via push.
    git(original, "fetch", "--no-tags", "origin",
        "+refs/pull/*/head:refs/pull/*/head", env=env)
    before = refs(original)
    if "refs/heads/main" not in before or len(before) < 2:
        raise RuntimeError("Main or branch inventory unavailable")
    run(["git", "clone", "--no-hardlinks", "--mirror", str(original), str(clean)])
    git(clean, "remote", "set-url", "origin", REMOTE)
    replacements = root / "replace-private.txt"
    run(["python3", "scripts/build-history-replacements.py", str(replacements)], cwd=clean)
    run(["bash", "scripts/security-history-rewrite.sh", str(replacements)],
        cwd=clean, env=dict(env, ISSUE18_APPROVE_LOCAL_REWRITE="yes"))
    after = refs(clean)
    if set(before) != set(after):
        raise RuntimeError("Remote HEAD/TAG names changed by rewrite")
    if before["refs/heads/main"] == after["refs/heads/main"]:
        raise RuntimeError("Unexpected identical main after removing historic secrets")
    for name in before:
        if tree_entries(original, before[name]) != tree_entries(clean, after[name]):
            raise RuntimeError("Tree paths/types/modes changed unexpectedly: " + name)
    scan = run(["python3", "scripts/scan-history-candidates.py"], cwd=clean)
    for label in FIVE_KEYS:
        marker = "HISTORY_AUDIT candidate_blobs_" + label + "=0"
        if marker not in scan:
            raise RuntimeError("Cleaned mirror still contains candidate key type: " + label)
    run(["git", "-C", str(clean), "fsck", "--strict", "--no-reflogs"])
    state = {"repository": REPOSITORY, "before": before, "after": after,
             "updated_refs": sum(a != before[n] for n, a in after.items()),
             "pr_refs_in_original": len(git(original, "for-each-ref",
                                              "--format=%(refname)", "refs/pull").splitlines())}
    (root / "plan.json").write_text(json.dumps(state, indent=2) + "\n", encoding="utf-8")
    (root / "plan.json").chmod(0o600)
    # Do not leave private replacement values after plan generation.
    replacements.unlink(missing_ok=True)
    print("ISSUE18_REWRITE_PLAN status=PASS refs=" + str(len(before)) +
          " changed=" + str(state["updated_refs"]) +
          " pull_refs_readonly=" + str(state["pr_refs_in_original"]) +
          " secret_classes_after=0")
    print("ISSUE18_REWRITE_PLAN: no remote references modified")

def apply(root):
    if os.environ.get("GITHUB_REPOSITORY") != REPOSITORY:
        raise RuntimeError("Wrong repository")
    if os.environ.get("ISSUE18_REWRITE_APPLY") != "yes":
        raise RuntimeError("Explicit apply flag missing")
    if os.environ.get("ISSUE18_ENCRYPTED_BACKUP_VERIFIED") != "yes":
        raise RuntimeError("Encrypted backup must be uploaded successfully first")
    state = json.loads((root / "plan.json").read_text())
    if state.get("repository") != REPOSITORY: raise RuntimeError("Invalid plan")
    before, after = state["before"], state["after"]
    env = git_env(root)
    clean = root / "clean.git"
    try:
        open_prs = json.loads(run(["gh", "api",
            "repos/" + REPOSITORY + "/pulls?state=open&per_page=100"], env=env))
    except Exception:
        raise RuntimeError("Unable to verify open PR list")
    if open_prs: raise RuntimeError("Open PRs exist: merge/close before history rewrite")
    remote_refs = run(["git", "-C", str(clean), "ls-remote", "--heads", "--tags", "origin"], env=env)
    observed = dict((ref,sha) for sha,ref in
                    (line.split("\t", 1) for line in remote_refs.splitlines() if "\t" in line)
                    if not ref.endswith("^{}"))
    if observed != before:
        raise RuntimeError("Remote refs changed during preparation; abort without push")
    specs, leases = [], []
    for name in sorted(before):
        if before[name] == after[name]: continue
        leases.append("--force-with-lease=" + name + ":" + before[name])
        specs.append(after[name] + ":" + name)
    if not specs: raise RuntimeError("Nothing to rewrite")
    # Git server must support atomic transactions. If not, fail without writes.
    run(["git", "-C", str(clean), "push", "--atomic", "--dry-run",
         *leases, "origin", *specs], env=env)
    run(["git", "-C", str(clean), "push", "--atomic",
         *leases, "origin", *specs], env=env)
    verified = run(["git", "-C", str(clean), "ls-remote", "--heads", "--tags", "origin"], env=env)
    refreshed = dict((ref,sha) for sha,ref in
                     (line.split("\t", 1) for line in verified.splitlines() if "\t" in line)
                     if not ref.endswith("^{}"))
    if refreshed != after: raise RuntimeError("Remote refs differ after atomic push")
    print("ISSUE18_REWRITE_APPLIED refs=" + str(len(after)) +
          " changed=" + str(len(specs)) +
          " status=PASS; PR refs and GitHub cached objects still require Support cleanup")

if __name__ == "__main__":
    try:
        if len(sys.argv) != 3: raise RuntimeError("Usage: tool prepare|apply ABSOLUTE_SCRATCH_DIR")
        root = Path(sys.argv[2])
        if not root.is_absolute(): raise RuntimeError("Scratch path must be absolute")
        if sys.argv[1] == "prepare": prepare(root)
        elif sys.argv[1] == "apply": apply(root)
        else: raise RuntimeError("Unsupported action")
    except Exception as exc:
        print("ISSUE18_REWRITE_STOP: " + str(exc), file=sys.stderr)
        sys.exit(2)
