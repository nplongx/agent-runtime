#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-runtime-packed-consumer-'));
const consumerRoot = path.join(temporaryRoot, 'consumer');
const environment = {
  ...process.env,
  NODE_NO_WARNINGS: '1',
  npm_config_update_notifier: 'false',
  npm_config_fund: 'false',
  npm_config_audit: 'false'
};

function run(command, args, cwd, label) {
  const result = spawnSync(command, args, {
    cwd,
    env: environment,
    encoding: 'utf8',
    timeout: 180000,
    maxBuffer: 8 * 1024 * 1024
  });
  if (result.error || result.status !== 0) {
    throw new Error(label + ' failed (status=' + result.status + ', signal=' + result.signal + '):\n' +
      (result.stdout || '') + '\n' + (result.stderr || '') + '\n' + (result.error?.message || ''));
  }
  return result.stdout.trim();
}

try {
  fs.mkdirSync(consumerRoot, { mode: 0o700 });
  const packed = JSON.parse(run('npm', ['pack', '--json', '--pack-destination', temporaryRoot], ROOT, 'npm pack'));
  assert.equal(packed.length, 1);
  assert.equal(packed[0].name, '@runalith/agent-runtime');
  assert.equal(packed[0].version, '0.2.0');
  const tarball = path.join(temporaryRoot, packed[0].filename);
  assert.ok(fs.statSync(tarball).size > 10000);
  run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--prefix', consumerRoot, tarball],
    ROOT, 'install packed Agent Runtime into clean consumer');

  const smoke = [
    "import assert from 'node:assert/strict';",
    "import crypto from 'node:crypto';",
    "import fs from 'node:fs';",
    "import os from 'node:os';",
    "import path from 'node:path';",
    "import { DatabaseSync } from 'node:sqlite';",
    "import * as api from '@runalith/agent-runtime';",
    "import { loadAgentSkills } from '@runalith/agent-runtime/skills';",
    "assert.equal(api.AGENT_SESSION_RUNTIME_VERSION, 1);",
    "assert.equal(api.AGENT_SESSION_API_VERSION, 1);",
    "assert.equal(api.AGENT_SESSION_WORKFLOW_PORT_VERSION, 1);",
    "assert.equal(api.AGENT_SESSION_DELIVERY_PORT_VERSION, 1);",
    "assert.equal(typeof api.createAgentSessionDeliveryPort, 'function');",
    "assert.equal(typeof api.createAgentSessionRuntime, 'function');",
    "assert.equal(typeof api.createAgentSessionWorkflowPort, 'function');",
    "const skillRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-runtime-skill-consumer-'));",
    "const skillDirectory = path.join(skillRoot, 'consumer-skill');",
    "fs.mkdirSync(skillDirectory, { recursive: true });",
    "fs.writeFileSync(path.join(skillDirectory, 'SKILL.md'), '---\\nname: consumer-skill\\ndescription: Packed skill consumer smoke.\\n---\\n\\nKeep imported content inert.\\n');",
    "const bundles = await loadAgentSkills(['consumer-skill'], { workspaceRoot: skillRoot });",
    "assert.equal(bundles.length, 1);",
    "assert.equal(bundles[0].name, 'consumer-skill');",
    "assert.match(bundles[0].sha256, /^[a-f0-9]{64}$/);",
    "fs.rmSync(skillRoot, { recursive: true, force: true });",
    "const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-runtime-consumer-smoke-'));",
    "const databasePath = path.join(root, 'workflow.db');",
    "const database = new DatabaseSync(databasePath);",
    "database.exec('PRAGMA foreign_keys=ON; CREATE TABLE jobs(job_id TEXT PRIMARY KEY); CREATE TABLE tasks(task_id TEXT PRIMARY KEY,job_id TEXT REFERENCES jobs(job_id),role TEXT,status TEXT,openclaw_session_key TEXT,created_at TEXT,updated_at TEXT); CREATE TABLE events(event_id TEXT PRIMARY KEY,job_id TEXT,type TEXT,payload_json TEXT,created_at TEXT);');",
    "const now = new Date().toISOString();",
    "database.prepare('INSERT INTO jobs(job_id) VALUES(?)').run('job_consumer');",
    "database.prepare('INSERT INTO tasks(task_id,job_id,role,status,created_at,updated_at) VALUES(?,?,?,?,?,?)').run('task_consumer','job_consumer','cto','running',now,now);",
    "const hash = value => crypto.createHash('sha256').update(value).digest('hex');",
    "const eventId = (jobId,type,key='') => hash(jobId+'|'+type+'|'+key);",
    "const workflowPort = api.createAgentSessionWorkflowPort({",
    "  assertSharedConnection: connection => connection === database,",
    "  getTask: taskId => database.prepare('SELECT * FROM tasks WHERE task_id=?').get(taskId) || null,",
    "  lockTaskForAgentSession: taskId => database.prepare('UPDATE tasks SET updated_at=updated_at WHERE task_id=?').run(taskId),",
    "  recordEvent(jobId,type,payload,key='') { const id=eventId(jobId,type,key); database.prepare('INSERT OR IGNORE INTO events(event_id,job_id,type,payload_json,created_at) VALUES(?,?,?,?,?)').run(id,jobId,type,JSON.stringify(payload),new Date().toISOString()); return id; },",
    "  getEvent: id => database.prepare('SELECT * FROM events WHERE event_id=?').get(id) || null,",
    "  listEventsForJob(jobId,{type=null,limit=50000}={}) { return type ? database.prepare('SELECT * FROM events WHERE job_id=? AND type=? ORDER BY created_at,rowid LIMIT ?').all(jobId,type,limit) : database.prepare('SELECT * FROM events WHERE job_id=? ORDER BY created_at,rowid LIMIT ?').all(jobId,limit); },",
    "  countEventsForJobType: (jobId,type) => database.prepare('SELECT COUNT(*) AS n FROM events WHERE job_id=? AND type=?').get(jobId,type).n,",
    "  listTasksWithOpenClawSession: () => database.prepare(\"SELECT task_id,job_id,role,status,openclaw_session_key,created_at,updated_at FROM tasks WHERE openclaw_session_key IS NOT NULL AND openclaw_session_key<>''\").all()",
    "});",
    "const runtime = api.createAgentSessionRuntime({ database, workflowPort });",
    "assert.equal(Object.isFrozen(runtime), true);",
    "const session = runtime.api.createAgentSession('task_consumer',{sessionKey:'agent:cto:consumer',role:'cto'});",
    "runtime.api.grantSessionAccess(session.session_id,{accessorRole:'architect',permission:'MESSAGE',grantedBy:'cto'});",
    "const message = runtime.api.enqueueSessionMessage(session.session_id,{senderRole:'cto',recipientRole:'architect',payload:{text:'hello'},dedupeKey:'consumer-message'});",
    "const delivery = await runtime.api.deliverNextSessionMessage(session.session_id,{recipientRole:'architect',transport:async () => ({status:'OK',runId:'consumer-run-1',sessionKey:session.openclaw_session_key,result:'accepted'}),deliveryOptions:{timeoutSeconds:1}});",
    "assert.equal(delivery.status,'ACKED');",
    "assert.equal(runtime.api.getSessionMessage(message.message_id).status,'ACKED');",
    "for (const table of ['agent_sessions','session_access','session_messages']) assert.equal(database.prepare('SELECT 1 AS found FROM sqlite_master WHERE type=? AND name=?').get('table',table)?.found,1);",
    "assert.equal(database.prepare('PRAGMA foreign_key_check').all().length,0);",
    "database.close();",
    "fs.rmSync(root,{recursive:true,force:true});",
    "console.log('packed consumer public API, pinned contracts and Agent Session delivery lifecycle PASS');"
  ].join('\n');

  run(process.execPath, ['--input-type=module', '-e', smoke], consumerRoot, 'packed consumer API smoke');
  console.log('Agent Runtime packed consumer PASS: ' + packed[0].filename +
    ' (' + packed[0].entryCount + ' package files, ' + packed[0].size + ' bytes)');
} finally {
  fs.rmSync(temporaryRoot, { recursive: true, force: true });
}
