import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import {
  AGENT_SESSION_API_METHODS,
  AGENT_SESSION_API_VERSION,
  AGENT_SESSION_DELIVERY_HOOKS,
  AGENT_SESSION_LIFECYCLE_METHODS,
  AGENT_SESSION_RUNTIME_VERSION,
  AGENT_SESSION_WORKFLOW_PORT_METHODS,
  createAgentSessionRuntime,
  createAgentSessionWorkflowPort
} from '../index.js';

const sha256 = value => createHash('sha256').update(value).digest('hex');
const eventId = (jobId, type, key = '') => sha256(`${jobId}|${type}|${key}`);

function createHost({ database = new DatabaseSync(':memory:') } = {}) {
  database.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE jobs(job_id TEXT PRIMARY KEY);
    CREATE TABLE tasks(
      task_id TEXT PRIMARY KEY,
      job_id TEXT NOT NULL REFERENCES jobs(job_id),
      role TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'running',
      openclaw_session_key TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE events(
      event_id TEXT PRIMARY KEY,
      job_id TEXT NOT NULL REFERENCES jobs(job_id),
      type TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX idx_events_job_type ON events(job_id,type,created_at);
  `);
  const now = new Date().toISOString();
  database.prepare('INSERT INTO jobs(job_id) VALUES(?)').run('job_agent-runtime-test');
  database.prepare(`INSERT INTO tasks(task_id,job_id,role,status,created_at,updated_at)
    VALUES(?,?,?,?,?,?)`).run('task_agent-runtime-test', 'job_agent-runtime-test', 'cto', 'running', now, now);

  const workflowImplementation = {
    assertSharedConnection(connection) { return connection === database; },
    getTask(taskId) {
      return database.prepare('SELECT * FROM tasks WHERE task_id=?').get(taskId) || null;
    },
    lockTaskForAgentSession(taskId) {
      return database.prepare('UPDATE tasks SET updated_at=updated_at WHERE task_id=?').run(taskId);
    },
    recordEvent(jobId, type, payload, dedupeKey = '') {
      const id = eventId(jobId, type, dedupeKey);
      database.prepare(`INSERT OR IGNORE INTO events(event_id,job_id,type,payload_json,created_at)
        VALUES(?,?,?,?,?)`).run(id, jobId, type, JSON.stringify(payload), new Date().toISOString());
      return id;
    },
    getEvent(id) {
      return database.prepare('SELECT * FROM events WHERE event_id=?').get(id) || null;
    },
    listEventsForJob(jobId, { type = null, limit = 50000 } = {}) {
      if (type) return database.prepare('SELECT * FROM events WHERE job_id=? AND type=? ORDER BY created_at,rowid LIMIT ?').all(jobId, type, limit);
      return database.prepare('SELECT * FROM events WHERE job_id=? ORDER BY created_at,rowid LIMIT ?').all(jobId, limit);
    },
    countEventsForJobType(jobId, type) {
      return database.prepare('SELECT COUNT(*) AS count FROM events WHERE job_id=? AND type=?').get(jobId, type).count;
    },
    listTasksWithOpenClawSession() {
      return database.prepare(`SELECT task_id,job_id,role,status,openclaw_session_key,created_at,updated_at
        FROM tasks WHERE openclaw_session_key IS NOT NULL AND openclaw_session_key<>'' ORDER BY created_at,rowid`).all();
    }
  };
  const workflowPort = createAgentSessionWorkflowPort(workflowImplementation);
  const runtime = createAgentSessionRuntime({ database, workflowPort });
  return {
    database,
    runtime,
    workflowPort,
    jobId: 'job_agent-runtime-test',
    taskId: 'task_agent-runtime-test',
    close() { database.close(); }
  };
}

async function withHost(fn) {
  const host = createHost();
  try { await fn(host); } finally { host.close(); }
}

test('Agent Session ports and runtime APIs are frozen, versioned, and separate from lifecycle hooks', async () => {
  await withHost(({ runtime }) => {
    assert.equal(runtime.version, AGENT_SESSION_RUNTIME_VERSION);
    assert.equal(runtime.api.version, AGENT_SESSION_API_VERSION);
    assert.equal(Object.isFrozen(runtime), true);
    assert.equal(Object.isFrozen(runtime.api), true);
    assert.equal(Object.isFrozen(runtime.lifecycleParticipant), true);
    assert.deepEqual(Object.keys(runtime.api).filter(key => key !== 'version').sort(), [...AGENT_SESSION_API_METHODS].sort());
    assert.deepEqual(Object.keys(runtime.lifecycleParticipant).filter(key => key !== 'kind' && key !== 'version').sort(),
      [...AGENT_SESSION_LIFECYCLE_METHODS].sort());
    assert.equal(Object.hasOwn(runtime.api, 'db'), false);
    assert.equal(Object.hasOwn(runtime.api, 'database'), false);
    assert.equal(Object.hasOwn(runtime.api, 'lockSession'), false);
    assert.equal(Object.hasOwn(runtime.lifecycleParticipant, 'getSession'), false);
    assert.equal(runtime.api.unrecognizedMethod, undefined);
    assert.equal(AGENT_SESSION_DELIVERY_HOOKS.length, 4);
    assert.equal(AGENT_SESSION_WORKFLOW_PORT_METHODS.length, 8);
  });
});

test('Agent Session rejects a mismatched SQLite connection before creating owner tables', () => {
  const database = new DatabaseSync(':memory:');
  database.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE jobs(job_id TEXT PRIMARY KEY);
    CREATE TABLE tasks(task_id TEXT PRIMARY KEY,job_id TEXT REFERENCES jobs(job_id),role TEXT,status TEXT,openclaw_session_key TEXT,created_at TEXT,updated_at TEXT);
    CREATE TABLE events(event_id TEXT PRIMARY KEY,job_id TEXT,type TEXT,payload_json TEXT,created_at TEXT);`);
  const workflowPort = createAgentSessionWorkflowPort({
    assertSharedConnection: () => false,
    getTask() {}, lockTaskForAgentSession() {}, recordEvent() {}, getEvent() {},
    listEventsForJob() {}, countEventsForJobType() {}, listTasksWithOpenClawSession() {}
  });
  try {
    assert.throws(() => createAgentSessionRuntime({ database, workflowPort }), /exact injected SQLite connection/);
    const tables = database.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => row.name);
    assert.equal(tables.includes('agent_sessions'), false);
    assert.equal(tables.includes('session_access'), false);
    assert.equal(tables.includes('session_messages'), false);
  } finally { database.close(); }
});

test('Session creation, state changes, ACL rows and Workflow events share one transaction unit', async () => {
  await withHost(async ({ database, runtime, taskId, jobId }) => {
    const session = runtime.api.createAgentSession(taskId, {
      sessionKey: 'agent:cto:subagent:runtime-test', role: 'cto'
    });
    assert.equal(session.job_id, jobId);
    assert.equal(runtime.api.getSession(session.session_id).session_id, session.session_id);
    const created = database.prepare(`SELECT * FROM events WHERE job_id=? AND type='session.created'`).get(jobId);
    assert.ok(created);
    assert.equal(JSON.parse(created.payload_json).sessionId, session.session_id);

    const updated = runtime.api.updateAgentSession(session.session_id, { state: 'ACTIVE', currentTurnId: 'turn-1' });
    assert.equal(updated.state, 'ACTIVE');
    assert.equal(updated.current_turn_id, 'turn-1');
    assert.equal(database.prepare(`SELECT COUNT(*) AS n FROM events WHERE job_id=? AND type='session.state_changed'`).get(jobId).n, 1);

    const grant = runtime.api.grantSessionAccess(session.session_id, {
      accessorRole: 'architect', permission: 'MESSAGE', grantedBy: 'cto'
    });
    assert.ok(grant.access_id);
    assert.equal(runtime.api.hasSessionPermission(session.session_id, 'architect', 'MESSAGE'), true);
    assert.equal(runtime.api.hasSessionPermission(session.session_id, 'architect', 'TAKEOVER'), false);
    assert.equal(runtime.api.hasSessionPermission(session.session_id, 'cto', 'TAKEOVER'), false);
    assert.equal(runtime.api.listSessionAccess(session.session_id).length, 1);

    const revoked = runtime.api.revokeSessionAccess(grant.access_id, { actor: 'cto' });
    assert.ok(revoked.revoked_at);
    assert.equal(runtime.api.hasSessionPermission(session.session_id, 'architect', 'MESSAGE'), false);
    assert.equal(database.prepare(`SELECT COUNT(*) AS n FROM events WHERE job_id=? AND type='session.access_revoked'`).get(jobId).n, 1);
    assert.equal(database.prepare('PRAGMA foreign_key_check').all().length, 0);
  });
});

test('Session creation rolls back its row and Workflow event when event append fails', async () => {
  await withHost(async ({ database, workflowPort, taskId }) => {
    const runtime = createAgentSessionRuntime({
      database,
      workflowPort: createAgentSessionWorkflowPort({
        ...Object.fromEntries(AGENT_SESSION_WORKFLOW_PORT_METHODS.map(method => [method, workflowPort[method]])),
        recordEvent() { throw new Error('injected Workflow event failure'); }
      })
    });
    assert.throws(() => runtime.api.createAgentSession(taskId, {
      sessionKey: 'agent:cto:subagent:rollback', role: 'cto'
    }), /injected Workflow event failure/);
    assert.equal(database.prepare('SELECT COUNT(*) AS n FROM agent_sessions').get().n, 0);
    assert.equal(database.prepare("SELECT COUNT(*) AS n FROM events WHERE type='session.created'").get().n, 0);
  });
});

test('OpenClaw session key idempotency binds exact task, job, role and parent', async () => {
  await withHost(async ({ runtime, taskId }) => {
    const first = runtime.api.createAgentSession(taskId, {
      sessionKey: 'agent:cto:subagent:identity', role: 'cto', parentSessionKey: 'agent:cto:parent'
    });
    const retry = runtime.api.createAgentSession(taskId, {
      sessionKey: 'agent:cto:subagent:identity', role: 'cto', parentSessionKey: 'agent:cto:parent'
    });
    assert.equal(retry.session_id, first.session_id);
    assert.throws(() => runtime.api.createAgentSession(taskId, {
      sessionKey: 'agent:cto:subagent:identity', role: 'architect', parentSessionKey: 'agent:cto:parent'
    }), /already bound to a different task\/session identity/);
    assert.throws(() => runtime.api.createAgentSession(taskId, {
      sessionKey: 'agent:cto:subagent:identity', role: 'cto', parentSessionKey: 'agent:other-parent'
    }), /already bound to a different task\/session identity/);
    assert.equal(runtime.api.listAgentSessions({ taskId }).length, 1);
  });
});

test('Session access requires explicit actor and canonical expiry; malformed persisted expiry fails closed', async () => {
  await withHost(async ({ database, runtime, taskId }) => {
    const session = runtime.api.createAgentSession(taskId, { sessionKey: 'agent:cto:subagent:acl', role: 'cto' });
    assert.throws(() => runtime.api.grantSessionAccess(session.session_id, {
      accessorRole: 'architect', permission: 'TAKEOVER'
    }), /grantedBy must be a non-empty string/);
    assert.throws(() => runtime.api.grantSessionAccess(session.session_id, {
      accessorRole: 'architect', permission: 'MESSAGE', grantedBy: 'cto', expiresAt: 'not-a-date'
    }), /canonical UTC timestamp/);
    const grant = runtime.api.grantSessionAccess(session.session_id, {
      accessorRole: 'architect', permission: 'TAKEOVER', grantedBy: 'cto'
    });
    assert.equal(runtime.api.hasSessionPermission(session.session_id, 'architect', 'TAKEOVER'), true);
    database.prepare('UPDATE session_access SET expires_at=? WHERE access_id=?').run('zzzz-invalid-expiry', grant.access_id);
    assert.equal(runtime.api.hasSessionPermission(session.session_id, 'architect', 'TAKEOVER'), false);
    assert.equal(runtime.api.hasSessionPermission(session.session_id, 'architect', 'TAKEOVER', { at: 'not-a-time' }), false);
  });
});

test('Queue insertion is idempotent by exact payload and commits the Workflow queue event atomically', async () => {
  await withHost(async ({ database, runtime, taskId, jobId }) => {
    const session = runtime.api.createAgentSession(taskId, { sessionKey: 'agent:cto:subagent:queue', role: 'cto' });
    runtime.api.grantSessionAccess(session.session_id, { accessorRole: 'architect', permission: 'MESSAGE', grantedBy: 'cto' });
    const input = {
      senderRole: 'cto', recipientRole: 'architect', payload: { instruction: 'review this' }, dedupeKey: 'queue-1'
    };
    const first = runtime.api.enqueueSessionMessage(session.session_id, input);
    const retry = runtime.api.enqueueSessionMessage(session.session_id, input);
    assert.equal(first.message_id, retry.message_id);
    assert.equal(retry.status, 'QUEUED');
    assert.equal(JSON.parse(retry.payload_json).instruction, 'review this');
    assert.equal(database.prepare("SELECT COUNT(*) AS n FROM events WHERE job_id=? AND type='session.message_queued'").get(jobId).n, 1);
    assert.throws(() => runtime.api.enqueueSessionMessage(session.session_id, {
      ...input, payload: { instruction: 'different content' }
    }), /dedupe key conflicts/);
  });
});

test('Queue row rolls back when Workflow event append fails', async () => {
  await withHost(async ({ database, workflowPort, taskId }) => {
    const sessionStore = createAgentSessionRuntime({ database, workflowPort }).api;
    const session = sessionStore.createAgentSession(taskId, { sessionKey: 'agent:cto:subagent:queue-rollback', role: 'cto' });
    const grant = sessionStore.grantSessionAccess(session.session_id, { accessorRole: 'architect', permission: 'MESSAGE', grantedBy: 'cto' });
    assert.ok(grant);
    const failingRuntime = createAgentSessionRuntime({
      database,
      workflowPort: createAgentSessionWorkflowPort({
        ...Object.fromEntries(AGENT_SESSION_WORKFLOW_PORT_METHODS.map(method => [method, workflowPort[method]])),
        recordEvent(jobId, type, payload, dedupeKey) {
          if (type === 'session.message_queued') throw new Error('injected queue event failure');
          return workflowPort.recordEvent(jobId, type, payload, dedupeKey);
        }
      })
    });
    assert.throws(() => failingRuntime.api.enqueueSessionMessage(session.session_id, {
      senderRole: 'cto', recipientRole: 'architect', payload: { value: 1 }, dedupeKey: 'queue-rollback'
    }), /injected queue event failure/);
    assert.equal(database.prepare('SELECT COUNT(*) AS n FROM session_messages').get().n, 0);
    assert.equal(database.prepare("SELECT COUNT(*) AS n FROM events WHERE type='session.message_queued'").get().n, 0);
  });
});

test('Message claim uses one durable attempt and an exact Workflow event; active duplicate claim is denied', async () => {
  await withHost(async ({ database, runtime, taskId, jobId }) => {
    const session = runtime.api.createAgentSession(taskId, { sessionKey: 'agent:cto:subagent:claim', role: 'cto' });
    runtime.api.grantSessionAccess(session.session_id, { accessorRole: 'architect', permission: 'MESSAGE', grantedBy: 'cto' });
    const message = runtime.api.enqueueSessionMessage(session.session_id, {
      senderRole: 'cto', recipientRole: 'architect', payload: { command: 'inspect' }, dedupeKey: 'claim-1'
    });
    const claim = runtime.api.claimSessionMessage(message.message_id, { recipientRole: 'architect', leaseMs: 30000 });
    assert.equal(claim.status, 'DELIVERED');
    assert.equal(claim.attempt, 1);
    assert.equal(claim.claimAcquired, true);
    const duplicate = runtime.api.claimSessionMessage(message.message_id, { recipientRole: 'architect', leaseMs: 30000 });
    assert.equal(duplicate.claimAcquired, false);
    assert.equal(duplicate.attempt, 1);
    assert.equal(database.prepare("SELECT COUNT(*) AS n FROM events WHERE job_id=? AND type='session.message_delivered'").get(jobId).n, 1);
  });
});

test('Successful managed delivery requires start intent, correlated receipt and durable ACK', async () => {
  await withHost(async ({ database, runtime, taskId, jobId }) => {
    const session = runtime.api.createAgentSession(taskId, { sessionKey: 'agent:cto:subagent:delivery-ok', role: 'cto' });
    runtime.api.grantSessionAccess(session.session_id, { accessorRole: 'architect', permission: 'MESSAGE', grantedBy: 'cto' });
    const message = runtime.api.enqueueSessionMessage(session.session_id, {
      senderRole: 'cto', recipientRole: 'architect', payload: { command: 'run' }, dedupeKey: 'delivery-ok'
    });
    let calls = 0;
    const result = await runtime.api.deliverNextSessionMessage(session.session_id, {
      recipientRole: 'architect',
      transport: async (_session, claimed, context) => {
        calls++;
        assert.equal(claimed.message_id, message.message_id);
        assert.equal(context.idempotencyKey, message.message_id);
        return { status: 'OK', runId: 'openclaw-run-success-1', sessionKey: session.openclaw_session_key, result: 'accepted' };
      },
      deliveryOptions: { timeoutSeconds: 1 }
    });
    assert.equal(calls, 1);
    assert.equal(result.status, 'ACKED');
    assert.equal(runtime.api.getSessionMessage(message.message_id).status, 'ACKED');
    assert.equal(database.prepare("SELECT COUNT(*) AS n FROM events WHERE job_id=? AND type='session.message_delivery_started'").get(jobId).n, 1);
    assert.equal(database.prepare("SELECT COUNT(*) AS n FROM events WHERE job_id=? AND type='session.message_receipt' AND json_extract(payload_json,'$.status')='OK'").get(jobId).n, 1);
    assert.equal(database.prepare("SELECT COUNT(*) AS n FROM events WHERE job_id=? AND type='session.message_acked'").get(jobId).n, 1);
  });
});

test('Ambiguous transport failure is quarantined and never automatically replayed', async () => {
  await withHost(async ({ runtime, taskId }) => {
    const session = runtime.api.createAgentSession(taskId, { sessionKey: 'agent:cto:subagent:delivery-unknown', role: 'cto' });
    runtime.api.grantSessionAccess(session.session_id, { accessorRole: 'architect', permission: 'MESSAGE', grantedBy: 'cto' });
    const message = runtime.api.enqueueSessionMessage(session.session_id, {
      senderRole: 'cto', recipientRole: 'architect', payload: { command: 'maybe-sent' }, dedupeKey: 'delivery-unknown'
    });
    let calls = 0;
    const result = await runtime.api.deliverNextSessionMessage(session.session_id, {
      recipientRole: 'architect',
      transport: async () => {
        calls++;
        const error = new Error('remote timed out after send');
        error.code = 'ETIMEDOUT';
        throw error;
      },
      deliveryOptions: { timeoutSeconds: 1 }
    });
    assert.equal(result.status, 'FAILED');
    assert.match(result.last_error, /^DELIVERY_UNCERTAIN:/);
    assert.equal(runtime.api.claimSessionMessage(message.message_id, { recipientRole: 'architect' }).claimAcquired, false);
    assert.equal(runtime.api.retrySessionMessage(message.message_id, { error: 'do not replay ambiguous send' }).status, 'FAILED');
    assert.equal(calls, 1);
  });
});

test('Lifecycle participant locks/updates/terminalizes sessions without leaking into public API', async () => {
  await withHost(async ({ runtime, taskId, jobId }) => {
    const session = runtime.api.createAgentSession(taskId, { sessionKey: 'agent:cto:subagent:lifecycle', role: 'cto', state: 'ACTIVE' });
    const changed = runtime.lifecycleParticipant.updateRetryAttempt(session.session_id, 2, new Date().toISOString());
    assert.equal(changed.changes, 1);
    assert.equal(runtime.api.getSession(session.session_id).attempt, 2);
    const locked = runtime.lifecycleParticipant.lockSession(session.session_id);
    assert.equal(locked.changes, 1);
    const terminal = runtime.lifecycleParticipant.terminateSessionsForTask(taskId, 'TERMINATED', new Date().toISOString());
    assert.equal(terminal.changes, 1);
    assert.equal(runtime.api.getSession(session.session_id).state, 'TERMINATED');
    assert.equal(runtime.api.listActiveAgentSessionsForJob(jobId).length, 0);
    assert.throws(() => runtime.lifecycleParticipant.terminateSessionsForTask(taskId, 'ACTIVE', new Date().toISOString()), /terminal agent session state/);
  });
});


test('ACK refuses a claimed message without an exact transport-start intent and success receipt', async () => {
  await withHost(async ({ runtime, taskId }) => {
    const session = runtime.api.createAgentSession(taskId, { sessionKey: 'agent:cto:subagent:ack-fence', role: 'cto' });
    runtime.api.grantSessionAccess(session.session_id, { accessorRole: 'architect', permission: 'MESSAGE', grantedBy: 'cto' });
    const message = runtime.api.enqueueSessionMessage(session.session_id, {
      senderRole: 'cto', recipientRole: 'architect', payload: { command: 'do not ack unreceipted' }, dedupeKey: 'ack-fence'
    });
    const claimed = runtime.api.claimSessionMessage(message.message_id, { recipientRole: 'architect', leaseMs: 30000 });
    assert.equal(claimed.status, 'DELIVERED');
    assert.throws(() => runtime.api.ackSessionMessage(message.message_id, {
      recipientRole: 'architect', expectedAttempt: claimed.attempt, expectedLeaseUntil: claimed.lease_until
    }), /transport-start lineage|successful receipt/);
    assert.equal(runtime.api.getSessionMessage(message.message_id).status, 'DELIVERED');
  });
});

test('Agent Runtime source owns only Agent Session tables and imports external contracts through public packages', () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const store = fs.readFileSync(path.join(root, 'src/runtime/agent-session-store.js'), 'utf8');
  const policy = fs.readFileSync(path.join(root, 'src/runtime/agent-session-policy.js'), 'utf8');
  const runtime = fs.readFileSync(path.join(root, 'src/runtime/agent-session-runtime.js'), 'utf8');
  assert.match(store, /CREATE TABLE IF NOT EXISTS agent_sessions/);
  assert.match(store, /CREATE TABLE IF NOT EXISTS session_access/);
  assert.match(store, /CREATE TABLE IF NOT EXISTS session_messages/);
  assert.doesNotMatch(store, /CREATE TABLE IF NOT EXISTS (?:jobs|tasks|events)/);
  assert.doesNotMatch(store, /(?:FROM|UPDATE|INTO|JOIN)\s+(?:jobs|tasks|events|attempts|task_leases)\b/i);
  assert.match(store, /@runalith\/cos-ap/);
  assert.match(store, /@runalith\/workflow-contracts/);
  assert.match(policy, /@runalith\/agent-contracts/);
  assert.doesNotMatch(store, /WorkflowStore|workflow-state-port\.js|runalith-runtime-composition/);
  assert.match(runtime, /assertSharedConnection\(database\)/);
  assert.match(runtime, /createAgentSessionLifecycleParticipant/);
  assert.match(runtime, /createAgentSessionApi/);
});
