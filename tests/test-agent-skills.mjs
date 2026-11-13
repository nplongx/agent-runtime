import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadAgentSkills, MAX_SKILLS_PER_ROLE, MAX_SKILL_FILE_BYTES, MAX_SKILLS_TOTAL_BYTES } from '../src/runtime/agent-skills.js';

const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-runtime-skills-'));
const workspaceRoot = path.join(temporaryRoot, 'workspace');
const outsideRoot = path.join(temporaryRoot, 'outside');
const write = (file, content) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
};
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

try {
  fs.mkdirSync(workspaceRoot, { recursive: true });
  fs.mkdirSync(path.join(outsideRoot, 'escaped-skill'), { recursive: true });
  write(path.join(outsideRoot, 'escaped-skill', 'SKILL.md'), '---\nname: escaped-skill\ndescription: Relative paths are anchored, not sandboxed.\n---\n');
  const localDirectory = path.join(workspaceRoot, 'code-review');
  write(path.join(localDirectory, 'SKILL.md'), [
    '---',
    'name: code-review',
    'description: >-',
    '  Reviews changed code for correctness and security.',
    '---',
    '',
    '# Review procedure',
    'Check control flow, errors, and test coverage.'
  ].join('\n'));
  write(path.join(localDirectory, 'references', 'checklist.md'), '# Checklist\nCheck tests before claiming success.\n');
  write(path.join(localDirectory, 'scripts', 'informational.js'), 'throw new Error("must remain inert text");\n');
  write(path.join(localDirectory, 'assets', 'template.json'), '{"format":"markdown"}\n');
  write(path.join(localDirectory, 'assets', 'logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]));

  const local = await loadAgentSkills(['code-review'], { workspaceRoot });
  assert.equal(local.length, 1);
  assert.equal(local[0].name, 'code-review');
  assert.match(local[0].description, /Reviews changed code/);
  assert.match(local[0].instructions, /Check control flow/);
  assert.match(local[0].sha256, /^[a-f0-9]{64}$/);
  assert.ok(local[0].files.some(file => file.path === 'references/checklist.md'));
  assert.ok(local[0].files.some(file => file.path === 'scripts/informational.js'));
  assert.ok(local[0].files.some(file => file.path === 'assets/template.json'));
  assert.equal(local[0].files.some(file => file.path.endsWith('.png')), false, 'binary assets are skipped');
  assert.match(local[0].files.find(file => file.path === 'scripts/informational.js').content, /must remain inert text/,
    'imported source files are returned as text and are not executed');
  assert.equal(local[0].files.find(file => file.path === 'references/checklist.md').sha256,
    sha256(Buffer.from('# Checklist\nCheck tests before claiming success.\n')));

  const missingDirectory = path.join(workspaceRoot, 'missing');
  fs.mkdirSync(missingDirectory);
  await assert.rejects(() => loadAgentSkills(['missing'], { workspaceRoot }), /root SKILL\.md/i);
  const explicitly_relative_outside = await loadAgentSkills(['../outside/escaped-skill'], { workspaceRoot });
  assert.equal(explicitly_relative_outside[0].name, 'escaped-skill',
    'workspaceRoot is a path anchor, not a filesystem sandbox; preserve absolute/parent-relative source compatibility');
  await assert.rejects(() => loadAgentSkills([localDirectory, localDirectory], { workspaceRoot }), /duplicate sources/i);
  await assert.rejects(() => loadAgentSkills(Array.from({ length: MAX_SKILLS_PER_ROLE + 1 }, (_, i) => `missing-${i}`), { workspaceRoot }),
    new RegExp(`at most ${MAX_SKILLS_PER_ROLE}`));
  await assert.rejects(() => loadAgentSkills([], { workspaceRoot: '' }), /workspaceRoot/);

  write(path.join(outsideRoot, 'secret.md'), 'not part of the skill\n');
  const symlinkRoot = path.join(workspaceRoot, 'linked-skill');
  fs.symlinkSync(outsideRoot, symlinkRoot, 'dir');
  await assert.rejects(() => loadAgentSkills(['linked-skill'], { workspaceRoot }), /real directory|symlink/i);
  const nestedSymlink = path.join(localDirectory, 'references', 'external.md');
  fs.symlinkSync(path.join(outsideRoot, 'secret.md'), nestedSymlink, 'file');
  await assert.rejects(() => loadAgentSkills(['code-review'], { workspaceRoot }), /must not contain symlinks/i);
  fs.unlinkSync(nestedSymlink);

  const oversizedDirectory = path.join(workspaceRoot, 'oversized-skill');
  write(path.join(oversizedDirectory, 'SKILL.md'), '---\nname: oversized-skill\ndescription: Too large.\n---\n');
  write(path.join(oversizedDirectory, 'large.md'), Buffer.alloc(MAX_SKILL_FILE_BYTES + 1, 0x61));
  await assert.rejects(() => loadAgentSkills(['oversized-skill'], { workspaceRoot }), /exceeds 32768 bytes/i);

  const remoteSource = 'https://github.com/example-org/example-skills/tree/main/skills/remote-review';
  const remoteContents = new Map([
    ['https://api.github.com/repos/example-org/example-skills/git/trees/main?recursive=1', JSON.stringify({
      tree: [
        { type: 'blob', path: 'skills/remote-review/SKILL.md', size: 110 },
        { type: 'blob', path: 'skills/remote-review/references/guide.md', size: 35 },
        { type: 'blob', path: 'skills/unrelated/SKILL.md', size: 45 },
        { type: 'blob', path: 'skills/remote-review/../escape.md', size: 12 }
      ], truncated: false
    })],
    ['https://raw.githubusercontent.com/example-org/example-skills/main/skills/remote-review/SKILL.md',
      '---\nname: remote-review\ndescription: Reviews code from an approved public GitHub skill source.\n---\n\nUse the review checklist.\n'],
    ['https://raw.githubusercontent.com/example-org/example-skills/main/skills/remote-review/references/guide.md', '# Remote guide\nCollect evidence.\n']
  ]);
  const mockFetch = async (url, options) => {
    assert.equal(options.redirect, 'error');
    const body = remoteContents.get(String(url));
    if (body === undefined) throw new Error(`unexpected URL in remote-skill test: ${url}`);
    const bytes = Buffer.from(body, 'utf8');
    return { ok: true, status: 200, headers: { get: name => name === 'content-length' ? String(bytes.length) : null },
      arrayBuffer: async () => bytes };
  };
  const remote = await loadAgentSkills([remoteSource], { fetchImpl: mockFetch, workspaceRoot });
  assert.equal(remote.length, 1);
  assert.equal(remote[0].name, 'remote-review');
  assert.equal(remote[0].source.kind, 'github');
  assert.ok(remote[0].files.some(file => file.path === 'references/guide.md'));
  assert.equal(remote[0].files.some(file => file.path.includes('unrelated') || file.path.includes('escape')), false,
    'remote imports stay scoped to the selected directory and reject traversal paths');

  await assert.rejects(() => loadAgentSkills(['https://example.com/skill/SKILL.md'], { fetchImpl: mockFetch, workspaceRoot }), /public GitHub/i);
  await assert.rejects(() => loadAgentSkills(['https://github.com/example-org/example-skills/tree/main/%2e%2e/escape'],
    { fetchImpl: mockFetch, workspaceRoot }), /unsafe skill file path/i);

  const malformedTreeSource = 'https://github.com/example-org/example-skills/tree/main/skills/bad-size';
  const malformedFetch = async url => ({ ok: true, status: 200, headers: { get: () => null },
    arrayBuffer: async () => Buffer.from(JSON.stringify({ tree: [
      { type: 'blob', path: 'skills/bad-size/SKILL.md' }
    ], truncated: false })) });
  await assert.rejects(() => loadAgentSkills([malformedTreeSource], { fetchImpl: malformedFetch, workspaceRoot }), /invalid declared size/i);

  const totalBytesDirectory = path.join(workspaceRoot, 'total-bytes-skill');
  write(path.join(totalBytesDirectory, 'SKILL.md'), '---\nname: total-bytes-skill\ndescription: Total size guard.\n---\n');
  for (let index = 0; index < 6; index += 1) {
    write(path.join(totalBytesDirectory, `part-${index}.md`), Buffer.alloc(Math.floor(MAX_SKILLS_TOTAL_BYTES / 5), 0x61));
  }
  await assert.rejects(() => loadAgentSkills(['total-bytes-skill'], { workspaceRoot }), /combined skill files exceed/i);

  console.log('Agent Skills package PASS: local/GitHub scope, path safety, symlink rejection, size bounds and inert text imports.');
} finally {
  fs.rmSync(temporaryRoot, { recursive: true, force: true });
}
