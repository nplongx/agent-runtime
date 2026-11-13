# Terminology

| Term | Meaning |
|---|---|
| Agent Session | Durable registry binding one logical agent session to a Workflow job/task and external session key. Not an authenticated user session. |
| Session key | Opaque host/provider session identifier. Unique in Agent Session registry; not an identity assertion. |
| Access grant | Role-scoped permission row for one session, optionally expiring and revocable. |
| Attempt | Positive ordinal of one delivery/Agent Session attempt. Ordinal is not message ID. |
| Message | Durable COS-AP v1 envelope payload queued for one recipient role within a session. |
| Dedupe key | Caller-selected key for idempotent enqueue within one session. |
| Claim | Atomic durable assignment of one queued message attempt and lease to one local delivery worker. |
| Delivery-start event | Durable marker written immediately before host invokes external transport. |
| Receipt | Durable observation of host transport response bound to message and attempt. |
| ACK | Terminal local acknowledgement, accepted only after exact successful receipt and transport-start lineage verification. |
| Delivery uncertain | External side effect may have happened, but no durable success receipt proves outcome. Automatic replay is denied. |
| Lifecycle participant | Narrow internal Agent Session write methods called by Workflow in a Workflow-owned transaction. |

## State semantics

- CREATED, ACTIVE, PAUSED, STALE, FAILED, TERMINATED describe Agent Session lifecycle.
- QUEUED, DELIVERED, ACKED, FAILED describe local message queue/delivery state.
- DELIVERED means claimed under a live lease. It does not prove a remote service accepted the message.
- ACKED means local store verified a correlated success receipt and transport-start event.
- DELIVERY_UNCERTAIN is a failure classification, not proof that remote delivery failed.

## Authority and identity

A role string is policy input, not authenticated identity. An OpenClaw session key is an opaque correlation key, not an authenticated principal. A receipt is only as trustworthy as the host transport and its correlation/identity checks.

Persisted field names, event types, status strings, message wire fields, permission values and error prefixes are compatibility surfaces. Change them through explicit version/migration work, not a style-only rename.
