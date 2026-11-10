#!/usr/bin/env python3
"""Audit generic credential candidates in Git blobs; never print values."""
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
                    # Print only key, source blob, path and syntax category.
                    # No values, context lines, hashes of values or snippets.
                    key=hit.group(1).decode('ascii','replace').lower()
                    path=objects[oid]
                    path=path if path and SAFE_PATH.fullmatch(path) else '<unknown>'
                    value=hit.group(2)
                    if value.startswith((b'$', b'\x60')) or b'$' in value:
                        shape='shell_expression'
                    elif b'(' in value or b')' in value or b'+' in value:
                        shape='source_expression'
                    elif re.fullmatch(rb'[A-Za-z_][A-Za-z0-9_.]*', value):
                        shape='identifier_or_literal'
                    else:
                        shape='unclassified_literal'
                    matches.append((oid[:12],key,path,shape))
            if proc.wait(timeout=30): raise RuntimeError('git cat-file failed')
        finally:
            if proc.poll() is None: proc.kill()
    for oid,key,path,shape in sorted(set(matches)):
        print(f'GENERIC_CANDIDATE blob={oid} key={key} path={path} value_syntax={shape} status=UNCLASSIFIED')
    print(f'GENERIC_CANDIDATE total_matches={len(matches)} unique_blobs={len(set(x[0] for x in matches))}')
    print('GENERIC_CANDIDATE manual review required; syntax alone does not prove a value is safe.')

if __name__=='__main__':
    try: inspect()
    except Exception as exc:
        print('GENERIC_INSPECTION_FAILED: '+type(exc).__name__,file=sys.stderr)
        sys.exit(2)
