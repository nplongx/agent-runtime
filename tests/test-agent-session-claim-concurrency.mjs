import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { createAgentSessionRuntime, createAgentSessionWorkflowPort } from '../index.js';

const hash = value => createHash('sha256').update(value).digest('hex');
const eventId = (jobId, type, key = '') => hash(`${jobId}|${type}|${key}`);

function hostPort(database) {
  return createAgentSessionWorkflowPort({
    assertSharedConnection: connection => connection === database,
    getTask: taskId => database.prepare('SELECT * FROM tasks WHERE task_id=?').get(taskId) || null,
    lockTaskForAgentSession: taskId => database.prepare('UPDATE tasks SET updated_at=updated_at WHERE task_id=?').run(taskId),
    recordEvent(jobId, type, payload, key = '') {
      const id = eventId(jobId, type, key);
      database.prepare('INSERT OR IGNORE INTO events(event_id,job_id,type,payload_json,created_at) VALUES(?,?,?,?,?)')
        .run(id, jobId, type, JSON.stringify(payload), new Date().toISOString());
      return id;
    },
    getEvent: id => database.prepare('SELECT * FROM events WHERE event_id=?').get(id) || null,
    listEventsForJob(jobId, { type = null, limit = 50000 } = {}) {
      return type
        ? database.prepare('SELECT * FROM events WHERE job_id=? AND type=? ORDER BY created_at,rowid LIMIT ?').all(jobId, type, limit)
        : database.prepare('SELECT * FROM events WHERE job_id=? ORDER BY created_at,rowid LIMIT ?').all(jobId, limit);
    },
    countEventsForJobType: (jobId, type) => database.prepare('SELECT COUNT(*) AS n FROM events WHERE job_id=? AND type=?').get(jobId, type).n,
    listTasksWithOpenClawSession: () => database.prepare(`SELECT task_id,job_id,role,status,openclaw_session_key,created_at,updated_at
      FROM tasks WHERE openclaw_session_key IS NOT NULL AND openclaw_session_key<>''`).all()
  });
}

test('two processes racing one queued Agent Session message acquire exactly one claim', async () => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-session-claim-race-'));
  fs.chmodSync(temporaryRoot, 0o700);
  const databasePath = path.join(temporaryRoot, 'workflow.db');
  const barrier = path.join(temporaryRoot, 'barrier');
  fs.mkdirSync(barrier, { mode: 0o700 });
  const database = new DatabaseSync(databasePath, { timeout: 5000 });
  database.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE jobs(job_id TEXT PRIMARY KEY);
    CREATE TABLE tasks(task_id TEXT PRIMARY KEY,job_id TEXT REFERENCES jobs(job_id),role TEXT,status TEXT,openclaw_session_key TEXT,created_at TEXT,updated_at TEXT);
    CREATE TABLE events(event_id TEXT PRIMARY KEY,job_id TEXT,type TEXT,payload_json TEXT,created_at TEXT);`);
  const timestamp = new Date().toISOString();
  database.prepare('INSERT INTO jobs(job_id) VALUES(?)').run('job_claim-race');
  database.prepare(`INSERT INTO tasks(task_id,job_id,role,status,created_at,updated_at) VALUES(?,?,?,?,?,?)`)
    .run('task_claim-race', 'job_claim-race', 'cto', 'running', timestamp, timestamp);
  const runtime = createAgentSessionRuntime({ database, workflowPort: hostPort(database) });
  const session = runtime.api.createAgentSession('task_claim-race', {
    sessionKey: 'agent:cto:subagent:claim-race', role: 'cto'
  });
  runtime.api.grantSessionAccess(session.session_id, {
    accessorRole: 'architect', permission: 'MESSAGE', grantedBy: 'cto'
  });
  const message = runtime.api.enqueueSessionMessage(session.session_id, {
    senderRole: 'cto', recipientRole: 'architect', payload: { task: 'single claim' }, dedupeKey: 'race-once'
  });

  const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const childSource = `
    import { DatabaseSync } from 'node:sqlite';
    import { createHash } from 'node:crypto';
    import { createAgentSessionRuntime, createAgentSessionWorkflowPort } from ${JSON.stringify(`file://${path.join(packageRoot, 'index.js')}`)};
    const db=new DatabaseSync(${JSON.stringify(databasePath)},{timeout:5000});
    const hash=v=>createHash('sha256').update(v).digest('hex');
    const eid=(j,t,k='')=>hash(j+'|'+t+'|'+k);
    const workflowPort=createAgentSessionWorkflowPort({
      assertSharedConnection:c=>c===db,
      getTask:id=>db.prepare('SELECT * FROM tasks WHERE task_id=?').get(id)||null,
      lockTaskForAgentSession:id=>db.prepare('UPDATE tasks SET updated_at=updated_at WHERE task_id=?').run(id),
      recordEvent(j,t,p,k=''){const id=eid(j,t,k);db.prepare('INSERT OR IGNORE INTO events(event_id,job_id,type,payload_json,created_at) VALUES(?,?,?,?,?)').run(id,j,t,JSON.stringify(p),new Date().toISOString());return id;},
      getEvent:id=>db.prepare('SELECT * FROM events WHERE event_id=?').get(id)||null,
      listEventsForJob(j,{type=null,limit=50000}={}){return type?db.prepare('SELECT * FROM events WHERE job_id=? AND type=? ORDER BY created_at,rowid LIMIT ?').all(j,type,limit):db.prepare('SELECT * FROM events WHERE job_id=? ORDER BY created_at,rowid LIMIT ?').all(j,limit);},
      countEventsForJobType:(j,t)=>db.prepare('SELECT COUNT(*) AS n FROM events WHERE job_id=? AND type=?').get(j,t).n,
      listTasksWithOpenClawSession:()=>db.prepare("SELECT task_id,job_id,role,status,openclaw_session_key,created_at,updated_at FROM tasks WHERE openclaw_session_key IS NOT NULL AND openclaw_session_key<>''").all()
    });
    const runtime=createAgentSessionRuntime({database:db,workflowPort});
    try { const claimed=runtime.api.claimSessionMessage(${JSON.stringify(message.message_id)},{recipientRole:'architect',leaseMs:60000}); console.log(JSON.stringify({claimAcquired:claimed?.claimAcquired===true,status:claimed?.status,attempt:claimed?.attempt})); }
    finally { db.close(); }
  `;
  const children = Array.from({ length: 2 }, () => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', childSource], {
      cwd: packageRoot,
      env: { ...process.env, NODE_ENV: 'test', CHAT_ON_STEROIDS_TEST_SESSION_CLAIM_BARRIER_DIR: barrier },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = ''; let stderr = '';
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', text => { stdout += text; });
    child.stderr.on('data', text => { stderr += text; });
    return { child, done: new Promise(resolve => child.on('close', (code, signal) => resolve({ code, signal, stdout, stderr }))) };
  });
  try {
    const readyPaths = children.map(({ child }) => path.join(barrier, `${child.pid}.ready`));
    const deadline = Date.now() + 15000;
    while (!readyPaths.every(file => fs.existsSync(file))) {
      if (Date.now() > deadline) throw new Error('both Agent Session claim processes did not reach the pre-update barrier');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
    }
    const preconditions = readyPaths.map(file => fs.readFileSync(file, 'utf8'));
    assert.ok(preconditions.every(line => line.includes('|QUEUED|0')), JSON.stringify(preconditions));
    fs.writeFileSync(path.join(barrier, 'release'), 'go\n', { flag: 'wx', mode: 0o600 });
    const outcomes = await Promise.all(children.map(({ done }) => done));
    assert.ok(outcomes.every(value => value.code === 0), JSON.stringify(outcomes));
    const claims = outcomes.map(value => JSON.parse(value.stdout.trim()));
    assert.equal(claims.filter(value => value.claimAcquired).length, 1, JSON.stringify(claims));
    assert.equal(claims.filter(value => !value.claimAcquired).length, 1, JSON.stringify(claims));
    const row = database.prepare('SELECT status,attempt FROM session_messages WHERE message_id=?').get(message.message_id);
    assert.equal(row.status, 'DELIVERED');
    assert.equal(row.attempt, 1);
    assert.equal(database.prepare("SELECT COUNT(*) AS n FROM events WHERE type='session.message_delivered'").get().n, 1);
  } finally {
    for (const { child } of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    database.close();
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
});
