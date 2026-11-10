#!/usr/bin/env python3
"""Read-only scan of reachable Git blobs; print counts, never matched values."""
import collections
import re
import subprocess
import sys
import tempfile

PATTERNS = {
    "exchange_header": re.compile(rb'"X-API-Key"\s*:\s*"(?!\s*\{env:)[^"\r\n]{10,}"', re.I),
    "itop_token": re.compile(rb'"ITOP_TOKEN"\s*:\s*"(?!\s*\{env:)[^"\r\n]{10,}"', re.I),
    "gdrive_client_secret": re.compile(rb'"GDRIVE_MCP_CLIENT_SECRET"\s*:\s*"(?!\s*\{env:)[^"\r\n]{10,}"', re.I),
    "gdrive_refresh_token": re.compile(rb'"GDRIVE_MCP_REFRESH_TOKEN"\s*:\s*"(?!\s*\{env:)[^"\r\n]{10,}"', re.I),
    "gdrive_client_id": re.compile(rb'"GDRIVE_MCP_CLIENT_ID"\s*:\s*"(?!\s*\{env:)[^"\r\n]{10,}"', re.I),
    "private_key": re.compile(rb'-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----'),
    "github_token": re.compile(rb'\bgh(?:p|o|u|s|r)_[A-Za-z0-9_]{25,}'),
    "openai_like_token": re.compile(rb'\bsk-[A-Za-z0-9_-]{24,}'),
    "generic_credential": re.compile(rb'(?im)^\s*(?:password|api[_-]?key|secret|refresh[_-]?token)\s*[:=]\s*["\x27]?[^\s"\x27#{]{16,}'),
}

def scan():
    if subprocess.check_output(["git", "rev-parse", "--is-shallow-repository"], text=True).strip() != "false":
        raise RuntimeError("Shallow Git history")
    refs = subprocess.check_output(["git", "for-each-ref", "--format=%(refname)"], text=True).splitlines()
    ids = sorted(set(subprocess.check_output(["git", "rev-list", "--all", "--objects", "--no-object-names"], text=True).splitlines()))
    counts = collections.Counter()
    skipped = blobs = 0
    with tempfile.TemporaryFile() as requests:
        for oid in ids:
            if not re.fullmatch(r"[0-9a-f]{40,64}", oid):
                raise RuntimeError("Invalid object ID")
            requests.write(oid.encode() + b"\n")
        requests.seek(0)
        proc = subprocess.Popen(["git", "cat-file", "--batch"], stdin=requests, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
        try:
            for _ in ids:
                header = proc.stdout.readline().split()
                if len(header) != 3:
                    raise RuntimeError("Malformed git object header")
                kind, size = header[1], int(header[2])
                if size > 32_000_000:
                    skipped += 1
                    remaining = size + 1
                    while remaining:
                        chunk = proc.stdout.read(min(65536, remaining))
                        if not chunk: raise RuntimeError("Truncated object")
                        remaining -= len(chunk)
                    continue
                data = proc.stdout.read(size)
                if len(data) != size or proc.stdout.read(1) != b"\n":
                    raise RuntimeError("Truncated git object")
                if kind != b"blob": continue
                blobs += 1
                for label, regex in PATTERNS.items():
                    if regex.search(data): counts[label] += 1
            if proc.wait(timeout=30):
                raise RuntimeError("git cat-file failed")
        finally:
            if proc.poll() is None: proc.kill()
    print(f"HISTORY_AUDIT refs={len(refs)} objects={len(ids)} blobs={blobs} skipped_over_32MB={skipped}")
    for label in PATTERNS:
        print(f"HISTORY_AUDIT candidate_blobs_{label}={counts[label]}")
    print("HISTORY_AUDIT INFO: regex candidates can include placeholders; this audit cannot prove absence of all secrets.")

if __name__ == "__main__":
    try:
        scan()
    except Exception as exc:
        print("HISTORY_AUDIT_FAILED: " + type(exc).__name__, file=sys.stderr)
        sys.exit(2)
