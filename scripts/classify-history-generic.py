#!/usr/bin/env python3
"""Read-only inspection of generic credential candidates. NEVER print captured values."""
import collections
import re
import subprocess
import sys
import tempfile

PATTERN = re.compile(rb'''(?im)^\s*(password|api[_-]?key|secret|refresh[_-]?token)\s*[:=]\s*["']?([^\s"'#{]{16,})''')
SAFE_PATH = re.compile(r'^[A-Za-z0-9._/\-]+$')

def inspect():
    raw = subprocess.check_output(['git','rev-list','--all','--objects'])
    objects = {}
    for line in raw.splitlines():
        oid, _, path = line.partition(b' ')
        if not re.fullmatch(rb'[0-9a-f]{40,64}', oid): raise RuntimeError('bad sha')
        objects.setdefault(oid.decode(), path.decode('utf-8', 'replace') if path else None)
    observations = collections.defaultdict(lambda:collections.Counter())
    matches = []
    with tempfile.TemporaryFile() as requests:
        for oid in objects: requests.write(oid.encode() + b'\n')
        requests.seek(0)
        proc = subprocess.Popen(['git','cat-file','--batch'],stdin=requests,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL)
        try:
            for oid in objects:
                header=proc.stdout.readline().split()
                if len(header)!=3: raise RuntimeError('malformed object')
                kind,size=header[1],int(header[2])
                if size>32000000: raise RuntimeError('oversize blob needs separate scan')
                content=proc.stdout.read(size)
                if len(content)!=size or proc.stdout.read(1)!=b'\n': raise RuntimeError('corrupt git object')
                if kind!=b'blob': continue
                for hit in PATTERN.finditer(content):
                    # Only metadata about *what* matched, never secrets, tokens
                    # or surrounding code. A suspicious candidate is NEVER
                    # treated as a placeholder merely by this heuristic.
                    key=hit.group(1).decode('ascii','replace').lower()
                    path=objects[oid]
                    path=path if path and SAFE_PATH.fullmatch(path) else '<unknown>'
                    group=path.split('/')[0] if path!='<unknown>' else 'unknown'
                    observations[key][group]+=1
                    matches.append((oid[:12], key, path))
            if proc.wait(timeout=30): raise RuntimeError('git cat-file failed')
        finally:
            if proc.poll() is None: proc.kill()
    for oid,key,path in sorted(set(matches)):
        print(f'GENERIC_CANDIDATE blob={oid} key={key} path={path} status=UNCLASSIFIED')
    print(f'GENERIC_CANDIDATE total_matches={len(matches)} unique_blobs={len(set(x[0] for x in matches))}')
    print('GENERIC_CANDIDATE manual review required: this report does not distinguish secrets from code identifiers.')

if __name__=='__main__':
    try: inspect()
    except Exception as exc:
        print('GENERIC_INSPECTION_FAILED: '+type(exc).__name__,file=sys.stderr)
        sys.exit(2)
