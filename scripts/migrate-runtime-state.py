#!/usr/bin/env python3
"""Quiescent, backed-up migration of runtime path metadata; history is immutable."""
import argparse
import base64
import json
import os
from pathlib import Path
import shutil
import sqlite3
import tempfile
import time


def quote(name):
    return '"' + name.replace('"', '""') + '"'


class Mapping:
    def __init__(self, old, new, old_projects=None, new_projects=None):
        self.pairs = [(old_projects or old + '/projects', new_projects or new + '/projects'), (old, new)]
        self.missing = set()

    def path(self, value):
        if not isinstance(value, str):
            return value
        relative = not value.startswith('/')
        for before, after in self.pairs:
            prefix = before.lstrip('/') if relative else before
            if value == prefix or value.startswith(prefix + '/'):
                result = after + value[len(prefix):]
                if not Path(result).exists():
                    self.missing.add(value)
                    return value
                return result.lstrip('/') if relative else result
        return value

    def structured(self, value):
        if isinstance(value, str):
            return self.path(value)
        if isinstance(value, list):
            return [self.structured(v) for v in value]
        if isinstance(value, dict):
            result = {}
            for key, val in value.items():
                # Archived namespaces describe historical state, not runtime paths.
                mapped = key if key.startswith('__archived__:') else self.path(key)
                val = val if key in ('content', 'text', 'messages', 'history', 'instruction_blob', 'accessToken', 'refreshToken', 'token') else self.structured(val)
                result[mapped] = merge(result[mapped], val) if mapped in result else val
            return result
        return value


def merge(canonical, old):
    if canonical == old or old in (None, '', [], {}):
        return canonical
    if canonical in (None, '', [], {}):
        return old
    if isinstance(canonical, dict) and isinstance(old, dict):
        result = dict(canonical)
        for key, value in old.items():
            result[key] = merge(result[key], value) if key in result else value
        return result
    if isinstance(canonical, list) and isinstance(old, list):
        return canonical + [v for v in old if v not in canonical]
    raise ValueError('conflicting canonical metadata; manual reconciliation required')


def check(db):
    if db.execute('PRAGMA integrity_check').fetchall() != [('ok',)]:
        raise ValueError('SQLite integrity check failed')
    if db.execute('PRAGMA foreign_key_check').fetchall():
        raise ValueError('SQLite foreign key check failed')


def backup_sqlite(source, target):
    # SQLite API includes committed WAL; never copy a live database file with cp.
    with sqlite3.connect(str(source)) as src, sqlite3.connect(str(target)) as dst:
        src.backup(dst)
        check(dst)


def migrate_db(path, mapping):
    db = sqlite3.connect(str(path))
    db.row_factory = sqlite3.Row
    updated = merged = 0
    try:
        db.execute('PRAGMA foreign_keys=ON')
        # Check before beginning; retain tuple output for the check helper.
        db.row_factory = None
        check(db)
        db.row_factory = sqlite3.Row
        tables = [r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")]
        schema = {t: list(db.execute('PRAGMA table_info(' + quote(t) + ')')) for t in tables}
        incoming = {t: [] for t in tables}
        for child in tables:
            for fk in db.execute('PRAGMA foreign_key_list(' + quote(child) + ')'):
                if fk['table'] in incoming:
                    incoming[fk['table']].append((child, dict(fk)))
        history = {t: db.execute('SELECT count(*) FROM ' + quote(t)).fetchone()[0]
                   for t in tables if t in ('session', 'session_v2', 'message', 'part', 'session_message')}
        db.execute('BEGIN IMMEDIATE')
        for table in tables:
            # Never search-and-replace message bodies/instruction snapshots.
            cols = [r['name'] for r in schema[table]]
            paths = [c for c in cols if c.lower() in ('path', 'directory', 'worktree', 'cwd', 'project_directory', 'worktree_path')
                     or c.lower().endswith(('_directory', '_path'))]
            json_cols = ['sandboxes'] if table == 'project' and 'sandboxes' in cols else []
            if not paths and not json_cols:
                continue
            pk = [r['name'] for r in sorted(schema[table], key=lambda r: r['pk']) if r['pk']]
            if not pk:
                raise ValueError('Path table has no stable primary key: ' + table)
            unique = [pk]
            for idx in db.execute('PRAGMA index_list(' + quote(table) + ')'):
                if idx['unique'] and not idx['partial']:
                    names = [r['name'] for r in db.execute('PRAGMA index_info(' + quote(idx['name']) + ')')]
                    if all(names):
                        unique.append(names)
            def where(keys):
                return ' AND '.join(quote(k) + ' IS ?' for k in keys)
            for row in list(db.execute('SELECT * FROM ' + quote(table))):
                original = dict(row)
                # A prior collision may already have removed this row.
                if not db.execute('SELECT 1 FROM ' + quote(table) + ' WHERE ' + where(pk), [original[k] for k in pk]).fetchone():
                    continue
                candidate = dict(original)
                for col in paths:
                    candidate[col] = mapping.path(candidate[col])
                for col in json_cols:
                    if candidate[col] is not None:
                        candidate[col] = json.dumps(mapping.structured(json.loads(candidate[col])), separators=(',', ':'))
                changes = {k: v for k, v in candidate.items() if v != original[k]}
                if not changes:
                    continue
                collisions = []
                for keys in unique:
                    if any(candidate[k] is None for k in keys):
                        continue
                    for other in db.execute('SELECT * FROM ' + quote(table) + ' WHERE ' + where(keys), [candidate[k] for k in keys]):
                        if any(other[k] != original[k] for k in pk):
                            collisions.append(dict(other))
                if collisions:
                    canonical = collisions[0]
                    if any(any(r[k] != canonical[k] for k in pk) for r in collisions):
                        raise ValueError('multiple unique-key collision targets: ' + table)
                    # Refuse to delete referenced identities. No disabling UNIQUE/FK.
                    for child, fk in incoming[table]:
                        parent_col = fk['to'] or (pk[0] if len(pk) == 1 else None)
                        if parent_col is None or db.execute('SELECT 1 FROM ' + quote(child) + ' WHERE ' + quote(fk['from']) + ' IS ? LIMIT 1', [original[parent_col]]).fetchone():
                            raise ValueError('referenced duplicate requires explicit FK transfer: ' + table)
                    result = dict(canonical)
                    for col in cols:
                        if col in pk:
                            if canonical[col] != candidate[col]:
                                raise ValueError('collision has a different identity: ' + table)
                        elif col in ('time_created', 'created_at') and canonical[col] is not None and candidate[col] is not None:
                            result[col] = min(canonical[col], candidate[col])
                        elif col in ('time_updated', 'updated_at') and canonical[col] is not None and candidate[col] is not None:
                            result[col] = max(canonical[col], candidate[col])
                        else:
                            result[col] = merge(canonical[col], candidate[col])
                    db.execute('UPDATE ' + quote(table) + ' SET ' + ','.join(quote(k) + '=?' for k in cols if k not in pk) + ' WHERE ' + where(pk),
                               [result[k] for k in cols if k not in pk] + [canonical[k] for k in pk])
                    db.execute('DELETE FROM ' + quote(table) + ' WHERE ' + where(pk), [original[k] for k in pk])
                    merged += 1
                else:
                    db.execute('UPDATE ' + quote(table) + ' SET ' + ','.join(quote(k) + '=?' for k in changes) + ' WHERE ' + where(pk), list(changes.values()) + [original[k] for k in pk])
                    updated += len(changes)
        for table, count in history.items():
            if db.execute('SELECT count(*) FROM ' + quote(table)).fetchone()[0] != count:
                raise ValueError('history count changed: ' + table)
        db.row_factory = None
        check(db)
        db.commit()
        return dict(updated=updated, merged=merged, history_counts=history)
    except BaseException:
        db.rollback()
        raise
    finally:
        db.close()


def migrate(home, mapping, backup):
    backup.mkdir(parents=True, exist_ok=False)
    databases = [home / '.local/share/opencode/opencode.db', home / '.config/openchamber/message-search.sqlite']
    restores = []
    def remember(kind, path, saved):
        restores.append((kind, path, saved))
        (backup / 'rollback-index.json').write_text(json.dumps([
            dict(kind=k, path=str(p), backup=str(b) if b else None) for k, p, b in restores
        ], indent=2) + '\n')
    reports = {}
    try:
        for db in databases:
            if not db.exists():
                continue
            if db.is_symlink():
                raise ValueError('database symlink refused')
            saved = backup / str(len(restores))
            backup_sqlite(db, saved)
            remember('db', db, saved)
            # Exercise exactly the same algorithm on a copy and require idempotence.
            with tempfile.TemporaryDirectory() as tmp:
                trial = Path(tmp) / 'trial.db'
                backup_sqlite(saved, trial)
                migrate_db(trial, mapping)
                again = migrate_db(trial, mapping)
                if again['updated'] or again['merged']:
                    raise ValueError('migration is not idempotent')
            reports[str(db)] = migrate_db(db, mapping)
        roots = [home / '.config/openchamber', home / '.local/share/openchamber', home / '.local/share/opencode-claude']
        for root in roots:
            if not root.exists():
                continue
            if root.is_symlink():
                raise ValueError('state root symlink refused: ' + str(root))
            for file in list(root.rglob('*')):
                if file.is_symlink():
                    raise ValueError('state symlink refused: ' + str(file))
                if not file.is_file() or not (file.suffix == '.json' or file.name.startswith('path_')):
                    continue
                # Installed code/package metadata is not user state.
                if any(p in ('node_modules', 'releases', 'cache') for p in file.relative_to(root).parts):
                    continue
                data = json.loads(file.read_text())
                mapped = mapping.structured(data)
                target = file
                if file.name.startswith('path_'):
                    stem = file.name[5:].removesuffix('.json')
                    decoded = base64.urlsafe_b64decode(stem + '=' * (-len(stem) % 4)).decode()
                    relocated = mapping.path(decoded)
                    if relocated != decoded:
                        target = file.with_name('path_' + base64.urlsafe_b64encode(relocated.encode()).decode().rstrip('=') + ('.json' if file.suffix == '.json' else ''))
                if target == file and mapped == data:
                    continue
                saved = backup / str(len(restores))
                shutil.copy2(file, saved)
                remember('file', file, saved)
                if target != file:
                    if target.exists():
                        saved_target = backup / str(len(restores))
                        shutil.copy2(target, saved_target)
                        remember('file', target, saved_target)
                        mapped = merge(json.loads(target.read_text()), mapped)
                    else:
                        remember('new', target, None)
                temp = target.with_name(target.name + '.migration-tmp')
                temp.write_text(json.dumps(mapped, ensure_ascii=False, indent=2) + '\n')
                os.chmod(temp, file.stat().st_mode & 0o777)
                os.replace(temp, target)
                if target != file:
                    file.unlink()
        reports['missing_targets'] = sorted(mapping.missing)
        (backup / 'report.json').write_text(json.dumps(reports, indent=2) + '\n')
        return reports
    except BaseException:
        for kind, path, saved in reversed(restores):
            if kind == 'db':
                backup_sqlite(saved, path)
            elif kind == 'new':
                path.unlink(missing_ok=True)
            else:
                shutil.copy2(saved, path)
        raise


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--source-home', required=True)
    parser.add_argument('--home', required=True)
    parser.add_argument('--source-projects')
    parser.add_argument('--target-projects')
    opts = parser.parse_args()
    home = Path(opts.home)
    from importlib.machinery import SourceFileLoader
    detector = SourceFileLoader('runtime_processes', str(Path(__file__).with_name('runtime-processes.py'))).load_module()
    def stopped():
        if any(r['runtime'] and r['uid'] == home.stat().st_uid for r in detector.collect()):
            raise ValueError('target runtime is active; state migration refused')
    stopped()
    backup = home / '.local/state/my-opencode' / ('state-migration-' + str(time.time_ns()))
    # Recheck just before opening write transactions.
    stopped()
    print(json.dumps(migrate(home, Mapping(opts.source_home, str(home), opts.source_projects, opts.target_projects), backup)))


if __name__ == '__main__':
    main()
