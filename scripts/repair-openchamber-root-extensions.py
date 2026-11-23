#!/usr/bin/env python3
"""Rebase copied OpenChamber extension paths after the opencode -> root cutover.

The legacy extensions.json stores *absolute* checkout paths. Copying the tree
does not rewrite those keys, so root's protected guest runner refuses the old
opencode-owned source. Rebase only paths inside the copied extension directory;
preserve extension IDs, grants, refs, profiles and other settings untouched.
"""
import argparse
import json
import os
from pathlib import Path
import secrets
import stat
import sys

OLD = Path('/home/opencode/.config/openchamber/extensions')
NEW = Path('/root/.config/openchamber/extensions')
ROOT_DATA = Path('/root/.config/openchamber')


class Refused(Exception):
    pass


def absolute_child(raw, base):
    if not isinstance(raw, str) or not raw.startswith(str(base) + '/'):
        return None
    path = Path(raw)
    if not path.is_absolute() or '..' in path.parts or '.' in path.parts:
        raise Refused('EXTENSION_PATH_UNSAFE')
    relative = path.relative_to(base)
    if not relative.parts or any(part in ('', '.', '..') for part in relative.parts):
        raise Refused('EXTENSION_PATH_UNSAFE')
    return relative


def verify_tree(path, test_mode=False):
    if path.is_symlink() or not path.is_dir():
        raise Refused('EXTENSION_COPY_MISSING_OR_SYMLINK')
    if not test_mode:
        current = path
        while True:
            info = os.lstat(current)
            if not stat.S_ISDIR(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022:
                raise Refused('EXTENSION_COPY_UNTRUSTED_OWNER')
            if current == Path('/'):
                break
            current = current.parent


def secure_write(path, data):
    if path.is_symlink():
        raise Refused('EXTENSION_STORE_SYMLINK')
    temp = path.with_name('.' + path.name + '.rebase-' + secrets.token_hex(8))
    fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        with os.fdopen(fd, 'w', encoding='utf-8') as stream:
            json.dump(data, stream, indent=2, ensure_ascii=False)
            stream.write('\n')
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temp, path)
    finally:
        if temp.exists():
            temp.unlink()


def repair(data_dir=ROOT_DATA, test_mode=False, old_dir=OLD):
    if not test_mode and os.geteuid() != 0:
        raise Refused('ROOT_REQUIRED')
    data_dir = Path(data_dir)
    if not test_mode and data_dir.resolve() != ROOT_DATA:
        raise Refused('ROOT_DATA_PATH_INVALID')
    verify_tree(data_dir, test_mode)
    store = data_dir / 'extensions.json'
    if not store.exists():
        return {'status': 'not_required', 'updated': 0}
    if store.is_symlink() or not store.is_file():
        raise Refused('EXTENSION_STORE_UNTRUSTED')
    parsed = json.loads(store.read_text(encoding='utf-8'))
    if not isinstance(parsed, dict) or not isinstance(parsed.get('paths'), list):
        raise Refused('EXTENSION_STORE_INVALID')
    new_dir = data_dir / 'extensions'
    updated = 0

    def convert(value):
        nonlocal updated
        relative = absolute_child(value, old_dir)
        if relative is None:
            return value
        candidate = new_dir / relative
        verify_tree(candidate, test_mode)
        updated += 1
        return str(candidate)

    paths = []
    for entry in parsed['paths']:
        if not isinstance(entry, str):
            raise Refused('EXTENSION_STORE_INVALID')
        paths.append(convert(entry))
    if len(set(paths)) != len(paths):
        raise Refused('EXTENSION_STORE_PATH_COLLISION')
    new_store = dict(parsed)
    new_store['paths'] = paths
    for name in ('sources', 'gitOrigins'):
        old_mapping = parsed.get(name, {})
        if not isinstance(old_mapping, dict):
            raise Refused('EXTENSION_STORE_INVALID')
        converted = {}
        for key, value in old_mapping.items():
            if not isinstance(key, str):
                raise Refused('EXTENSION_STORE_INVALID')
            new_key = convert(key)
            if new_key in converted and converted[new_key] != value:
                raise Refused('EXTENSION_STORE_KEY_COLLISION')
            converted[new_key] = value
        if name in parsed:
            new_store[name] = converted
    if new_store == parsed:
        return {'status': 'already_valid', 'updated': 0}
    # One durable copy for incident recovery, never rewrite historical bytes.
    backup = data_dir / 'extensions.json.pre-root-path-rebase'
    if backup.is_symlink():
        raise Refused('EXTENSION_STORE_BACKUP_SYMLINK')
    if not backup.exists():
        fd = os.open(backup, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd, 'wb') as stream:
            stream.write(store.read_bytes())
            stream.flush()
            os.fsync(stream.fileno())
    secure_write(store, new_store)
    return {'status': 'repaired', 'updated': updated, 'paths': len(paths)}


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--data-dir', default=str(ROOT_DATA))
    parser.add_argument('--old-dir', default=str(OLD))
    args = parser.parse_args()
    try:
        print(json.dumps(repair(Path(args.data_dir),
                                test_mode=os.environ.get('OPENCHAMBER_EXTENSION_REPAIR_TEST') == '1',
                                old_dir=Path(args.old_dir)), sort_keys=True))
    except (Refused, OSError, ValueError, json.JSONDecodeError) as error:
        print(json.dumps({'error': str(error)}, sort_keys=True), file=sys.stderr)
        sys.exit(2)
