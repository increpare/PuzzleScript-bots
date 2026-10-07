'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { planRoleChange, applyRoleChange } = require('../roles');

const guild = [
  { id: '1', name: '@everyone' },
  { id: '10', name: 'CRATE' },
  { id: '11', name: 'Wall' },
  { id: '12', name: 'WIN' },
  { id: '90', name: 'Moderator' },
  { id: '91', name: 'ADMIN' },
];

test('picking a keyword adds the server role of that name', () => {
  const plan = planRoleChange('CRATE', guild, ['1']);
  assert.deepEqual([plan.ok, plan.keyword, plan.add, plan.remove], [true, 'CRATE', ['10'], []]);
});

test('the server role is matched whatever its capitalisation', () => {
  assert.deepEqual(planRoleChange('WALL', guild, ['1']).add, ['11']);
});

test('picking another keyword swaps it for the one held and leaves other roles alone', () => {
  const plan = planRoleChange('WIN', guild, ['1', '10', '90']);
  assert.deepEqual([plan.add, plan.remove], [['12'], ['10']]);
});

test('picking the keyword already held adds nothing', () => {
  const plan = planRoleChange('CRATE', guild, ['1', '10', '11']);
  assert.deepEqual([plan.ok, plan.keyword, plan.add, plan.remove], [true, 'CRATE', [], ['11']]);
});

test('none removes every keyword role held and adds nothing', () => {
  const plan = planRoleChange('none', guild, ['1', '10', '11', '90']);
  assert.deepEqual([plan.ok, plan.keyword, plan.add, plan.remove], [true, null, [], ['10', '11']]);
  assert.deepEqual(planRoleChange('none', guild, ['1', '90']).remove, []);
});

test('a server role that is not a keyword is refused, with nothing changed', () => {
  assert.deepEqual(planRoleChange('ADMIN', guild, ['1', '10']), { ok: false, reason: 'unknown' });
  assert.deepEqual(planRoleChange('Moderator', guild, ['1', '10']), { ok: false, reason: 'unknown' });
});

test('a keyword with no role on the server is reported, and the held role is kept', () => {
  assert.deepEqual(planRoleChange('PLAYER', guild, ['1', '10']), { ok: false, reason: 'missing' });
});

// Stands in for a member's role manager: records each call and can refuse to add.
function fakeMemberRoles({ refuseAdd = false } = {}) {
  const calls = [];
  return {
    calls,
    add: async (id) => {
      calls.push(['add', id]);
      if (refuseAdd) throw Object.assign(new Error('Missing Permissions'), { code: 50013 });
    },
    remove: async (id) => { calls.push(['remove', id]); },
  };
}

test('a swap adds the new role, then removes each old one, one id at a time', async () => {
  const roles = fakeMemberRoles();
  await applyRoleChange(roles, { add: ['12'], remove: ['10', '11'] });
  assert.deepStrictEqual(roles.calls, [['add', '12'], ['remove', '10'], ['remove', '11']]);
});

test('when the new role is refused the old one is not taken away', async () => {
  const roles = fakeMemberRoles({ refuseAdd: true });
  await assert.rejects(applyRoleChange(roles, { add: ['12'], remove: ['10'] }), { code: 50013 });
  assert.deepStrictEqual(roles.calls, [['add', '12']]);
});
