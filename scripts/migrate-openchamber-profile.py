#!/usr/bin/env python3
"""Import the old OpenChamber profile without running filesystem writes as root."""
import argparse
import ctypes
import importlib.util
import json
import os
from pathlib import Path
import pwd
import re
import shutil
import stat
import sys
import tarfile

LEGACY = Path('/root/.config/openchamber')
SPEC = importlib.util.spec_from_file_location('migration_files', Path(__file__).with_name('migrate-openchamber-to-root.py'))
FILES = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(FILES)
SPLIT_KEYS = {'OPENCHAMBER_DATA_DIR', 'OPENCHAMBER_CHATS_DIR', 'OPENCHAMBER_ROOT_MODE', 'OPENCHAMBER_EXECUTION_USER',
              'OPENCHAMBER_EXECUTION_UID', 'OPENCHAMBER_EXECUTION_GID', 'OPENCODE_HOST', 'OPENCODE_SKIP_START',
              'OPENCODE_BINARY', 'OPENCODE_SERVER_PASSWORD', 'OPENCODE_PASSWORD', 'NODE_OPTIONS'}


def exchange(left, right):
    renameat2 = ctypes.CDLL(None, use_errno=True).renameat2
    renameat2.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
    if renameat2(-100, os.fsencode(left), -100, os.fsencode(right), 2) != 0:
        error = ctypes.get_errno()
        raise OSError(error, os.strerror(error))


def rebase(value, old, new):
    if isinstance(value, str):
        return new + value[len(old):] if value == old or value.startswith(old + '/') else value
    if isinstance(value, dict):
        result = {}
        for key, item in value.items():
            mapped = rebase(key, old, new)
            if mapped in result:
                raise RuntimeError('MIGRATION_JSON_PATH_COLLISION')
            result[mapped] = rebase(item, old, new)
        return result
    if isinstance(value, list):
        return [rebase(item, old, new) for item in value]
    return value


def rebase_profile(stage, active):
    env = stage / 'startup.env'
    if env.is_file():
        lines = env.read_text(encoding='utf-8').splitlines()
        keep = [line for line in lines if (match := re.fullmatch(r'([A-Za-z_][A-Za-z0-9_]*)\s*=.*', line.strip()))
                and match[1] not in SPLIT_KEYS]
        env.write_text('\n'.join(keep) + '\n', encoding='utf-8')
    for name in ('settings.json', 'extensions.json', 'trusted-workspaces.json'):
        file = stage / name
        if file.is_file():
            value = json.loads(file.read_text(encoding='utf-8'))
            updated = rebase(value, str(LEGACY), str(active))
            if updated != value:
                FILES.atomic_json(file, updated)


def import_archive(stream, target):
    target.mkdir(mode=0o700)
    with tarfile.open(fileobj=stream, mode='r|*') as archive:
        for member in archive:
            name = Path(member.name)
            if name.is_absolute() or '..' in name.parts or not (member.isdir() or member.isfile()):
                raise RuntimeError('MIGRATION_ARCHIVE_ENTRY_REFUSED')
            dest = target / name
            if member.isdir():
                dest.mkdir(mode=0o700, parents=True, exist_ok=True)
                continue
            dest.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
            with archive.extractfile(member) as reader, dest.open('xb') as writer:
                while block := reader.read(1024 * 1024):
                    writer.write(block)
                writer.flush()
                os.fsync(writer.fileno())
            dest.chmod(0o700 if member.mode & stat.S_IXUSR else 0o600)


def sync_dir(path):
    directory = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.fsync(directory)
    finally:
        os.close(directory)


def active_profile(parent, token):
    if parent.is_symlink() or not parent.is_dir() or parent.stat().st_uid != os.geteuid():
        raise RuntimeError('MIGRATION_PROFILE_PARENT_UNSAFE')
    return parent / 'openchamber', parent / ('.openchamber-unified-stage-' + token)


def stage_profile(parent, token, stream):
    active, stage = active_profile(parent, token)
    if active.is_symlink() or (active.exists() and not active.is_dir()):
        raise RuntimeError('MIGRATION_PROFILE_PATH_UNSAFE')
    import_archive(stream, stage)
    collisions = []
    if active.is_dir():
        historical = parent / ('.openchamber-unified-source-' + token)
        FILES.secure_copy(active, historical)
        try:
            FILES.merge_historical_files(stage, historical, collisions)
        finally:
            shutil.rmtree(historical)
    rebase_profile(stage, active)
    (stage / '.unified-profile-id').write_text(token + '\n', encoding='utf-8')
    sync_dir(stage)
    return {'status': 'prepared', 'conflicts': collisions}


def switch_profile(parent, token, *, rollback=False):
    active, stage = active_profile(parent, token)

    def prepared(path):
        marker = path / '.unified-profile-id'
        return path.is_dir() and not path.is_symlink() and not marker.is_symlink() and marker.is_file() and marker.read_text().strip() == token

    if rollback and prepared(active):
        if stage.exists():
            exchange(active, stage)
        else:
            active.rename(stage)
        sync_dir(parent)
    elif not rollback and not prepared(active):
        if not prepared(stage):
            raise RuntimeError('MIGRATION_PROFILE_STAGE_MISSING')
        if active.exists():
            exchange(active, stage)
        else:
            stage.rename(active)
        sync_dir(parent)
    return {'status': 'rolled_back' if rollback else 'active'}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=('prepare', 'activate', 'rollback'))
    parser.add_argument('transaction')
    args = parser.parse_args()
    if os.geteuid() <= 0 or pwd.getpwuid(os.geteuid()).pw_name != 'opencode':
        raise RuntimeError('MIGRATION_PROFILE_REQUIRES_OPENCODE_UID')
    if not re.fullmatch(r'[a-f0-9]{32}', args.transaction):
        raise RuntimeError('MIGRATION_PROFILE_TRANSACTION_INVALID')
    parent = Path(pwd.getpwuid(os.geteuid()).pw_dir) / '.config'
    if args.action == 'prepare':
        report = stage_profile(parent, args.transaction, sys.stdin.buffer)
    else:
        report = switch_profile(parent, args.transaction, rollback=args.action == 'rollback')
    print(json.dumps(report))


if __name__ == '__main__':
    try:
        main()
    except (OSError, RuntimeError, ValueError, tarfile.TarError) as error:
        print(f'OPENCHAMBER_PROFILE_MIGRATION_FAILED: {error}', file=sys.stderr)
        sys.exit(1)
