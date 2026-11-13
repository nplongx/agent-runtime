# Agent Runtime

[![CI](https://github.com/nplongx/agent-runtime/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/nplongx/agent-runtime/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

**@runalith/agent-runtime** is a Node.js ESM library for durable Agent Session state, bounded Agent Skills ingestion, and immutable specialist role guidance. Session APIs provide lifecycle, role-based access grants, and an inter-agent message queue with delivery leases, receipts, retries, and uncertain-outcome quarantine. Separate `./skills` and `./specialist-guidance` subpaths provide bounded text-only skill bundles and static built-in role prompt data.

This is a host-composed persistence/runtime component, not an agent scheduler, identity provider, OpenClaw transport, MCP server, or independent database service. Workflow host remains authority for task identity, role/task state, event history, authentication, and external delivery.

> **Status:** 0.3.0, GitHub-first source package. Not published to npm. Public API and schema compatibility remain pre-1.0.

## Scope

- Durable Agent Session registry with job/task binding, OpenClaw session keys, parent links, lifecycle state, current turn, attempt, and heartbeat.
- Session grants for OBSERVE, MESSAGE, EXECUTE, and TAKEOVER, with explicit grant/revoke actor, expiry, and audit events.
- COS-AP v1 envelopes, bounded JSON payloads, correlation IDs, per-session deduplication keys, and inbox ordering.
- Atomic queue insertion plus Workflow event append on shared SQLite connection.
- Single-owner message claims using SQLite writer reservation and compare-and-set attempt/lease updates.
- Durable transport-start intent, correlated success receipts, ACK validation, and restart recovery.
- Explicit DELIVERY_UNCERTAIN quarantine after possible external side effect; ambiguous messages are not automatically replayed.
- Separate public Agent Session API v1, Workflow lifecycle participant v1, and optional host Delivery Port v1 that preserves compatibility/fault-injection hooks.
- Separate `@runalith/agent-runtime/skills` entrypoint for bounded local/GitHub text-file ingestion, SKILL.md frontmatter validation, and content hashing.
- Separate `@runalith/agent-runtime/specialist-guidance` entrypoint for immutable built-in specialist role prompt strings; it does not coordinate Workflow state.

## Non-goals

This package does not authenticate users or agents, create/approve Workflow tasks, define business roles, run agents, create OpenClaw sessions, provide a message broker, or prove remote work completed. The `./skills` subpath makes HTTPS requests only to public GitHub APIs/raw content and reads explicitly supplied local skill paths; imported files are returned as text and never executed. Host remains responsible for deciding whether imported skill content is trusted or may be supplied to an agent.

## Requirements and dependencies

- Node.js >=22.13.0 (node:sqlite).
- Host-owned SQLite connection shared with Workflow.
- Host adapter implementing Agent Session Workflow Port v1.
- Three pinned public GitHub contracts: @runalith/agent-contracts, @runalith/cos-ap, and @runalith/workflow-contracts.

Dependencies are pinned to immutable GitHub commit tarballs in package.json and package-lock.json. No SSH key required. No other third-party runtime dependency.

## Agent Skills subpath

~~~js
import { loadAgentSkills, MAX_SKILLS_PER_ROLE } from '@runalith/agent-runtime/skills';

const skills = await loadAgentSkills(['skills/code-review', 'https://github.com/example-org/skills/tree/main/research'], {
  workspaceRoot: process.env.WORKFLOW_WORKSPACE,
});
~~~

See [Agent Skills ingestion](docs/skills.md) for source restrictions, size limits, return shape, and security assumptions. This subpath is independent of Agent Session persistence and does not import or initialize SQLite.

## Specialist guidance subpath

~~~js
import { getSpecialistRoleGuidance, SPECIALIST_GUIDANCE_ROLES } from '@runalith/agent-runtime/specialist-guidance';

const roles = SPECIALIST_GUIDANCE_ROLES;
const engineerGuidance = getSpecialistRoleGuidance('engineer');
~~~

See [Specialist guidance](docs/specialist-guidance.md). This subpath returns immutable built-in role guidance strings only. The host still owns role assignment, Workflow task contracts, tool registration, approvals, and coordinator execution.

## Install

~~~sh
npm install github:nplongx/agent-runtime
~~~

## Quick start

Host supplies its existing Workflow database and a small adapter over authoritative Workflow API:

~~~js
import {
  createAgentSessionRuntime,
  createAgentSessionWorkflowPort,
  createAgentSessionDeliveryPort,
} from '@runalith/agent-runtime';

const database = workflowDatabase; // exact connection already used by Workflow

const workflowPort = createAgentSessionWorkflowPort({
  assertSharedConnection(connection) {
    return connection === database;
  },
  getTask: taskId => workflowStore.getTask(taskId),
  lockTaskForAgentSession: taskId => workflowStore.lockTaskForAgentSession(taskId),
  recordEvent: (...args) => workflowStore.recordEvent(...args),
  getEvent: eventId => workflowStore.getEvent(eventId),
  listEventsForJob: (jobId, options) => workflowStore.listEventsForJob(jobId, options),
  countEventsForJobType: (jobId, type) => workflowStore.countEventsForJobType(jobId, type),
  listTasksWithOpenClawSession: () => workflowStore.listTasksWithOpenClawSession(),
});

// Optional: retain the host's current facade/fault-injection seam for
// receipt, ACK, retry and uncertain-outcome transitions.
const deliveryHooks = createAgentSessionDeliveryPort({
  ackSessionMessage: (...args) => workflowStore.ackSessionMessage(...args),
  markSessionMessageDeliveryUncertain: (...args) => workflowStore.markSessionMessageDeliveryUncertain(...args),
  retrySessionMessage: (...args) => workflowStore.retrySessionMessage(...args),
  recordSessionDeliveryReceipt: (...args) => workflowStore.recordSessionDeliveryReceipt(...args),
});

const { api: agentSessions, lifecycleParticipant } =
  createAgentSessionRuntime({ database, workflowPort, deliveryHooks });

const session = agentSessions.createAgentSession(taskId, {
  sessionKey: 'agent:architect:subagent:design',
  role: 'architect',
});

agentSessions.grantSessionAccess(session.session_id, {
  accessorRole: 'qa',
  permission: 'MESSAGE',
  grantedBy: 'cto',
});

const queued = agentSessions.enqueueSessionMessage(session.session_id, {
  senderRole: 'architect',
  recipientRole: 'qa',
  payload: { instruction: 'Review design artifact.' },
  dedupeKey: 'design-review-v1',
});

const result = await agentSessions.deliverNextSessionMessage(session.session_id, {
  recipientRole: 'qa',
  transport: async (agentSession, message, context) =>
    openClawTransport.send(agentSession, message, context),
  deliveryOptions: { timeoutSeconds: 60 },
});
~~~

The adapter methods delegate to the host's existing Workflow implementation. workflowStore, taskId, workflowDatabase, and openClawTransport are host-owned values, not package exports.

assertSharedConnection(database) must return true only when the exact SQLite object is the same connection Workflow uses. Separate handles to the same file are not sufficient.

## Port ownership

### Agent Session Workflow Port v1

Host supplies these methods:

- assertSharedConnection(database)
- getTask(taskId)
- lockTaskForAgentSession(taskId)
- recordEvent(jobId, type, payload, dedupeKey)
- getEvent(eventId)
- listEventsForJob(jobId, options)
- countEventsForJobType(jobId, type)
- listTasksWithOpenClawSession()

The port is frozen and exposes only these named methods. It has no database handle, generic SQL, or transaction callback. Workflow task and event state is accessed only through this port.

### Agent Session API v1

createAgentSessionRuntime() returns a frozen api with the method list exported as AGENT_SESSION_API_METHODS. It covers session lifecycle, ACL, message enqueue/read/claim/delivery, durable receipt/ACK, recovery, and trace queries.

### Lifecycle Participant v1

A separate frozen participant exposes only:

- lockSession(sessionId)
- updateRetryAttempt(sessionId, nextAttempt, timestamp)
- terminateSessionsForTask(taskId, state, timestamp)

These hooks let Workflow include Agent Session changes in its own transactions. They are not part of the public Agent Session domain API.

Without `deliveryHooks`, runtime wires the four callbacks back to the same internal AgentSessionStore. A host may instead supply frozen Delivery Port v1 to preserve existing compatibility facades, fault injection and observability. The four methods cannot expose raw database handles or transaction controls. This port is a trusted in-process integration seam, not external transport authority.

## Session access semantics

A session owner has implicit OBSERVE, MESSAGE, and EXECUTE. TAKEOVER is never implicit. Takeover requires explicit active grant and session state PAUSED, STALE, or FAILED.

Grant and revoke require explicit actor identity. Host must authenticate that actor and authorize the operation before calling the API. Role names are validated against @runalith/agent-contracts; this validation does not authenticate the actor.

Expiry must be canonical UTC timestamp. Malformed durable expiry and malformed evaluation times fail closed.

## Message lifecycle and delivery guarantees

1. enqueueSessionMessage() validates/detaches JSON payload, checks sender permission, persists one QUEUED row, appends deterministic session.message_queued Workflow event, and performs exact readback in one SQLite savepoint.
2. claimSessionMessage() takes writer reservation before rechecking state/permission, increments attempt once, assigns lease, appends session.message_delivered, and verifies row/event lineage.
3. deliverSessionMessage() persists session.message_delivery_started before invoking host transport. Message ID is idempotency key.
4. Successful transport result must include correlated non-empty runId. Exact receipt is persisted before ACK.
5. ACK validates one exact start event and one successful receipt bound to same message, attempt, session, and run.
6. Timeout, disconnect, malformed/non-success receipt, or persistence failure after send boundary is treated as potentially external. Message is marked FAILED with DELIVERY_UNCERTAIN: reason and is not automatically replayed.
7. On lease expiry, recovery retries only when no transport-start event proves send boundary crossed. If start exists without valid durable success receipt, outcome remains uncertain.

DELIVERED means claimed under a live lease; it does not prove remote delivery. ACKED requires durable correlated success evidence.

## Database ownership and transaction model

Agent Runtime owns exactly three tables: agent_sessions, session_access, and session_messages.

Their foreign keys reference host-owned jobs and tasks. Workflow events are not created or written directly by Agent Runtime; they are appended/read through Workflow Port v1.

Host must initialize jobs, tasks, and events first, enable SQLite foreign keys, and supply exact same connection used by Workflow. Agent tables, Workflow events, and host lifecycle transitions intentionally share one transaction unit.

This extraction does not create an independent database, process, broker, or transaction coordinator. Keep records on Workflow SQLite connection to preserve atomic row/event operations.

During initialization, legacy tasks that already carry an OpenClaw session key are best-effort backfilled into agent_sessions. This does not create or resume an external runtime. Review any backfill warning in host logs.

## Development and validation

~~~sh
npm ci
npm run check
npm run test:packed-consumer
npm run pack:check
~~~

Tests cover API/port boundaries, schema ownership, exact shared-connection checks, session/ACL lifecycle, canonical expiry, queue idempotency, rollback on event failure, lease/attempt fencing, two-process claim races, receipt/ACK requirements, and ambiguous transport quarantine.

GitHub Actions runs Node.js 22 and 24 on Ubuntu. Tests use local SQLite fixtures and mock transport; they do not contact OpenClaw or deploy a production agent runtime.

## Documentation

- [Documentation index](docs/README.md)
- [Architecture and ownership](docs/architecture.md)
- [Host integration and SQLite schema](docs/integration.md)
- [Terminology](docs/terminology.md)
- [Source lineage and pinned dependencies](docs/source-lineage.md)
- [Security policy](SECURITY.md)
- [Changelog](CHANGELOG.md)

## License

MIT. See LICENSE.
