#!/usr/bin/env python3
"""Root-owned owner approval broker. Unix peer UID is the trust boundary.

The agent socket (opencode UID) may only request/read/consume. The owner socket
(root UID) may only list or decide. No HTTP port and no bearer grant.
"""
import importlib.util
import json
import os
import pwd
import signal
import socket
import socketserver
import stat
import struct
import sys
import threading
from pathlib import Path

BASE = Path('/run/my-opencode-approval')

def load_ledger():
    path = Path(__file__).with_name('opencode-owner-approval.py')
    spec = importlib.util.spec_from_file_location('opencode_approval_ledger', path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod

class Handler(socketserver.StreamRequestHandler):
    def handle(self):
        server = self.server
        try:
            raw = self.request.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, struct.calcsize('3i'))
            pid, uid, gid = struct.unpack('3i', raw)
            if uid not in server.allowed_uids:
                self.wfile.write(b'{"error":"PEER_UID_FORBIDDEN"}\n')
                return
            message = self.rfile.readline(16386)
            if not message.endswith(b'\n') or len(message) > 16385:
                raise ValueError('REQUEST_TOO_LARGE')
            request = json.loads(message)
            if not isinstance(request, dict):
                raise ValueError('INVALID_REQUEST')
            conn = server.ledger.database()
            try:
                result = server.ledger.action(conn, server.role, request)
            finally:
                conn.close()
            response = {'ok': result}
        except (ValueError, OSError, TypeError) as exc:
            response = {'error': str(exc)}
        self.wfile.write((json.dumps(response, sort_keys=True, separators=(',', ':')) + '\n').encode())

class Server(socketserver.ThreadingMixIn, socketserver.UnixStreamServer):
    daemon_threads = True
    allow_reuse_address = False


def serve():
    if os.geteuid() != 0:
        raise RuntimeError('ROOT_REQUIRED')
    principal = pwd.getpwnam('opencode')
    # Root-owned directory is traversable, but agent cannot read owner.sock.
    if BASE.is_symlink() or (BASE.exists() and (not BASE.is_dir() or BASE.stat().st_uid != 0)):
        raise RuntimeError('UNSAFE_SOCKET_DIRECTORY')
    BASE.mkdir(mode=0o755, parents=True, exist_ok=True)
    os.chown(BASE, 0, 0)
    os.chmod(BASE, 0o755)
    ledger = load_ledger()
    servers = []
    for role, name, mode, group, uids in (
        ('agent', 'agent.sock', 0o660, principal.pw_gid, {principal.pw_uid}),
        ('owner', 'owner.sock', 0o600, 0, {0}),
    ):
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
        servers.append(srv)
    def stop(signum, frame):
        for s in servers:
            threading.Thread(target=s.shutdown, daemon=True).start()
    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    thread = threading.Thread(target=servers[0].serve_forever, daemon=True)
    thread.start()
    try:
        servers[1].serve_forever()
    finally:
        for s in servers:
            s.server_close()

if __name__ == '__main__':
    try:
        serve()
    except (RuntimeError, OSError, KeyError) as e:
        print(f'OWNER_APPROVAL_BROKER_FAILED: {e}', file=sys.stderr)
        sys.exit(2)