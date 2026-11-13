# Agent Skills ingestion

The `@runalith/agent-runtime/skills` subpath exposes a bounded importer for role skill folders. It is independent from Agent Session persistence: it does not accept a database, Workflow port, approval handle, or execution callback.

## API

~~~js
import { loadAgentSkills, MAX_SKILLS_PER_ROLE } from '@runalith/agent-runtime/skills';

const bundles = await loadAgentSkills(['skills/code-review', 'https://github.com/example-org/skills/tree/main/research'], {
  workspaceRoot: process.env.WORKFLOW_WORKSPACE,
});
~~~

`loadAgentSkills(sources, options)` accepts up to eight unique local directory paths or public GitHub skill directory URLs. `workspaceRoot` anchors relative local paths; by default it uses `WORKFLOW_WORKSPACE`, then the current user's home directory. It is not a sandbox boundary: absolute and parent-relative paths remain valid for compatibility. `fetchImpl` may be injected for deterministic host tests. The function returns an array of bundles containing `name`, `description`, `source`, `sha256`, `instructions`, and sorted text-file records (`path`, `content`, `sha256`, `size_bytes`).

Each skill directory must contain a root `SKILL.md` with a constrained YAML-frontmatter shape containing `name` and `description`. Name must be a lowercase slug of at most 64 characters. Description is limited to 1,024 characters. Imported instructions are the remaining Markdown body.

## Resource and path bounds

- At most 8 skills per role.
- At most 40 supported text files per skill.
- At most 32 KiB per file and 160 KiB across the whole import operation.
- Directory nesting depth at most 8.
- Local imports reject symbolic-link roots and symbolic links inside a skill tree.
- Hidden directories and common dependency/build/cache directories are skipped.
- Binary files and unsupported extensions are not imported.
- GitHub imports accept only `github.com` tree/blob URLs or `raw.githubusercontent.com` `SKILL.md` URLs over HTTPS, with no URL credentials, query, or fragment. Redirects are rejected.
- GitHub tree paths are scoped to the selected skill directory. Unsafe relative paths and malformed declared file sizes are excluded/rejected.

## Trust and execution boundary

All skill content is untrusted data. JavaScript, shell, Python and other supported source files are copied as UTF-8 text only. The package never imports, evaluates, executes, installs, or dispatches imported content. It does not authenticate a GitHub repository, pin a moving branch to an immutable commit, scan for malicious instructions, or decide whether a skill is appropriate for a role. Hosts must review source identity/content and apply their own role/approval policy before making bundles available to an agent.

The local directory importer checks symbolic links during traversal, but it is not a kernel-enforced sandbox against a concurrently hostile filesystem writer. Do not point it at an attacker-controlled directory while another process can mutate that tree. Use a private, stable staging directory when concurrent mutation is possible.

This API does not grant filesystem write permission. It reads caller-selected local source paths and returns detached text/metadata; custom-role persistence and authorization remain Workflow host responsibilities.
