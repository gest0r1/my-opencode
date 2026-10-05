#!/usr/bin/env python3
"""Read-only acceptance under runtime UID; passwords never enter argv/logs."""
import http.cookiejar
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import urllib.request
import urllib.parse


def request(opener, url, payload=None):
    data = None if payload is None else json.dumps(payload).encode()
    req = urllib.request.Request(url, data=data, headers={'Content-Type': 'application/json'})
    with opener.open(req, timeout=5) as response:
        return json.load(response)


def main():
    home = Path(os.environ['HOME'])
    uid = os.getuid()
    if uid == 0:
        raise ValueError('Acceptance must run as opencode')
    for unit in ('opencode-web.service', 'openchamber.service'):
        subprocess.run(['systemctl', '--user', 'is-enabled', '--quiet', unit], check=True)
        pid = int(subprocess.check_output(['systemctl', '--user', 'show', unit, '--property=MainPID', '--value'], text=True).strip())
        if pid <= 0:
            raise ValueError('Service has no running MainPID: ' + unit)
        status = (Path('/proc') / str(pid) / 'status').read_text()
        line = next(line for line in status.splitlines() if line.startswith('Uid:'))
        if any(int(value) != uid for value in line.split()[1:]):
            raise ValueError('Service UID mismatch: ' + unit)
        raw = (Path('/proc') / str(pid) / 'environ').read_bytes()
        env = dict(item.split(b'=', 1) for item in raw.split(b'\0') if b'=' in item)
        if env.get(b'HOME') != str(home).encode():
            raise ValueError('Service HOME mismatch: ' + unit)
        if str(home / '.local/bin').encode() not in env.get(b'PATH', b'').split(b':'):
            raise ValueError('Service PATH missing user tools: ' + unit)
        if (Path('/proc') / str(pid) / 'cwd').resolve() != home.resolve():
            raise ValueError('Service cwd mismatch: ' + unit)
    if subprocess.check_output(['loginctl', 'show-user', str(uid), '--property=Linger', '--value'], text=True).strip() != 'yes':
        raise ValueError('User linger is not enabled')
    host = os.environ.get('OPENCHAMBER_BIND_HOST', '0.0.0.0')
    if host in ('0.0.0.0', '::'):
        host = '127.0.0.1'
    if ':' in host:
        host = '[' + host + ']'
    base = 'http://' + host + ':' + os.environ.get('OPENCHAMBER_BIND_PORT', '3000')
    # No inherited proxy can redirect loopback requests or their cookies/password.
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}),
                                        urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
    password = os.environ.get('OPENCHAMBER_UI_PASSWORD')
    if password:
        if request(opener, base + '/auth/session', {'password': password, 'trustDevice': False}).get('authenticated') is not True:
            raise ValueError('UI password authentication failed')
    if request(opener, base + '/auth/session').get('authenticated') is not True:
        raise ValueError('UI authentication status is not authenticated')
    # UI-authenticated API read, not a successful unauthenticated 401 probe.
    request(opener, base + '/api/config')
    code_host = os.environ.get('OPENCODE_WEB_HOST', '127.0.0.1')
    if code_host in ('0.0.0.0', '::'):
        code_host = '127.0.0.1'
    if ':' in code_host:
        code_host = '[' + code_host + ']'
    code = 'http://' + code_host + ':' + os.environ.get('OPENCODE_WEB_PORT', '4096')
    info = request(opener, code + '/api/info')
    if not isinstance(info.get('pid'), int) or not isinstance(info.get('version'), str):
        raise ValueError('Invalid OpenCode server.info response')
    ids = []
    database = home / '.local/share/opencode/opencode.db'
    if database.exists():
        with sqlite3.connect(database.as_uri() + '?mode=ro', uri=True) as db:
            exists = db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='session_v2'").fetchone()
            if exists and any(row[1] == 'id' for row in db.execute('PRAGMA table_info(session_v2)')):
                ids = [row[0] for row in db.execute('SELECT id FROM session_v2 LIMIT 3')]
        for session in ids:
            result = request(opener, code + '/api/session/' + urllib.parse.quote(session, safe=''))
            record = result.get('data', result)
            if record.get('id') != session:
                raise ValueError('Session ID unavailable after migration')
    print(json.dumps({'status': 'PASS', 'service_uid_home_path': 'PASS', 'linger': 'PASS',
                      'authenticated_ui_api': 'PASS', 'session_ids_checked': len(ids), 'reboot_checked': False}))


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        # HTTP failures reveal status only, not request headers or password bodies.
        raise SystemExit('Runtime acceptance failed: ' + str(error))
