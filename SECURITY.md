# Security Policy

Report vulnerabilities privately through GitHub Security Advisories for nplongx/agent-runtime. Do not publish exploit details before maintainers assess impact.

## Security scope

Agent Runtime persists agent session identifiers, role access grants, message payloads, delivery receipts and Workflow event references. Treat its SQLite database and backups as sensitive host application state.

This library is not an identity provider, authorization server, secure agent sandbox, network broker, or security certification.

## Host-owned authority

The host application must:
- authenticate users/operators/services before passing actor and role assertions;
- authorize creation, access grants, revocation, takeover, message enqueue and delivery;
- bind session/task/job to authoritative Workflow state;
- initialize and protect Workflow SQLite database;
- supply Workflow Port v1 bound to exact same database connection;
- provide authenticated transport and validate external destination/session correlation;
- manage credentials, process execution, OpenClaw lifecycle, scheduling, cancellation and recovery;
- protect backups, monitor uncertainty/quarantine state, and define retention/incident procedures.

A role string, session key, message payload, event, receipt or hash does not authenticate a caller or authorize an operation.

## SQLite and ownership boundary

Agent Runtime owns only agent_sessions, session_access, and session_messages. Workflow owns jobs, tasks, and events. Agent Runtime references parent rows and calls Workflow only through versioned port.

The same SQLite connection is a security and atomicity requirement. A different handle to the same database file is rejected. Do not split Agent tables into a separate database without a separately designed transaction/reconciliation protocol.

When host supplies SQLite, host must enforce file permissions, WAL/backup consistency, foreign-key settings, and connection lifetime. Agent Runtime does not open files, set OS permissions, or close connection.

## Access grants

Local policy checks role vocabulary and actor/target relationships. It does not authenticate grantedBy or actor. Host must authenticate and authorize these values before calling grant, revoke, or takeover methods.

TAKEOVER is never implicit. Expiry parsing is strict and malformed persisted values fail closed. Do not bypass these checks with direct SQL updates to session_access.

## Message delivery and uncertain outcomes

Host transport is called only after durable delivery-start intent. A transport timeout, disconnect, malformed result, or receipt persistence failure may happen after a remote side effect. Runtime then quarantines that attempt and does not automatically replay it.

Do not clear DELIVERY_UNCERTAIN state or reset a message to QUEUED without provider-side reconciliation and an explicit operator/host decision. DELIVERED is a local lease state, not proof of remote receipt. ACKED requires exact durable success receipt and transport-start event lineage.

Runtime passes message ID as host transport idempotency key. Host must preserve that identity when supported by external transport and verify run/session correlation. Local idempotency cannot guarantee remote idempotency by itself.

## Legacy backfill

Initialization may best-effort backfill registry rows from task rows containing existing OpenClaw session keys. Backfill does not authenticate those keys or start an external runtime. Review startup warnings and reconcile historical state before granting new access based on imported rows.

## Supported use

Use only as an embedded library inside a trusted host that enforces identity, authorization, transport and database boundaries. Do not expose raw API calls directly to untrusted network callers.
