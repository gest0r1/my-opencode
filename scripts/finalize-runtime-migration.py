#!/usr/bin/env python3
"""Root snapshots its source; all destination writes run as opencode."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import pwd
import shutil
import subprocess
import sys
import time


def module(name):
    spec = importlib.util.spec_from_file_location(name.replace('-', '_'), Path(__file__).with_name(name + '.py'))
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result


def digest(path):
    result = hashlib.sha256()
    with path.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            result.update(chunk)
    return result.hexdigest()


def sqlite_file(path):
    with path.open('rb') as stream:
        return stream.read(16) == b'SQLite format 3\x00'


def apply(snapshot, data):
    if os.geteuid() == 0:
        raise ValueError('Destination migration must run as opencode')
    home = Path(data['home'])
    state = module('migrate-runtime-state')
    detector = module('runtime-processes')
    def stopped():
        if any(r['runtime'] and r['uid'] == os.geteuid() for r in detector.collect()):
            raise ValueError('Target runtime active; final migration refused')
    stopped()
    copied = data['copied_files']
    for relative, expected in copied.items():
        if Path(relative).is_absolute() or '..' in Path(relative).parts:
            raise ValueError('Invalid relative migration path')
        target = home / relative
        if not target.is_file() or target.is_symlink() or digest(target) != expected:
            raise ValueError('Prepared target changed; refusing overwrite: ' + relative)
        if not (snapshot / relative).is_file():
            raise ValueError('Source disappeared after prepare: ' + relative)
    backup = home / '.local/state/my-opencode' / ('final-sync-backup-' + str(time.time_ns()))
    backup.mkdir(parents=True)
    refreshed = []
    try:
        # Include state created after preparation; existing canonical files win.
        for src in snapshot.rglob('*'):
            if not src.is_file():
                continue
            relative = str(src.relative_to(snapshot))
            target = home / relative
            if relative in copied:
                saved = backup / relative
                saved.parent.mkdir(parents=True, exist_ok=True)
                if sqlite_file(target):
                    state.backup_sqlite(target, saved)
                    refreshed.append(('db', target, saved))
                    state.backup_sqlite(src, target)
                else:
                    shutil.copy2(target, saved)
                    refreshed.append(('file', target, saved))
                    shutil.copy2(src, target)
            elif not target.exists():
                target.parent.mkdir(parents=True, exist_ok=True)
                if sqlite_file(src):
                    state.backup_sqlite(src, target)
                    target.chmod(0o600)
                else:
                    shutil.copy2(src, target)
                refreshed.append(('new', target, None))
        stopped()
        report = state.migrate(home, state.Mapping(data['source_home'], str(home), data['source_projects'], data['target_projects']),
                               home / '.local/state/my-opencode' / ('state-migration-final-' + str(time.time_ns())))
        (home / '.local/state/my-opencode/root-state-sync.pending').unlink(missing_ok=True)
        print(json.dumps(report))
    except BaseException:
        for kind, target, saved in reversed(refreshed):
            if kind == 'db':
                state.backup_sqlite(saved, target)
            elif kind == 'new':
                target.unlink(missing_ok=True)
            else:
                shutil.copy2(saved, target)
        raise


def main():
    if len(sys.argv) == 3 and sys.argv[1] == '--apply':
        apply(Path(sys.argv[2]), json.load(sys.stdin))
        return
    if len(sys.argv) != 1 or os.geteuid() != 0:
        raise SystemExit('Final migration requires root and no arguments')
    plan = Path('/var/lib/my-opencode/root-migration.json')
    if not plan.exists():
        return
    if plan.is_symlink() or plan.stat().st_uid != 0 or plan.stat().st_mode & 0o022:
        raise ValueError('Unsafe migration plan')
    data = json.loads(plan.read_text())
    user = pwd.getpwnam('opencode')
    if data['home'] != user.pw_dir:
        raise ValueError('Migration home mismatch')
    detector = module('runtime-processes')
    if any(r['runtime'] and r['uid'] in (0, user.pw_uid) for r in detector.collect()):
        raise ValueError('Root/target runtime still active; final migration refused')
    source = Path(data['source_home'])
    parent = Path('/var/lib/my-opencode-snapshots')
    parent.mkdir(mode=0o711, exist_ok=True)
    if parent.is_symlink() or parent.stat().st_uid != 0 or parent.stat().st_mode & 0o022:
        raise ValueError('Unsafe snapshot parent')
    snapshot = parent / str(time.time_ns())
    snapshot.mkdir(mode=0o700)
    state = module('migrate-runtime-state')
    roots = ('.config/openchamber', '.local/share/openchamber', '.local/share/opencode-claude')
    files = [source / relative for relative in data['copied_files']]
    files += [p for relative in roots for p in (source / relative).rglob('*') if p.is_file()]
    files += [source / '.local/share/opencode/opencode.db']
    for src in set(files):
        if not src.exists():
            continue
        relative = src.relative_to(source)
        if any(part in ('node_modules', 'releases', 'cache') for part in relative.parts) or src.name.endswith(('-wal', '-shm')):
            continue
        if src.is_symlink():
            raise ValueError('Source state symlink refused: ' + str(relative))
        dst = snapshot / relative
        dst.parent.mkdir(parents=True, exist_ok=True)
        if sqlite_file(src):
            state.backup_sqlite(src, dst)
        else:
            shutil.copy2(src, dst)
        dst.chmod(0o600)
    # Keep the top snapshot inaccessible until root has finished every write.
    for path in sorted(snapshot.rglob('*'), key=lambda p: len(p.parts), reverse=True):
        os.chown(path, user.pw_uid, user.pw_gid, follow_symlinks=False)
    os.chown(snapshot, user.pw_uid, user.pw_gid)
    home = user.pw_dir
    env = ['env', '-i', 'HOME=' + home, 'USER=opencode', 'LOGNAME=opencode',
           'PATH=' + home + '/.local/bin:/usr/local/bin:/usr/bin:/bin']
    subprocess.run(['runuser', '-u', 'opencode', '--', *env, 'bash', '-c',
                    'cd "$HOME"; exec python3 "$@"', 'bash', str(Path(__file__).resolve()), '--apply', str(snapshot)],
                   input=json.dumps(data), text=True, check=True)
    plan.rename(plan.with_suffix('.completed.json'))


if __name__ == '__main__':
    main()
