'use strict';

// Joke roles named after PuzzleScript keywords. Each must exist as a server role of the same name.
const KEYWORDS = ['CRATE', 'PLAYER', 'BACKGROUND', 'WALL', 'TARGET', 'DIRECTION', 'SFX', 'WIN'];
const NONE = 'none';

// Works out which role ids to add to and remove from a member so they end up holding at most one keyword role.
function planRoleChange(choice, guildRoles, memberRoleIds) {
  const keyword = choice === NONE ? null : choice;
  // Only ever touch roles on the list, whatever the command was sent.
  if (keyword !== null && !KEYWORDS.includes(keyword)) return { ok: false, reason: 'unknown' };
  const keywordRoles = guildRoles.filter((r) => KEYWORDS.includes(r.name.toUpperCase()));
  const wanted = keyword === null ? null : keywordRoles.find((r) => r.name.toUpperCase() === keyword);
  if (keyword !== null && !wanted) return { ok: false, reason: 'missing' };
  const held = keywordRoles.filter((r) => memberRoleIds.includes(r.id));
  return {
    ok: true,
    keyword,
    add: wanted && !held.includes(wanted) ? [wanted.id] : [],
    remove: held.filter((r) => r !== wanted).map((r) => r.id),
  };
}

// Adds before removing, so a refused change leaves the member holding what they had.
// One id per call: discord.js then touches only that role instead of rewriting the member's whole list.
async function applyRoleChange(memberRoles, plan) {
  for (const id of plan.add) await memberRoles.add(id);
  for (const id of plan.remove) await memberRoles.remove(id);
}

module.exports = { planRoleChange, applyRoleChange, KEYWORDS, NONE };
