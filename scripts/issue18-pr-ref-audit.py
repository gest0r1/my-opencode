#!/usr/bin/env python3
"""Redacted, read-only report: which GitHub PR refs still contain historic key blobs.
Never prints key values, excerpts or file contents. Requires fetched refs/audit/pull-*.
"""
import collections
import re
import subprocess
import sys
import tempfile

PATTERNS={
  "exchange_header":re.compile(rb'"X-API-Key"\s*:\s*"(?!(?:\{env:|\$\{))[^"\r\n]{10,}"',re.I),
  "itop_token":re.compile(rb'"ITOP_TOKEN"\s*:\s*"(?!(?:\{env:|\$\{))[^"\r\n]{10,}"',re.I),
  "gdrive_client_id":re.compile(rb'"GDRIVE_MCP_CLIENT_ID"\s*:\s*"(?!(?:\{env:|\$\{))[^"\r\n]{10,}"',re.I),
  "gdrive_client_secret":re.compile(rb'"GDRIVE_MCP_CLIENT_SECRET"\s*:\s*"(?!(?:\{env:|\$\{))[^"\r\n]{10,}"',re.I),
  "gdrive_refresh_token":re.compile(rb'"GDRIVE_MCP_REFRESH_TOKEN"\s*:\s*"(?!(?:\{env:|\$\{))[^"\r\n]{10,}"',re.I)
}
def git(*args):
    return subprocess.check_output(['git',*args],stderr=subprocess.DEVNULL)
def main():
    refs=git('for-each-ref','--format=%(refname)','refs/audit/pull-head','refs/audit/pull-merge').decode().splitlines()
    if not refs: raise RuntimeError('No GitHub PR refs fetched')
    objects=sorted(set(git('rev-list','--objects','--no-object-names',*refs).splitlines()))
    bad=collections.defaultdict(set)
    with tempfile.TemporaryFile() as requests:
        for oid in objects: requests.write(oid+b'\n')
        requests.seek(0)
        proc=subprocess.Popen(['git','cat-file','--batch'],stdin=requests,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL)
        try:
            for oid in objects:
                header=proc.stdout.readline().split()
                if len(header)!=3: raise RuntimeError('Bad Git object header')
                kind,size=header[1],int(header[2])
                if size>32000000: raise RuntimeError('Oversize object: manual inspection required')
                data=proc.stdout.read(size)
                if len(data)!=size or proc.stdout.read(1)!=b'\n': raise RuntimeError('Truncated Git object')
                if kind!=b'blob': continue
                for name,regex in PATTERNS.items():
                    if regex.search(data):bad[oid.decode()].add(name)
            if proc.wait(timeout=30): raise RuntimeError('git cat-file failed')
        finally:
            if proc.poll() is None:proc.kill()
    impacted={}
    for ref in refs:
        match=re.fullmatch(r'refs/audit/pull-(head|merge)/([0-9]+)',ref)
        if not match:raise RuntimeError('Unexpected PR ref namespace')
        oidlist=set(x.decode() for x in git('rev-list','--objects','--no-object-names',ref).splitlines())
        classes=set().union(*(bad[oid] for oid in oidlist if oid in bad))
        if classes:impacted.setdefault(int(match.group(2)),set()).update(classes)
    for number,classes in sorted(impacted.items()):
        print('ISSUE18_PR_AFFECTED number='+str(number)+' classes='+','.join(sorted(classes)))
    print('ISSUE18_PR_SUMMARY fetched_refs='+str(len(refs))+' affected_prs='+str(len(impacted))+' distinct_secret_blobs='+str(len(bad)))
    print('ISSUE18_PR_SUMMARY GitHub Support must invalidate affected refs/caches; no refs modified')
if __name__=='__main__':
    try:main()
    except Exception as exc:
        print('ISSUE18_PR_AUDIT_STOP: '+type(exc).__name__,file=sys.stderr)
        sys.exit(2)
