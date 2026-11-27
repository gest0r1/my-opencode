#!/usr/bin/env python3
"""Canonical owner checkpoints for the passkey approval service."""
import contextlib
import hashlib
import json
import re
import secrets
import sqlite3
import time

IDENTIFIER = re.compile(r'[A-Za-z0-9][A-Za-z0-9._:-]{0,127}')
TOKEN = re.compile(r'[A-Za-z0-9_-]{1,16384}')
REVISION = re.compile(r'(?:[a-f0-9]{40}|[a-f0-9]{64})')
REPOSITORY = re.compile(r'[A-Za-z0-9._-]{1,100}/[A-Za-z0-9._-]{1,100}')
APPROVAL_TIMEOUT = 3600
CHALLENGE_TIMEOUT = 120
ENROLLMENT_TIMEOUT = 600
SNAPSHOT_LIMIT = 256 * 1024


def initialize(connection):
    connection.executescript('''
        CREATE TABLE IF NOT EXISTS canonical_runs (
            instance_id TEXT PRIMARY KEY,
            run_id TEXT NOT NULL UNIQUE,
            session_id TEXT NOT NULL,
            workspace TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS canonical_checkpoints (
            request_id TEXT PRIMARY KEY,
            instance_id TEXT NOT NULL REFERENCES canonical_runs(instance_id),
            operation TEXT NOT NULL,
            pipeline_id TEXT NOT NULL,
            stage TEXT NOT NULL,
            generation INTEGER NOT NULL,
            plan_generation INTEGER NOT NULL,
            manifest_sha256 TEXT NOT NULL,
            subject_sha256 TEXT NOT NULL,
            candidate_sha TEXT NOT NULL,
            snapshot TEXT NOT NULL,
            expires_at INTEGER NOT NULL,
            decision TEXT NOT NULL DEFAULT 'pending',
            decided_at INTEGER,
            credential_id TEXT,
            UNIQUE(instance_id, operation, pipeline_id, stage, generation)
        );
        CREATE TABLE IF NOT EXISTS retired_owner_runs (
            run_id TEXT PRIMARY KEY,
            replacement_run_id TEXT NOT NULL,
            retired_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS frozen_plan_suspensions (
            instance_id TEXT NOT NULL REFERENCES canonical_runs(instance_id),
            plan_generation INTEGER NOT NULL,
            request_id TEXT NOT NULL REFERENCES canonical_checkpoints(request_id),
            PRIMARY KEY(instance_id, plan_generation)
        );
        CREATE TABLE IF NOT EXISTS frozen_plan_refreeze_links (
            request_id TEXT PRIMARY KEY REFERENCES canonical_checkpoints(request_id),
            unfreeze_request_id TEXT NOT NULL REFERENCES canonical_checkpoints(request_id)
        );
        CREATE TABLE IF NOT EXISTS owner_passkeys (
            id TEXT PRIMARY KEY,
            public_key TEXT NOT NULL,
            counter INTEGER NOT NULL,
            revoked INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS owner_passkey_challenges (
            challenge TEXT PRIMARY KEY,
            request_id TEXT NOT NULL REFERENCES canonical_checkpoints(request_id),
            decision TEXT NOT NULL,
            allowed_credentials TEXT NOT NULL,
            expires_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS owner_passkey_enrollments (
            token_hash TEXT PRIMARY KEY,
            challenge TEXT NOT NULL,
            user_id TEXT NOT NULL,
            expires_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS owner_transition_outbox (
            request_id TEXT PRIMARY KEY REFERENCES canonical_checkpoints(request_id),
            message_id TEXT NOT NULL UNIQUE,
            dispatched_at INTEGER,
            claim_until INTEGER,
            last_inspected INTEGER NOT NULL DEFAULT 0
        );
    ''')


@contextlib.contextmanager
def transaction(connection):
    connection.execute('BEGIN IMMEDIATE')
    try:
        yield
        connection.execute('COMMIT')
    except BaseException:
        connection.execute('ROLLBACK')
        raise


def fail(reason):
    raise ValueError(reason)


def require_fields(request, *fields):
    if request.keys() != {'action', *fields}:
        fail('INVALID_REQUEST_FIELDS')


def validated(value, pattern):
    if not isinstance(value, str) or not pattern.fullmatch(value):
        fail('INVALID_REQUEST_VALUE')
    return value


def generation(value):
    if type(value) is not int or not 0 <= value <= 1_000_000:
        fail('INVALID_GENERATION')
    return value


def register(connection, request):
    require_fields(request, 'run_id', 'session_id', 'workspace')
    identity = tuple(validated(request[name], IDENTIFIER) for name in ('run_id', 'session_id', 'workspace'))
    if retired_run(connection, identity[0]):
        fail('OWNER_RUN_RETIRED')
    connection.execute('INSERT OR IGNORE INTO canonical_runs VALUES (?, ?, ?, ?)', (secrets.token_hex(16), *identity))
    row = connection.execute('SELECT instance_id, session_id, workspace FROM canonical_runs WHERE run_id=?', identity[:1]).fetchone()
    if tuple(row[1:]) != identity[1:]:
        fail('RUN_BINDING_MISMATCH')
    return {'instance_id': row['instance_id'], 'run_id': identity[0]}


def latest(connection, instance, operation, pipeline, stage):
    return connection.execute('''
        SELECT * FROM canonical_checkpoints
        WHERE instance_id=? AND operation=? AND pipeline_id=? AND stage=?
        ORDER BY generation DESC LIMIT 1
    ''', (instance, operation, pipeline, stage)).fetchone()


def retired_run(connection, run_id):
    return connection.execute('SELECT replacement_run_id FROM retired_owner_runs WHERE run_id=?', (run_id,)).fetchone()


def plan_suspension(connection, instance, plan_generation):
    return connection.execute('''
        SELECT request_id FROM frozen_plan_suspensions WHERE instance_id=? AND plan_generation=?
    ''', (instance, plan_generation)).fetchone()


def lookup(connection, request_id):
    row = connection.execute('''
        SELECT checkpoint.*, run.session_id, run.workspace, run.run_id
        FROM canonical_checkpoints checkpoint JOIN canonical_runs run USING(instance_id)
        WHERE request_id=?
    ''', (validated(request_id, IDENTIFIER),)).fetchone()
    if row is None:
        fail('UNKNOWN_REQUEST')
    return row


def current(connection, row):
    if retired_run(connection, row['run_id']):
        return False
    newest = latest(connection, row['instance_id'], row['operation'], row['pipeline_id'], row['stage'])
    if not newest or newest['request_id'] != row['request_id']:
        return False
    if newest['operation'] == 'plan.final_manifest.approve':
        return not plan_suspension(connection, row['instance_id'], row['generation'])
    plan = latest(connection, row['instance_id'], 'plan.final_manifest.approve', 'all', 'approval')
    if not plan or plan['generation'] != row['plan_generation'] or plan['decision'] != 'approved':
        return False
    suspension = plan_suspension(connection, row['instance_id'], row['plan_generation'])
    if newest['operation'] == 'plan.unfreeze':
        if row['decision'] == 'approved':
            return bool(suspension and suspension['request_id'] == row['request_id'])
        return not suspension
    if newest['operation'] == 'plan.unfreeze.abort':
        return bool(suspension) or row['decision'] == 'approved'
    return not suspension


def digest(text):
    return hashlib.sha256(text.encode()).hexdigest()


def read_snapshot(raw):
    if not isinstance(raw, str) or len(raw.encode()) > SNAPSHOT_LIMIT:
        fail('INVALID_SNAPSHOT_SIZE')

    def unique(items):
        obj = dict(items)
        if len(obj) != len(items):
            fail('DUPLICATE_SNAPSHOT_FIELD')
        return obj

    try:
        snapshot = json.loads(raw, object_pairs_hook=unique, parse_constant=lambda _: fail('INVALID_SNAPSHOT_NUMBER'))
    except (ValueError, RecursionError):
        fail('INVALID_SNAPSHOT_JSON')
    if not isinstance(snapshot, dict):
        fail('INVALID_SNAPSHOT_JSON')
    return snapshot


def pipeline_definitions(snapshot):
    pipelines = snapshot.get('pipelines')
    if not isinstance(pipelines, list) or not pipelines:
        fail('INVALID_PLAN_SNAPSHOT')
    definitions = {}
    for pipeline in pipelines:
        if not isinstance(pipeline, dict):
            fail('INVALID_PLAN_SNAPSHOT')
        identifier = validated(pipeline.get('id'), IDENTIFIER)
        stages = pipeline.get('stages')
        executors = pipeline.get('executors', {})
        if identifier in definitions or not isinstance(stages, list) or not stages or not isinstance(executors, dict):
            fail('INVALID_PLAN_SNAPSHOT')
        names = [validated(name, IDENTIFIER) for name in stages]
        if len(set(names)) != len(names) or set(executors).difference(names):
            fail('INVALID_PLAN_SNAPSHOT')
        definitions[identifier] = executors
    return definitions


def prepare(connection, request, now):
    require_fields(request, 'instance_id', 'operation', 'pipeline_id', 'stage', 'previous_generation', 'snapshot')
    instance = validated(request['instance_id'], IDENTIFIER)
    run = connection.execute('SELECT run_id FROM canonical_runs WHERE instance_id=?', (instance,)).fetchone()
    if run is None:
        fail('UNKNOWN_RUN')
    if retired_run(connection, run['run_id']):
        fail('OWNER_RUN_RETIRED')
    operation = request['operation']
    pipeline = validated(request['pipeline_id'], IDENTIFIER)
    stage = validated(request['stage'], IDENTIFIER)
    previous = generation(request['previous_generation'])
    raw = request['snapshot']
    snapshot = read_snapshot(raw)
    subject = digest(raw)
    refreeze = None
    if operation == 'plan.final_manifest.approve':
        if pipeline != 'all' or stage != 'approval' or snapshot.get('schema_version') != 2 or snapshot.get('run_id') != run['run_id']:
            fail('INVALID_PLAN_SNAPSHOT')
        pipeline_definitions(snapshot)
        plan_generation, manifest, candidate = 0, subject, ''
        existing_plan = latest(connection, instance, operation, pipeline, stage)
        if existing_plan:
            suspension = plan_suspension(connection, instance, existing_plan['generation'])
            link = connection.execute('SELECT unfreeze_request_id FROM frozen_plan_refreeze_links WHERE request_id=?',
                                      (existing_plan['request_id'],)).fetchone()
            if suspension:
                refreeze = suspension['request_id']
            elif link and existing_plan['decision'] != 'approved':
                refreeze = link['unfreeze_request_id']
    elif operation in ('owner.accept', 'owner.amend', 'plan.unfreeze', 'plan.unfreeze.abort'):
        plan = latest(connection, instance, 'plan.final_manifest.approve', 'all', 'approval')
        if not plan or plan['decision'] != 'approved' or snapshot.get('manifest_sha256') != plan['manifest_sha256']:
            fail('PLAN_APPROVAL_REQUIRED')
        plan_generation, manifest = plan['generation'], plan['manifest_sha256']
        if operation in ('owner.accept', 'owner.amend') and plan_suspension(connection, instance, plan_generation):
            fail('OWNER_PLAN_SUSPENDED')
        if operation == 'owner.accept':
            if snapshot.get('pipeline_id') != pipeline or snapshot.get('stage') != stage:
                fail('INVALID_ACCEPTANCE_SNAPSHOT')
            if pipeline_definitions(read_snapshot(plan['snapshot'])).get(pipeline, {}).get(stage) != 'owner_acceptance':
                fail('OWNER_STAGE_NOT_FROZEN')
            candidate = validated(snapshot.get('candidate_sha'), REVISION)
        elif operation == 'owner.amend':
            revision = generation(snapshot.get('revision'))
            if (snapshot.get('run_id') != run['run_id'] or snapshot.get('pipeline_id') != pipeline
                    or stage != f'amendment-{revision}' or not isinstance(snapshot.get('proposal'), dict)
                    or snapshot.get('stage') not in pipeline_definitions(read_snapshot(plan['snapshot'])).get(pipeline, {})):
                fail('INVALID_AMENDMENT_SNAPSHOT')
            candidate = ''
        else:
            if (pipeline, stage) != ('all', 'approval') or snapshot.get('run_id') != run['run_id']:
                fail('INVALID_UNFREEZE_SNAPSHOT')
            candidate = ''
            if operation == 'plan.unfreeze.abort' and not plan_suspension(connection, instance, plan_generation):
                prior = latest(connection, instance, operation, pipeline, stage)
                if not prior or prior['decision'] != 'approved' or prior['subject_sha256'] != subject:
                    fail('OWNER_UNFREEZE_NOT_SUSPENDED')
    else:
        fail('INVALID_OPERATION')
    row = latest(connection, instance, operation, pipeline, stage)
    active_generation = row['generation'] if row else 0
    if row and row['subject_sha256'] == subject and row['plan_generation'] == plan_generation and (
        row['expires_at'] > now or row['decision'] in ('approved', 'rejected')
    ) and previous in (active_generation, active_generation - 1) and (
        operation != 'plan.unfreeze' or row['decision'] != 'approved' or current(connection, lookup(connection, row['request_id']))
    ):
        return status(connection, row['request_id'])
    if previous != active_generation or previous >= 1_000_000:
        fail('CHECKPOINT_GENERATION_MISMATCH')
    claiming = connection.execute('''
        SELECT 1 FROM owner_transition_outbox outbox JOIN canonical_checkpoints checkpoint USING(request_id)
        WHERE instance_id=? AND outbox.dispatched_at IS NULL AND outbox.claim_until>?
          AND (?='plan.final_manifest.approve' OR request_id=?) LIMIT 1
    ''', (instance, now, operation, row['request_id'] if row else '')).fetchone()
    if claiming:
        fail('OWNER_CONTINUATION_IN_PROGRESS')
    request_id = secrets.token_hex(16)
    connection.execute('''
        INSERT INTO canonical_checkpoints
        (request_id, instance_id, operation, pipeline_id, stage, generation, plan_generation,
         manifest_sha256, subject_sha256, candidate_sha, snapshot, expires_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ''', (request_id, instance, operation, pipeline, stage, previous + 1, plan_generation,
          manifest, subject, candidate, raw, now + APPROVAL_TIMEOUT))
    if refreeze:
        connection.execute('INSERT INTO frozen_plan_refreeze_links VALUES (?, ?)', (request_id, refreeze))
    return status(connection, request_id)


def status(connection, request_id):
    row = lookup(connection, request_id)
    fields = ('request_id', 'instance_id', 'run_id', 'session_id', 'workspace', 'operation', 'pipeline_id',
              'stage', 'generation', 'manifest_sha256', 'subject_sha256', 'candidate_sha', 'expires_at', 'decision')
    return {**{name: row[name] for name in fields}, 'current': current(connection, row)}


def pending(connection, request_id, now):
    row = lookup(connection, request_id)
    if not current(connection, row) or row['decision'] != 'pending' or row['expires_at'] <= now:
        fail('CHECKPOINT_NOT_PENDING')
    return row


def issue_challenge(connection, request, now):
    require_fields(request, 'request_id', 'decision')
    row = pending(connection, request['request_id'], now)
    decision = request['decision']
    if decision not in ('approve', 'reject'):
        fail('INVALID_DECISION')
    passkeys = connection.execute('SELECT id FROM owner_passkeys WHERE revoked=0 ORDER BY id').fetchall()
    if not passkeys:
        fail('NO_OWNER_PASSKEYS')
    challenge = secrets.token_urlsafe(32)
    connection.execute('DELETE FROM owner_passkey_challenges WHERE expires_at<=?', (now,))
    # Replace only the earlier challenge for the same request and action.
    connection.execute('DELETE FROM owner_passkey_challenges WHERE request_id=? AND decision=?', (row['request_id'], decision))
    credentials = [row['id'] for row in passkeys]
    connection.execute('INSERT INTO owner_passkey_challenges VALUES (?, ?, ?, ?, ?)',
                       (challenge, row['request_id'], decision, json.dumps(credentials), min(now + CHALLENGE_TIMEOUT, row['expires_at'])))
    return {'challenge': challenge, 'credentials': credentials}


def challenge_credential(connection, request, now):
    row = pending(connection, request['request_id'], now)
    challenge = connection.execute('''
        SELECT decision, allowed_credentials FROM owner_passkey_challenges WHERE challenge=? AND request_id=? AND expires_at>?
    ''', (validated(request['challenge'], TOKEN), row['request_id'], now)).fetchone()
    if challenge is None:
        fail('INVALID_OR_EXPIRED_CHALLENGE')
    credential_id = validated(request['credential_id'], TOKEN)
    if credential_id not in json.loads(challenge['allowed_credentials']):
        fail('UNKNOWN_OWNER_CREDENTIAL')
    credential = connection.execute('SELECT * FROM owner_passkeys WHERE id=? AND revoked=0', (credential_id,)).fetchone()
    if credential is None:
        fail('UNKNOWN_OWNER_CREDENTIAL')
    return row, challenge['decision'], credential


def finish(connection, request, now):
    require_fields(request, 'request_id', 'challenge', 'credential_id', 'previous_counter', 'new_counter')
    row, decision, credential = challenge_credential(connection, request, now)
    old, new = request['previous_counter'], request['new_counter']
    if type(old) is not int or type(new) is not int or old != credential['counter'] or not 0 <= new <= 0xFFFFFFFF:
        fail('PASSKEY_COUNTER_CHANGED')
    if (old or new) and new <= old:
        fail('PASSKEY_COUNTER_CHANGED')
    connection.execute('UPDATE owner_passkeys SET counter=? WHERE id=?', (new, credential['id']))
    connection.execute('DELETE FROM owner_passkey_challenges WHERE request_id=?', (row['request_id'],))
    terminal = 'approved' if decision == 'approve' else 'rejected'
    connection.execute('UPDATE canonical_checkpoints SET decision=?, decided_at=?, credential_id=? WHERE request_id=?',
                       (terminal, now, credential['id'], row['request_id']))
    if terminal == 'approved':
        if row['operation'] == 'plan.unfreeze':
            connection.execute('INSERT INTO frozen_plan_suspensions VALUES (?, ?, ?)',
                               (row['instance_id'], row['plan_generation'], row['request_id']))
        if row['operation'] == 'plan.unfreeze.abort':
            connection.execute('DELETE FROM frozen_plan_suspensions WHERE instance_id=? AND plan_generation=?',
                               (row['instance_id'], row['plan_generation']))
        connection.execute('INSERT INTO owner_transition_outbox (request_id, message_id) VALUES (?, ?)',
                           (row['request_id'], 'msg_' + secrets.token_hex(16)))
    return status(connection, row['request_id'])


def create_enrollment(connection, now):
    token = secrets.token_urlsafe(32)
    expiration = now + ENROLLMENT_TIMEOUT
    connection.execute('DELETE FROM owner_passkey_enrollments WHERE expires_at<=?', (now,))
    connection.execute('INSERT INTO owner_passkey_enrollments VALUES (?, ?, ?, ?)',
                       (digest(token), secrets.token_urlsafe(32), secrets.token_urlsafe(32), expiration))
    return {'token': token, 'expires_at': expiration}


def enrollment(connection, token, now):
    row = connection.execute('SELECT * FROM owner_passkey_enrollments WHERE token_hash=? AND expires_at>?',
                             (digest(validated(token, TOKEN)), now)).fetchone()
    if row is None:
        fail('INVALID_OR_EXPIRED_ENROLLMENT')
    return row


def insert_credential(connection, request):
    identifier = validated(request['credential_id'], TOKEN)
    key = validated(request['public_key'], TOKEN)
    counter = request['counter']
    if type(counter) is not int or not 0 <= counter <= 0xFFFFFFFF:
        fail('INVALID_PASSKEY_COUNTER')
    connection.execute('INSERT INTO owner_passkeys (id, public_key, counter) VALUES (?, ?, ?)', (identifier, key, counter))
    return {'id': identifier}


def continuations(connection, session_id=None, inspected_at=None):
    rows = connection.execute('''
        SELECT outbox.request_id, outbox.message_id FROM owner_transition_outbox outbox
        JOIN canonical_checkpoints checkpoint USING(request_id)
        JOIN canonical_runs run USING(instance_id)
        WHERE (? IS NULL OR run.session_id=?) AND outbox.dispatched_at IS NULL
          AND checkpoint.generation=(SELECT max(latest.generation) FROM canonical_checkpoints latest
             WHERE latest.instance_id=checkpoint.instance_id AND latest.operation=checkpoint.operation
             AND latest.pipeline_id=checkpoint.pipeline_id AND latest.stage=checkpoint.stage)
        ORDER BY outbox.last_inspected, checkpoint.decided_at, checkpoint.rowid
    ''', (session_id, session_id))
    pending = []
    for row in rows:
        entry = status(connection, row['request_id'])
        if entry['current']:
            pending.append({**entry, 'message_id': row['message_id']})
            if inspected_at is not None:
                connection.execute('UPDATE owner_transition_outbox SET last_inspected=? WHERE request_id=?',
                                   (inspected_at, row['request_id']))
        if len(pending) == 10:
            break
    return {'pending': pending}


def list_checkpoints(connection, now, before):
    if type(before) is not int or not 0 <= before <= 0x7FFF_FFFF_FFFF_FFFF:
        fail('INVALID_CHECKPOINT_CURSOR')
    rows = connection.execute('''
        SELECT checkpoint.rowid, request_id, run.run_id, run.session_id, run.workspace, operation,
               pipeline_id, stage, generation, manifest_sha256, candidate_sha, decision, expires_at,
               (SELECT json_extract(plan.snapshot, '$.repository') FROM canonical_checkpoints plan
                WHERE plan.instance_id=checkpoint.instance_id AND plan.operation='plan.final_manifest.approve'
                AND plan.generation=CASE WHEN checkpoint.plan_generation=0 THEN checkpoint.generation
                ELSE checkpoint.plan_generation END) AS repository
        FROM canonical_checkpoints checkpoint JOIN canonical_runs run USING(instance_id)
        WHERE (?=0 OR checkpoint.rowid<?) ORDER BY checkpoint.rowid DESC LIMIT 41
    ''', (before, before)).fetchall()
    entries = []
    for row in rows[:40]:
        entry = dict(row)
        entry.pop('rowid')
        repository = entry.pop('repository')
        entry['project'] = repository if isinstance(repository, str) and REPOSITORY.fullmatch(repository) else ''
        if entry['decision'] == 'pending':
            checkpoint = lookup(connection, entry['request_id'])
            if not current(connection, checkpoint):
                entry['decision'] = 'superseded'
            elif entry['expires_at'] <= now:
                entry['decision'] = 'expired'
        entries.append(entry)
    return {'entries': entries, 'before': rows[39]['rowid'] if len(rows) > 40 else 0}


def list_pending_sessions(connection, now):
    rows = connection.execute('''
        SELECT request_id FROM canonical_checkpoints WHERE decision='pending' AND expires_at>?
        ORDER BY rowid DESC
    ''', (now,))
    sessions = set()
    for reference in rows:
        row = lookup(connection, reference['request_id'])
        if current(connection, row):
            sessions.add(row['session_id'])
        if len(sessions) == 200:
            break
    return {'sessions': sorted(sessions)}


def act(connection, role, request, clock=time.time):
    """Only the separately authenticated verifier peer can finalize a decision."""
    connection.row_factory = sqlite3.Row
    now = int(clock())
    operation = request.get('action')
    with transaction(connection):
        if role == 'runtime':
            if operation == 'register':
                return register(connection, request)
            if operation == 'retired_run':
                require_fields(request, 'run_id')
                row = retired_run(connection, validated(request['run_id'], IDENTIFIER))
                return {'replacement_run_id': row['replacement_run_id'] if row else None}
            if operation == 'retire_run':
                require_fields(request, 'run_id', 'replacement_run_id')
                run_id = validated(request['run_id'], IDENTIFIER)
                replacement = validated(request['replacement_run_id'], IDENTIFIER)
                if run_id == replacement:
                    fail('INVALID_RUN_REPLACEMENT')
                existing = retired_run(connection, run_id)
                if existing and existing['replacement_run_id'] != replacement:
                    fail('OWNER_RUN_REPLACEMENT_CONFLICT')
                claiming = connection.execute('''
                    SELECT 1 FROM owner_transition_outbox outbox JOIN canonical_checkpoints checkpoint USING(request_id)
                    JOIN canonical_runs run USING(instance_id)
                    WHERE run.run_id=? AND outbox.dispatched_at IS NULL AND outbox.claim_until>? LIMIT 1
                ''', (run_id, now)).fetchone()
                if claiming:
                    fail('OWNER_CONTINUATION_IN_PROGRESS')
                connection.execute('INSERT OR IGNORE INTO retired_owner_runs VALUES (?, ?, ?)', (run_id, replacement, now))
                return {'replacement_run_id': replacement}
            if operation == 'binding':
                require_fields(request, 'run_id')
                row = connection.execute('SELECT * FROM canonical_runs WHERE run_id=?',
                                         (validated(request['run_id'], IDENTIFIER),)).fetchone()
                if row is None:
                    fail('UNKNOWN_RUN')
                return dict(row)
            if operation == 'latest':
                require_fields(request, 'instance_id', 'operation', 'pipeline_id', 'stage')
                row = latest(connection, *(validated(request[name], IDENTIFIER) for name in
                             ('instance_id', 'operation', 'pipeline_id', 'stage')))
                return {'generation': row['generation'] if row else 0}
            if operation == 'prepare':
                return prepare(connection, request, now)
            if operation == 'status':
                require_fields(request, 'request_id')
                return status(connection, request['request_id'])
            if operation == 'verify_refreeze':
                require_fields(request, 'request_id', 'unfreeze_request_id')
                row = lookup(connection, request['request_id'])
                match = connection.execute('SELECT 1 FROM frozen_plan_refreeze_links WHERE request_id=? AND unfreeze_request_id=?',
                                           (row['request_id'], validated(request['unfreeze_request_id'], IDENTIFIER))).fetchone()
                return {'authorized': bool(match and row['decision'] == 'approved' and current(connection, row))}
            if operation == 'list_checkpoints':
                require_fields(request, 'before')
                return list_checkpoints(connection, now, request['before'])
            if operation == 'list_pending_sessions':
                require_fields(request)
                return list_pending_sessions(connection, now)
            if operation == 'continuations':
                require_fields(request, 'session_id')
                return continuations(connection, validated(request['session_id'], IDENTIFIER))
            if operation == 'scan_continuations':
                require_fields(request)
                return continuations(connection, inspected_at=now)
            if operation == 'claim_continuation':
                require_fields(request, 'request_id', 'session_id', 'message_id')
                checkpoint = lookup(connection, request['request_id'])
                if checkpoint['session_id'] != request['session_id'] or not current(connection, checkpoint):
                    fail('CHECKPOINT_MISMATCH')
                reserved = connection.execute('''
                    UPDATE owner_transition_outbox SET claim_until=?
                    WHERE request_id=? AND message_id=? AND dispatched_at IS NULL
                      AND (claim_until IS NULL OR claim_until<=?)
                ''', (now + 15, checkpoint['request_id'], request['message_id'], now))
                return {'claimed': bool(reserved.rowcount)}
            if operation == 'ack_continuation':
                require_fields(request, 'request_id', 'session_id', 'message_id')
                checkpoint = lookup(connection, request['request_id'])
                if checkpoint['session_id'] != request['session_id'] or not current(connection, checkpoint):
                    fail('CHECKPOINT_MISMATCH')
                recorded = connection.execute('''
                    UPDATE owner_transition_outbox SET dispatched_at=coalesce(dispatched_at, ?)
                    WHERE request_id=? AND message_id=? AND (dispatched_at IS NOT NULL OR claim_until>?)
                ''', (now, checkpoint['request_id'], request['message_id'], now))
                if not recorded.rowcount:
                    fail('CONTINUATION_MISMATCH')
                return {'ok': True}
        elif role == 'verifier':
            if operation == 'health':
                require_fields(request)
                return {'ready': True}
            if operation == 'review':
                require_fields(request, 'request_id')
                row = pending(connection, request['request_id'], now)
                return {**status(connection, row['request_id']), 'snapshot': row['snapshot']}
            if operation == 'challenge':
                return issue_challenge(connection, request, now)
            if operation == 'credential':
                require_fields(request, 'request_id', 'challenge', 'credential_id')
                _, _, credential = challenge_credential(connection, request, now)
                return {name: credential[name] for name in ('id', 'public_key', 'counter')}
            if operation == 'finish':
                return finish(connection, request, now)
            if operation == 'enrollment':
                require_fields(request, 'token')
                row = enrollment(connection, request['token'], now)
                return {name: row[name] for name in ('challenge', 'user_id')}
            if operation == 'enroll':
                require_fields(request, 'token', 'challenge', 'credential_id', 'public_key', 'counter')
                row = enrollment(connection, request['token'], now)
                if row['challenge'] != request['challenge']:
                    fail('ENROLLMENT_CHALLENGE_MISMATCH')
                credential = insert_credential(connection, request)
                connection.execute('DELETE FROM owner_passkey_enrollments WHERE token_hash=?', (row['token_hash'],))
                return credential
        elif role == 'admin':
            if operation == 'create_enrollment':
                require_fields(request)
                return create_enrollment(connection, now)
            if operation == 'register_credential':
                require_fields(request, 'credential_id', 'public_key', 'counter')
                return insert_credential(connection, request)
            if operation == 'revoke_credential':
                require_fields(request, 'credential_id')
                identifier = validated(request['credential_id'], TOKEN)
                connection.execute('UPDATE owner_passkeys SET revoked=1 WHERE id=?', (identifier,))
                return {'id': identifier}
        fail('APPROVAL_ACTION_FORBIDDEN')
