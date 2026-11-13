# Host integration and SQLite schema

## Host responsibilities

The host must:
- authenticate the caller and authorize Agent Session operations;
- own Workflow job/task/event schema and semantics;
- initialize the parent jobs, tasks, and events tables before composing Agent Runtime;
- supply a Workflow Port v1 backed by the authoritative Workflow API;
- use the exact same SQLite connection object for Workflow and Agent Runtime;
- own OpenClaw/provider credentials, transport, endpoint identity and external runtime lifecycle;
- call lifecycle participant methods from the appropriate Workflow transaction;
- run delivery reconciliation at startup and after worker interruptions.

## Compose the runtime

~~~js
import { createAgentSessionRuntime, createAgentSessionWorkflowPort } from '@runalith/agent-runtime';

const workflowPort = createAgentSessionWorkflowPort({
  assertSharedConnection: database => database === workflowStore.db,
  getTask: taskId => workflowStore.getTask(taskId),
  lockTaskForAgentSession: taskId => workflowStore.lockTaskForAgentSession(taskId),
  recordEvent: (...args) => workflowStore.recordEvent(...args),
  getEvent: eventId => workflowStore.getEvent(eventId),
  listEventsForJob: (jobId, options) => workflowStore.listEventsForJob(jobId, options),
  countEventsForJobType: (jobId, type) => workflowStore.countEventsForJobType(jobId, type),
  listTasksWithOpenClawSession: () => workflowStore.listTasksWithOpenClawSession(),
});

const runtime = createAgentSessionRuntime({ database: workflowStore.db, workflowPort });
const { api, lifecycleParticipant } = runtime;
~~~

Each supplied method must be a function. Runtime wraps it in a frozen, versioned allowlist and checks exact SQLite connection. The host adapter must not expose db, database, prepare, exec, or a generic transaction callback.

## Workflow Port v1 methods

| Method | Contract |
|---|---|
| assertSharedConnection(database) | Return true only if database is the exact connection used by Workflow. |
| getTask(taskId) | Return current task row or null. |
| lockTaskForAgentSession(taskId) | Acquire Workflow writer reservation for session creation; return SQLite-style { changes }. |
| recordEvent(jobId,type,payload,dedupeKey) | Append/dedupe Workflow event transactionally and return exact event ID. |
| getEvent(eventId) | Read exact Workflow event row. |
| listEventsForJob(jobId,{type,limit}) | Return canonical event rows, including event_id, job_id, type, payload_json, created_at. |
| countEventsForJobType(jobId,type) | Return total count; Agent Runtime refuses incomplete event scans beyond its bounded limit. |
| listTasksWithOpenClawSession() | Read task rows with existing openclaw_session_key for legacy registry backfill. |

recordEvent must participate in the same connection/transaction context as Agent Runtime changes. Deterministic event IDs follow host Workflow event contract. Do not append a separate Agent-only event journal.

## SQLite schema prerequisites

Before constructing Agent Runtime, host database must have:

- jobs(job_id PRIMARY KEY)
- tasks(task_id PRIMARY KEY, job_id REFERENCES jobs(job_id), ...)
- events(event_id PRIMARY KEY, job_id REFERENCES jobs(job_id), type, payload_json, created_at, ...)

Agent Runtime creates agent_sessions, session_access, and session_messages; it adds missing protocol and protocol_version columns to older session_messages schemas. The migration is idempotent for supported legacy tables.

All Agent Session tables are on host Workflow connection. Enforce foreign keys on that connection. Host owns connection initialization, busy timeout/WAL choice, backup/restore, file permissions, migration ordering and shutdown.

## Lifecycle participant

The returned lifecycleParticipant exposes:

- lockSession(sessionId)
- updateRetryAttempt(sessionId, nextAttempt, timestamp)
- terminateSessionsForTask(taskId, state, timestamp)

Workflow should invoke these methods inside its own task retry/terminalization transaction. The participant has no access to Workflow transaction controls and exposes no raw DB handle; shared connection provides atomic visibility.

Do not expose lifecycle hooks as ordinary Agent Session calls. The public API is separately declared by AGENT_SESSION_API_METHODS.

## Delivery and recovery integration

Host supplies the transport callback to deliverSessionMessage() or deliverNextSessionMessage(). It receives (session, claimedMessage, context), where context.idempotencyKey is message ID and context includes attempt and lease information.

A valid success receipt must return:
- status: 'OK'
- a correlated, non-empty string runId
- the expected sessionKey when using a session-correlated transport response
- any result/payload/raw response host chooses to persist

Transport callback does not run inside a SQLite writer transaction.

The host should call reconcileSessionDelivery() after restart/worker recovery. Runtime may safely requeue only expired delivery attempts with no durable transport-start event. Once that event exists, missing success receipt means unknown external outcome and the message is quarantined. Do not add a force-retry path that bypasses this rule.

## Legacy session-key backfill

On initialization, store queries listTasksWithOpenClawSession() and inserts missing session registry rows for tasks that already contain a session key. It maps task status to a local initial session state and never starts or resumes an external runtime.

Backfill is deliberately best-effort and logs a warning if the Workflow read fails. Host startup should surface this warning and run an explicit reconciliation/inspection before depending on historical session lookups.
