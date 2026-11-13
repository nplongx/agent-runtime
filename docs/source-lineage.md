# Source lineage and extraction boundary

## Upstream origin

The package was extracted from the Runalith monolith:

- Repository: https://github.com/nplongx/runalith
- Branch: integration/runalith-system-20261107
- Base revision: 29c24cfa2b6ead5704d26cf2746bc384f2938b80
- Entry points: src/runtime/agent-session-runtime.js, src/runtime/agent-skills.js and src/runtime/specialist-role-guidance.js

The broader upstream worktree was dirty during the extraction program. The selected Agent Session source files were clean at extraction time and copied into this package; docs/source-manifest.json pins their actual copied bytes. The base Git revision is provenance context, not a substitute for the byte manifest.

## Included first-party source

- agent-session-store.js: session schema, registry, ACL, queue, message claim, receipt, ACK and recovery.
- agent-session-api.js: Agent Session API v1, lifecycle participant v1, and internal delivery hook names.
- agent-session-policy.js: role normalization and grant/revoke policy predicates.
- agent-session-ports.js: versioned Workflow host port contract.
- agent-session-runtime.js: composition root and same-connection verification.
- agent-skills.js: bounded local/GitHub skill ingestion, SKILL.md metadata parsing, safe path filtering and content hashing. This source was copied from the clean upstream `src/runtime/workflow/agent-skills.js`; package-only changes add workspace-root injection and GitHub raw-path/tree metadata checks.
- specialist-role-guidance.js: static built-in specialist prompt strings copied from `src/runtime/workflow/specialist-role-guidance.js`; exposed as a separate subpath without Workflow or tool execution dependencies.
- index.js: public package exports.

The package owns its tests, package/lock files, CI, docs, changelog, security policy and source manifest.

## Pinned external contracts

Dependencies are installed as immutable GitHub archive tarballs and pinned in package.json and package-lock.json:

| Package | Source repository | Commit |
|---|---|---|
| @runalith/agent-contracts | nplongx/runalith-agent-contracts | 7253657b5c3e2815cd21afed08d1e7027510d866 |
| @runalith/cos-ap | nplongx/runalith-cos-ap | b6f2b51d549ba2f287ebd49d18ce29a212b2270a |
| @runalith/workflow-contracts | nplongx/runalith-workflow-contracts | 0419b17985500e3d9b3aa18e07c0b2f6b010070b |

The public packages supply role-contract validation, COS-AP v1 message validation, and strict JSON parsing. Monolith private/internal source paths are not imported.

## Exclusions and ownership

- Workflow job/task/event schema and authoritative task/event queries remain host-owned.
- WorkflowStore, WorkflowStatePort, RunalithWorkflowStore, MCP/HTTP handlers and OpenClaw transport adapters are excluded.
- Agent Runtime owns exactly agent_sessions, session_access, and session_messages.
- Agent Skills ingestion is a separate package subpath; it has no SQLite schema, Workflow port, or task/approval authority.
- The importer reads bounded text files only. It does not execute content, authenticate GitHub source identity, or sandbox a concurrently mutable local directory.
- Specialist guidance is static prompt data only. Workflow owns role selection, task binding, tool availability, approval, dispatch and task lifecycle. The System Workflow Coordinator remains host-owned because its prompt depends on Workflow-specific coordinator/write/approval tools.
- The three Agent tables reference host jobs/tasks; Workflow event appends/readback use Workflow Port v1.
- No host database, provider credentials, external sessions, message content, workspace state or deployment settings are copied.

## Independence and limits

The repository is installable from a clean checkout. It does not import monolith modules at runtime. However, host and Agent Runtime intentionally share one SQLite connection and one transaction unit. This is package/source separation, not an independent service, datastore, broker, or distributed transaction boundary.

docs/source-manifest.json records SHA-256 and byte size for every package-owned file except the manifest itself. npm run check:manifest verifies exact inventory and bytes. It does not fetch or compare the current upstream branch.
