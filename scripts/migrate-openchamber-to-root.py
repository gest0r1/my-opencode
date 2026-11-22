#!/usr/bin/env python3
"""One-shot OpenChamber *data-only* opencode -> root cutover transaction.

Never touches OpenCode's database, credentials, sessions or runtime user.
Called only after old OpenChamber instance is quiescent. Old source retained.
"""
import argparse
import json
import os
from pathlib import Path
import secrets
import shutil
import stat
import sys
import time

STATE_DIR = Path('/var/lib/my-opencode/openchamber-root-migration')
DEFAULT_SRC = Path('/home/opencode/.config/openchamber')
DEFAULT_DST = Path('/root/.config/openchamber')

class Refused(RuntimeError): pass

def check_paths(src, dst):
    if os.geteuid() != 0 and not os.getenv('OPENCHAMBER_MIGRATION_TEST'):
        raise Refused('ROOT_REQUIRED')
    for x in (src, dst):
        if not x.is_absolute() or x.is_symlink():
            raise Refused('UNSAFE_PATH')
    if src == dst or not src.is_dir() or not str(src).startswith('/home/opencode/'):
        if not os.getenv('OPENCHAMBER_MIGRATION_TEST'):
            raise Refused('INVALID_SOURCE')
    if dst != DEFAULT_DST and not os.getenv('OPENCHAMBER_MIGRATION_TEST'):
        raise Refused('INVALID_DESTINATION')
    if src.exists():
        for cur, dirs, files in os.walk(src, followlinks=False):
            for name in dirs + files:
                p = Path(cur, name)
                if p.is_symlink() or (not p.is_file() and not p.is_dir()):
                    raise Refused('UNSAFE_SOURCE_ENTRY: ' + str(p))

def state_dir_for(args):
    if os.getenv('OPENCHAMBER_MIGRATION_TEST') and os.geteuid() != 0:
        return Path(args.state_dir)
    return STATE_DIR

def atomic_json(path, value):
    tmp = path.with_name(path.name + '.tmp.' + secrets.token_hex(6))
    tmp.write_text(json.dumps(value, indent=2, sort_keys=True) + '\n')
    os.chmod(tmp, 0o600)
    os.replace(tmp, path)

def secure_copy(src, dst):
    if dst.exists(): raise Refused('STAGE_ALREADY_EXISTS')
    shutil.copytree(src, dst, symlinks=False, copy_function=shutil.copy2)
    for cur, dirs, files in os.walk(dst):
        os.chmod(cur, 0o700)
        for f in files:
            p = Path(cur, f)
            mode = stat.S_IMODE(p.stat().st_mode)
            os.chmod(p, 0o700 if mode & stat.S_IXUSR else 0o600)

def perform(cmd, args):
    src, dst = Path(args.source), Path(args.destination)
    check_paths(src, dst)
    state_root = state_dir_for(args)
    state_root.mkdir(parents=True, exist_ok=True, mode=0o700)
    if state_root.is_symlink(): raise Refused('UNSAFE_STATE_DIR')
    os.chmod(state_root, 0o700)
    state_file = state_root/'state.json'
    state = json.loads(state_file.read_text()) if state_file.exists() else {}
    if cmd == 'status':
        return {'status': state.get('status','not_started'), 'source': str(src), 'destination': str(dst)}
    if cmd == 'stage':
        if state.get('status') == 'completed': return {'status':'completed','reused':True}
        if state.get('status') == 'staged': return {'status':'staged','reused':True}
        if state: raise Refused('MIGRATION_TRANSACTION_PENDING')
        # Never replace working files while an OpenChamber instance can write them.
        # The caller must verify quiescence before staging.
        if args.quiescent != 'yes': raise Refused('QUIESCENCE_NOT_CONFIRMED')
        dst.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        marker = secrets.token_hex(8)
        stage = dst.parent/('.openchamber.p1-stage-'+marker)
        previous = dst.parent/('.openchamber.p1-previous-'+marker)
        secure_copy(src,stage)
        state = {'status':'prepared','source':str(src),'destination':str(dst),
                 'stage':str(stage),'previous':str(previous),'created_at':int(time.time())}
        atomic_json(state_file,state)
        try:
            if dst.exists(): os.replace(dst, previous)
            os.replace(stage,dst)
        except BaseException:
            if previous.exists() and not dst.exists(): os.replace(previous,dst)
            raise
        state['status']='staged'
        atomic_json(state_file,state)
        return {'status':'staged','previous_saved':previous.exists()}
    if cmd == 'complete':
        if state.get('status') == 'completed': return {'status':'completed','reused':True}
        if state.get('status') != 'staged': raise Refused('NO_STAGED_MIGRATION')
        if args.ready != 'yes': raise Refused('ROOT_SERVICE_NOT_VERIFIED')
        if not dst.is_dir(): raise Refused('MISSING_MIGRATED_DATA')
        state['status']='completed'
        atomic_json(state_file,state)
        return {'status':'completed','old_data_preserved':True}
    if cmd == 'rollback':
        if state.get('status') == 'completed': raise Refused('COMPLETED_MIGRATION_CANNOT_ROLLBACK_AUTOMATICALLY')
        if not state or state.get('status') not in ('staged','prepared'):
            raise Refused('NO_ACTIVE_MIGRATION')
        saved = Path(state['previous'])
        moved = dst.parent/('.openchamber.p1-aborted-'+secrets.token_hex(6))
        if dst.exists(): os.replace(dst,moved)  # preserve post-stage writes
        if saved.exists(): os.replace(saved,dst)
        if not saved.exists() and not dst.exists(): pass  # previously no root data
        if state_file.exists(): state_file.unlink()
        return {'status':'rolled_back','source_untouched':True,'aborted_copy':str(moved)}
    raise Refused('INVALID_ACTION')

def main():
    p=argparse.ArgumentParser()
    p.add_argument('action',choices=['status','stage','complete','rollback'])
    p.add_argument('--source',default=str(DEFAULT_SRC))
    p.add_argument('--destination',default=str(DEFAULT_DST))
    p.add_argument('--state-dir',default=str(STATE_DIR))
    p.add_argument('--quiescent',choices=['yes','no'],default='no')
    p.add_argument('--ready',choices=['yes','no'],default='no')
    a=p.parse_args()
    print(json.dumps(perform(a.action,a),sort_keys=True))

if __name__ == '__main__':
    try: main()
    except Refused as e:
        print(json.dumps({'error':str(e)}),file=sys.stderr)
        sys.exit(2)