#!/usr/bin/env python3
"""Root-owned owner approval broker with separate Unix peers for each role."""
import importlib.util
from contextlib import closing
import json
import os
import pwd
import signal
import socket
import socketserver
import sqlite3
import stat
import struct
import sys
import threading
from pathlib import Path

BASE = Path('/run/my-opencode-approval')

def load_module(filename):
    path = Path(__file__).with_name(filename)
    spec = importlib.util.spec_from_file_location(path.stem, path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod

class Handler(socketserver.StreamRequestHandler):
    def handle(self):
        server = self.server
        self.request.settimeout(5)
        try:
            raw = self.request.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, struct.calcsize('3i'))
            pid, uid, gid = struct.unpack('3i', raw)
            if uid not in server.allowed_uids:
                self.wfile.write(b'{"error":"PEER_UID_FORBIDDEN"}\n')
                return
            limit = 1024 * 1024 if server.state else 16385
            message = self.rfile.readline(limit + 1)
            if not message.endswith(b'\n') or len(message) > limit:
                raise ValueError('REQUEST_TOO_LARGE')
            request = json.loads(message)
            if not isinstance(request, dict):
                raise ValueError('INVALID_REQUEST')
            conn = server.ledger.database()
            try:
                if server.state:
                    result = server.state.act(conn, server.role, request)
                else:
                    result = server.ledger.action(conn, server.role, request)
            finally:
                conn.close()
            response = {'ok': result}
        except (ValueError, OSError, TypeError) as exc:
            response = {'error': str(exc)}
        except sqlite3.Error:
            response = {'error': 'BROKER_DATABASE_UNAVAILABLE'}
        self.wfile.write((json.dumps(response, sort_keys=True, separators=(',', ':')) + '\n').encode())

class Server(socketserver.ThreadingMixIn, socketserver.UnixStreamServer):
    daemon_threads = True
    allow_reuse_address = False

    def __init__(self, *args):
        self.slots = threading.BoundedSemaphore(16)
        super().__init__(*args)

    def process_request(self, request, address):
        if not self.slots.acquire(blocking=False):
            self.shutdown_request(request)
            return
        try:
            super().process_request(request, address)
        except BaseException:
            self.slots.release()
            raise

    def process_request_thread(self, request, address):
        try:
            super().process_request_thread(request, address)
        finally:
            self.slots.release()


def serve(passkey=False):
    if os.geteuid() != 0:
        raise RuntimeError('ROOT_REQUIRED')
    principal = pwd.getpwnam('opencode')
    # Root-owned directory is traversable, but agent cannot read owner.sock.
    if BASE.is_symlink() or (BASE.exists() and (not BASE.is_dir() or BASE.stat().st_uid != 0 or BASE.stat().st_mode & 0o022)):
        raise RuntimeError('UNSAFE_SOCKET_DIRECTORY')
    BASE.mkdir(mode=0o755, parents=True, exist_ok=True)
    os.chown(BASE, 0, 0)
    os.chmod(BASE, 0o755)
    ledger = load_module('opencode-owner-approval.py')
    state = None
    endpoints = [
        ('agent', 'agent.sock', 0o660, principal.pw_gid, {principal.pw_uid}),
        ('owner', 'owner.sock', 0o600, 0, {0}),
    ]
    if passkey:
        verifier = pwd.getpwnam('opencode-approval')
        if verifier.pw_uid in (0, principal.pw_uid) or verifier.pw_gid in (0, principal.pw_gid):
            raise RuntimeError('UNSAFE_VERIFIER_IDENTITY')
        state = load_module('opencode-owner-approval-state.py')
        with closing(ledger.database()) as conn:
            state.initialize(conn)
        endpoints = [
            ('runtime', 'agent.sock', 0o660, principal.pw_gid, {principal.pw_uid}),
            ('verifier', 'verify.sock', 0o660, verifier.pw_gid, {verifier.pw_uid}),
            ('admin', 'admin.sock', 0o600, 0, {0}),
        ]
    servers = []
    for role, name, mode, group, uids in endpoints:
        path = BASE / name
        if path.is_symlink():
            raise RuntimeError('UNSAFE_SOCKET_PATH')
        if path.exists() and not stat.S_ISSOCK(path.stat().st_mode):
            raise RuntimeError('UNSAFE_SOCKET_PATH')
        if path.exists():
            path.unlink()
        srv = Server(str(path), Handler)
        os.chown(path, 0, group)
        os.chmod(path, mode)
        srv.role = role
        srv.allowed_uids = uids
        srv.ledger = ledger
        srv.state = state
        servers.append(srv)
    def stop(signum, frame):
        for s in servers:
            threading.Thread(target=s.shutdown, daemon=True).start()
    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    for server in servers[:-1]:
        threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        servers[-1].serve_forever()
    finally:
        for s in servers:
            s.server_close()

if __name__ == '__main__':
    try:
        if sys.argv[1:] not in ([], ['--passkey']):
            raise RuntimeError('INVALID_BROKER_MODE')
        serve(passkey=sys.argv[1:] == ['--passkey'])
    except (RuntimeError, OSError, KeyError, sqlite3.Error) as e:
        print(f'OWNER_APPROVAL_BROKER_FAILED: {e}', file=sys.stderr)
        sys.exit(2)
