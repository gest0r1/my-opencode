import { connect } from 'node:net';
import { existsSync, lstatSync } from 'node:fs';

export const BROKER_ENFORCEMENT_MARKER = '/etc/my-opencode/owner-broker-required';
const BROKER_POLICY_DIR = '/etc/my-opencode';
export const AGENT_SOCKET = '/run/my-opencode-approval/agent.sock';

/** The installer owns this file; user input/env cannot turn protected mode off. */
export function ownerBrokerRequired() {
  // A root-only parent (0700) makes existsSync(marker) silently return
  // false for opencode; that would re-enable legacy self-confirmation.
  // A broker socket with a missing/hidden marker must also fail closed.
  const parent = existsSync(BROKER_POLICY_DIR) ? lstatSync(BROKER_POLICY_DIR) : null;
  if (parent && (!parent.isDirectory() || parent.isSymbolicLink() ||
      parent.uid !== 0 || (parent.mode & 0o022) || !(parent.mode & 0o001))) {
    throw new Error('OWNER_BROKER_POLICY_DIR_UNTRUSTED');
  }
  if (!existsSync(BROKER_ENFORCEMENT_MARKER)) {
    if (existsSync(AGENT_SOCKET)) throw new Error('OWNER_BROKER_POLICY_MARKER_MISSING');
    return false;
  }
  const st = lstatSync(BROKER_ENFORCEMENT_MARKER);
  if (!st.isFile() || st.isSymbolicLink() || st.uid !== 0 || (st.mode & 0o022)) {
    throw new Error('OWNER_BROKER_POLICY_UNTRUSTED');
  }
  return true;
}

/** Agent socket returns immutable broker outcome, not model-provided evidence. */
export function agentBrokerAction(payload, socketPath = AGENT_SOCKET) {
  return new Promise((resolve, reject) => {
    let buffer = '';
    let resolved = false;
    const socket = connect(socketPath);
    const timeout = setTimeout(() => socket.destroy(new Error('OWNER_BROKER_TIMEOUT')), 5000);
    const done = (error, value) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timeout);
      socket.destroy();
      if (error) reject(error); else resolve(value);
    };
    socket.once('connect', () => socket.write(JSON.stringify(payload) + '\n'));
    socket.on('data', (chunk) => {
      buffer += chunk.toString();
      if (buffer.length > 32768) return done(new Error('OWNER_BROKER_RESPONSE_TOO_LARGE'));
      const i = buffer.indexOf('\n');
      if (i < 0) return;
      try {
        const response = JSON.parse(buffer.slice(0, i));
        if (typeof response.error === 'string') return done(new Error('OWNER_BROKER_DENIED: ' + response.error));
        if (!response.ok) return done(new Error('OWNER_BROKER_INVALID_RESPONSE'));
        done(null, response.ok);
      } catch (error) { done(error); }
    });
    socket.once('error', (error) => done(error));
    socket.once('end', () => { if (!resolved) done(new Error('OWNER_BROKER_NO_RESPONSE')); });
  });
}

export async function requireOwnerCheckpoint(checkpoint) {
  if (!ownerBrokerRequired()) return { mode: 'legacy' };
  try {
    const request = await agentBrokerAction({ action: 'submit', checkpoint });
    const result = await agentBrokerAction({ action: 'consume', checkpoint, request_id: request.id });
    if (result.authorized !== true) {
      throw new Error(`OWNER_APPROVAL_PENDING: ${request.id} operation=${checkpoint.operation} run=${checkpoint.run_id} sha=${checkpoint.subject_sha256}`);
    }
    return { mode: 'broker', id: request.id };
  } catch (error) {
    // Broker outage or rejection is always a fail-closed transition.
    if (String(error).includes('OWNER_APPROVAL_PENDING')) throw error;
    throw new Error('OWNER_BROKER_REQUIRED: ' + String(error));
  }
}