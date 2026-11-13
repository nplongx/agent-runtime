# Specialist role guidance

The `@runalith/agent-runtime/specialist-guidance` subpath exposes immutable prompt strings for the nine built-in specialist roles. It is static policy text, not an agent runner or Workflow coordinator.

## API

~~~js
import { getSpecialistRoleGuidance, SPECIALIST_GUIDANCE_ROLES } from '@runalith/agent-runtime/specialist-guidance';

const roles = SPECIALIST_GUIDANCE_ROLES;
const guidance = getSpecialistRoleGuidance('engineer');
~~~

`SPECIALIST_GUIDANCE_ROLES` is a frozen array. `getSpecialistRoleGuidance(role)` lowercases the requested role and returns its frozen source string; unknown roles throw. The guidance contract currently covers `product-owner`, `researcher`, `architect`, `engineer`, `security`, `qa`, `platform`, `writer`, and `reviewer`.

## Ownership boundary

The package owns only the reusable specialist guidance strings. Workflow host remains responsible for selecting roles, binding a specialist to an approved task, supplying task-specific contracts, registering tools, enforcing plan scope, authorization, artifact validation, approval, dispatch and result persistence.

This subpath does not import WorkflowStore, SQLite, Agent Session persistence, process execution, OpenClaw, MCP handlers, or tool implementations. It does not assert that every named tool exists in every host build. Keep host integration tests for prompt/tool compatibility.

The built-in System Workflow Coordinator is deliberately excluded. Its prompt is coupled to the host's `workflow_coordinator_step`, `workflow_write_files`, approval flow and Workflow task lifecycle. It remains owned by the Workflow host and is not persisted as a custom role.
