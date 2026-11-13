# Architecture and ownership

## Purpose

@runalith/agent-runtime owns the durable Agent Session registry, session ACLs, and inter-agent message queue. It composes into a host Workflow runtime through one explicit in-process Workflow port and the host's existing SQLite connection.

It is not a network transport, identity provider, scheduler, or agent process manager. The host creates/runs external agents and supplies transport callbacks.

## Component view

~~~mermaid
flowchart TD
  Host[Workflow host] --> DB[Host-owned SQLite connection]
  Host --> WPort[Agent Session Workflow Port v1]
  DB --> Runtime[createAgentSessionRuntime]
  WPort --> Runtime
  Runtime --> Store[AgentSessionStore]
  Store --> Sessions[agent_sessions]
  Store --> ACL[session_access]
  Store --> Queue[session_messages]
  Store --> Events[Workflow event calls through WPort]
  Host --> Transport[Host-owned OpenClaw transport]
  Transport --> Runtime
  Runtime --> API[Agent Session API v1]
  Runtime --> Lifecycle[Lifecycle Participant v1]
  Lifecycle --> Host
~~~

All four persistence categories (three Agent tables and Workflow events) use one SQLite connection. The port is an in-process contract; it is not an RPC or independent service boundary.

## Module map

| Module | Responsibility | Boundary |
|---|---|---|
| index.js | Root exports for runtime composition, API and host port. | Supported package entrypoint. |
| src/runtime/agent-session-runtime.js | Validates host connection identity, creates AgentSessionStore, API and lifecycle participant. | Does not open or close SQLite. |
| src/runtime/agent-session-ports.js | Frozen, versioned Workflow host allowlist. | No DB handle or generic transaction method. |
| src/runtime/agent-session-store.js | Agent Session schema, registry, ACL, queue, leases, message lifecycle, receipts, recovery and event lineage verification. | SQL writes only to Agent-owned tables; Workflow access uses injected port. |
| src/runtime/agent-session-api.js | Public API v1, lifecycle participant v1 and internal delivery hook names. | Domain API and Workflow-only participant are separate. |
| src/runtime/agent-session-policy.js | Role normalization and grant/revoke policy checks. | Uses public Agent Contracts vocabulary; not authentication. |

## Owned schema

| Table | Owner | Purpose |
|---|---|---|
| agent_sessions | Agent Runtime | Session key, job/task binding, role, lifecycle, parent, turn, attempt and activity times. |
| session_access | Agent Runtime | Access grants, permissions, actor, expiry, revoke timestamp. |
| session_messages | Agent Runtime | COS-AP v1 payload, sender/recipient, correlation/dedupe, queue status, attempt, lease, receipt/error projections. |
| jobs, tasks, events | Workflow host | Parent aggregate/task and event journal. Agent Runtime references them via foreign keys and the host port. |

Agent Runtime does not create or migrate jobs, tasks, or events.

## Data flow

1. The host creates createAgentSessionWorkflowPort() from its authoritative Workflow methods.
2. createAgentSessionRuntime() verifies that the port accepts the exact SQLite connection supplied by the host.
3. Agent Runtime initializes its three owned tables and best-effort imports legacy session keys from host tasks.
4. Session/ACL/queue row changes are enclosed in SQLite savepoints and paired with Workflow event appends/readback.
5. The host provides a transport callback. Agent Runtime controls queue claim, attempt, lease, transport-start event, receipt, ACK and uncertainty semantics. The host may optionally inject Delivery Port v1 so package callbacks re-enter the existing host compatibility facade; the standalone default re-enters the same package store.
6. Workflow invokes the separate lifecycle participant when task retries or terminalization must affect Agent Session state in the same connection/transaction.

## Transaction invariants

- The host owns the SQLite connection lifetime and global transaction composition.
- assertSharedConnection(database) must return true only for the exact same connection object Workflow uses.
- The runtime rejects mismatch before initializing Agent Session tables.
- Agent Session row changes and Workflow event appends use that shared connection and local savepoints.
- Workflow task/job/event data is accessed only through named port calls.
- The public API, lifecycle participant, Workflow Port v1 and Delivery Port v1 are frozen and do not expose DB handles.
- The host must not run provider/OpenClaw network operations inside a SQLite writer transaction.

## Delivery invariants

- A message claim acquires a SQLite writer reservation before permission/state readback and CAS.
- Attempt ordinal increments once per acquired claim.
- Durable transport-start intent is recorded before the host transport is invoked.
- ACK requires one exact canonical start event and one successful correlated receipt.
- A non-success/ambiguous transport outcome is quarantined, not blindly retried.
- An expired lease before transport start may be reclaimed. After transport start, external outcome is unknown until a valid durable receipt is verified.
- Local message state does not prove remote runtime state.

## Dependency model

The package uses Node.js built-ins and three pinned public contracts: @runalith/agent-contracts, @runalith/cos-ap, and @runalith/workflow-contracts. They are installed from immutable public GitHub archive URLs and do not require SSH credentials. No Workflow monolith source or sibling workspace import is needed at runtime.
