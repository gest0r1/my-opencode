#!/usr/bin/env python3
"""Narrow privileged checkpoint ledger for my-opencode. Owner actions are root-only.

The agent is allowed to submit/read/consume *existing* owner decisions, never
approve one. The installer grants exactly ``script agent`` through sudoers;
there is no arbitrary-argument sudo grant. A decision is tied to the complete
immutable checkpoint tuple and consumed idempotently.
"""
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import sqlite3
import sys
import time

DEFAULT_ROOT = Path('/var/lib/my-opencode-approval')
SHA = re.compile(r'^[a-f0-9]{64}$')
GIT_SHA = re.compile(r'^[a-f0-9]{40}$')
IDENT = re.compile(r'^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$')
ALLOWED = {'plan.final_manifest.approve', 'owner.accept'}
FIELDS = ('run_instance_id', 'run_id', 'operation', 'pipeline_id', 'stage',
          'generation', 'manifest_sha256', 'subject_sha256', 'candidate_sha')


def err(code):
    raise ValueError(code)


def root_dir():
    # Test isolation never active in the installed privileged helper.
    if os.geteuid() != 0 and os.getenv('MY_OPENCODE_APPROVAL_TEST_ROOT'):
        return Path(os.environ['MY_OPENCODE_APPROVAL_TEST_ROOT'])
    return DEFAULT_ROOT


def database():
    base = root_dir()
    base.mkdir(mode=0o700, parents=True, exist_ok=True)
    if base.is_symlink() or base.stat().st_mode & 0o077:
        err('UNSAFE_LEDGER_DIRECTORY')
    file = base / 'ledger.sqlite3'
    if file.is_symlink():
        err('UNSAFE_LEDGER_PATH')
    conn = sqlite3.connect(str(file), timeout=15.0, isolation_level=None)
    if file.stat().st_mode & 0o077:
        os.chmod(file, 0o600)
    conn.execute('PRAGMA journal_mode=WAL')
    conn.execute('PRAGMA busy_timeout=15000')
    conn.execute('''CREATE TABLE IF NOT EXISTS approvals (
        id TEXT PRIMARY KEY, subject_key TEXT UNIQUE NOT NULL, tuple_json TEXT NOT NULL,
        nonce TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
        decision TEXT NOT NULL, decided_at INTEGER, consumed_at INTEGER
    )''')
    return conn


def clean_tuple(value):
    if not isinstance(value, dict) or set(value) != set(FIELDS):
        err('INVALID_CHECKPOINT_FIELDS')
    if value['operation'] not in ALLOWED:
        err('INVALID_OPERATION')
    for name in ('run_instance_id', 'run_id', 'pipeline_id', 'stage'):
        if not isinstance(value[name], str) or not IDENT.fullmatch(value[name]):
            err('INVALID_' + name.upper())
    if type(value['generation']) is not int or not 1 <= value['generation'] <= 1000000:
        err('INVALID_GENERATION')
    for name in ('manifest_sha256', 'subject_sha256'):
        if not isinstance(value[name], str) or not SHA.fullmatch(value[name]):
            err('INVALID_' + name.upper())
    candidate = value['candidate_sha']
    if not isinstance(candidate, str) or (candidate and not (GIT_SHA.fullmatch(candidate) or SHA.fullmatch(candidate))):
        err('INVALID_CANDIDATE_SHA')
    if value['operation'] == 'owner.accept' and not candidate:
        err('CANDIDATE_SHA_REQUIRED')
    canonical = json.dumps(value, sort_keys=True, separators=(',', ':'))
    return canonical, hashlib.sha256(canonical.encode()).hexdigest()


def checked_id(value):
    if not isinstance(value, str) or not re.fullmatch(r'[a-f0-9]{32}', value):
        err('INVALID_REQUEST_ID')
    return value


def checked_payload():
    raw = sys.stdin.buffer.read(16385)
    if len(raw) > 16384:
        err('REQUEST_TOO_LARGE')
    try:
        data = json.loads(raw)
    except (ValueError, UnicodeDecodeError):
        err('INVALID_JSON')
    if not isinstance(data, dict):
        err('INVALID_REQUEST')
    return data


def present(conn, rid):
    row = conn.execute('SELECT id,tuple_json,nonce,created_at,expires_at,decision,consumed_at '
                       'FROM approvals WHERE id=?', (rid,)).fetchone()
    if not row:
        err('UNKNOWN_REQUEST')
    return dict(id=row[0], checkpoint=json.loads(row[1]), nonce=row[2],
                created_at=row[3], expires_at=row[4], decision=row[5],
                consumed=bool(row[6]))


def action(conn, role, req):
    op = req.get('action')
    if role == 'agent':
        if op == 'submit':
            if set(req) != {'action', 'checkpoint'}:
                err('INVALID_REQUEST_FIELDS')
            snapshot, key = clean_tuple(req['checkpoint'])
            now = int(time.time())
            conn.execute('BEGIN IMMEDIATE')
            try:
                row = conn.execute('SELECT id FROM approvals WHERE subject_key=?', (key,)).fetchone()
                if row:
                    rid = row[0]
                else:
                    rid = secrets.token_hex(16)
                    conn.execute('INSERT INTO approvals VALUES (?,?,?,?,?,?,?,?,?)',
                                 (rid, key, snapshot, secrets.token_hex(24), now, now + 3600,
                                  'pending', None, None))
                conn.execute('COMMIT')
            except BaseException:
                conn.execute('ROLLBACK')
                raise
            return present(conn, rid)
        if op in ('status', 'consume'):
            if set(req) != {'action', 'request_id', 'checkpoint'}:
                err('INVALID_REQUEST_FIELDS')
            snapshot, key = clean_tuple(req['checkpoint'])
            rid = checked_id(req['request_id'])
            conn.execute('BEGIN IMMEDIATE')
            try:
                row = conn.execute('SELECT subject_key,decision,expires_at,consumed_at FROM approvals WHERE id=?', (rid,)).fetchone()
                if not row or row[0] != key:
                    err('CHECKPOINT_MISMATCH')
                granted = row[1] == 'approved' and row[2] > int(time.time())
                if op == 'consume' and granted and row[3] is None:
                    conn.execute('UPDATE approvals SET consumed_at=? WHERE id=?', (int(time.time()), rid))
                # Expired approved grants are still valid after first consumption
                # for idempotent local-state recovery of the *same* checkpoint.
                if row[1] == 'approved' and row[3] is not None:
                    granted = True
                conn.execute('COMMIT')
            except BaseException:
                conn.execute('ROLLBACK')
                raise
            return {'authorized': bool(granted), 'request_id': rid, 'status': row[1],
                    'consumed': row[3] is not None or (op == 'consume' and granted)}
        err('AGENT_ACTION_FORBIDDEN')
    if role == 'owner':
        if op == 'list':
            if set(req) != {'action'}:
                err('INVALID_REQUEST_FIELDS')
            now = int(time.time())
            return {'pending': [present(conn, row[0]) for row in conn.execute(
                'SELECT id FROM approvals WHERE decision=? AND expires_at>? ORDER BY created_at DESC LIMIT 50',
                ('pending', now))]}
        if op in ('approve', 'reject'):
            if set(req) != {'action', 'request_id'}:
                err('INVALID_REQUEST_FIELDS')
            rid = checked_id(req['request_id'])
            conn.execute('BEGIN IMMEDIATE')
            try:
                row = conn.execute('SELECT decision,expires_at FROM approvals WHERE id=?', (rid,)).fetchone()
                if not row:
                    err('UNKNOWN_REQUEST')
                if row[0] != 'pending' or row[1] <= int(time.time()):
                    err('REQUEST_NOT_PENDING')
                conn.execute('UPDATE approvals SET decision=?,decided_at=? WHERE id=?',
                             ('approved' if op == 'approve' else 'rejected', int(time.time()), rid))
                conn.execute('COMMIT')
            except BaseException:
                conn.execute('ROLLBACK')
                raise
            return present(conn, rid)
        err('OWNER_ACTION_FORBIDDEN')
    err('INVALID_ROLE')


def main():
    if len(sys.argv) != 2 or sys.argv[1] not in ('agent', 'owner'):
        err('USAGE: opencode-owner-approval agent|owner')
    # The agent endpoint requires root obtained through an exact sudoers rule.
    # A normal user cannot run 'owner', even through a symlink/writable state.
    if os.geteuid() != 0 and not os.getenv('MY_OPENCODE_APPROVAL_TEST_ROOT'):
        err('ROOT_EXECUTION_REQUIRED')
    if sys.argv[1] == 'agent' and os.geteuid() == 0:
        # Allow both trusted helper calls from root installer and agent via sudo.
        # Ownership of caller is established by sudoers, not argv or input JSON.
        pass
    conn = database()
    try:
        result = action(conn, sys.argv[1], checked_payload())
    finally:
        conn.close()
    print(json.dumps(result, separators=(',', ':'), sort_keys=True))


if __name__ == '__main__':
    try:
        main()
    except (ValueError, sqlite3.Error, OSError) as exc:
        print(json.dumps({'error': str(exc)}), file=sys.stderr)
        sys.exit(2)