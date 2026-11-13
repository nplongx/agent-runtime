import assert from 'node:assert/strict';
import test from 'node:test';
import { getSpecialistRoleGuidance, SPECIALIST_GUIDANCE_ROLES } from '../src/runtime/specialist-role-guidance.js';

const expectedRoles = ['product-owner', 'researcher', 'architect', 'engineer', 'security', 'qa', 'platform', 'writer', 'reviewer'];

test('specialist role inventory is frozen and exact', () => {
  assert.deepEqual([...SPECIALIST_GUIDANCE_ROLES], expectedRoles);
  assert.equal(Object.isFrozen(SPECIALIST_GUIDANCE_ROLES), true);
});

test('each specialist guidance has the five required contract sections', () => {
  for (const role of expectedRoles) {
    const guidance = getSpecialistRoleGuidance(role);
    assert.equal(typeof guidance, 'string', `${role} guidance must be a string`);
    for (const section of ['Focus:', 'Deliverable:', 'Evidence:', 'Stop/escalate:', 'Tool selection:']) {
      assert.ok(guidance.includes(section), `${role} guidance is missing ${section}`);
    }
  }
});

test('role lookup is case-insensitive but rejects unknown roles', () => {
  assert.equal(getSpecialistRoleGuidance('ENGINEER'), getSpecialistRoleGuidance('engineer'));
  assert.notEqual(getSpecialistRoleGuidance('engineer'), getSpecialistRoleGuidance('reviewer'));
  assert.throws(() => getSpecialistRoleGuidance('cto'), /unknown specialist role/);
});
