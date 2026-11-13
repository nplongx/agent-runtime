# Changelog

## 0.2.0

- Extract bounded Agent Skill ingestion behind the `@runalith/agent-runtime/skills` public subpath.
- Add explicit workspace-root injection for deterministic host composition and testing.
- Reject unsafe relative paths in GitHub skill source directories and malformed tree file metadata.
- Preserve text-only, bounded, non-executing import behavior; no Workflow or SQLite dependency added to the skill subpath.

## 0.1.0

- Initial standalone Agent Runtime extraction.
- Agent Session registry, ACL and durable COS-AP v1 message queue.
- Frozen Workflow Port v1 and Agent Session API/lifecycle participant contracts.
- Exact shared-connection check against the host Workflow database.
- Durable claim/lease, transport-start, receipt, ACK, retry and uncertain-outcome recovery.

- Added optional host Delivery Port v1 to preserve existing compatibility/fault-injection hooks through package adoption.
