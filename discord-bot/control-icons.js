'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { Routes } = require('discord.js');
const manifest = require('./icons/controls/manifest.json');

// Version names by image content. A restart reuses the same uploads; an updated icon gets a
// new ID so buttons on older messages keep working. These emoji belong to the app, not a guild.
async function syncControlIcons(rest, appId) {
  const route = Routes.applicationEmojis(appId);
  const { items } = await rest.get(route);
  const existing = new Map(items.map(emoji => [emoji.name, emoji]));
  const icons = {};
  for (const icon of manifest) {
    const png = fs.readFileSync(path.join(__dirname, 'icons', 'controls', icon.png));
    const version = createHash('sha256').update(png).digest('hex').slice(0, 12);
    const name = 'ps_' + icon.name + '_' + version;
    const emoji = existing.get(name) || await rest.post(route, {
      body: { name, image: 'data:image/png;base64,' + png.toString('base64') },
    });
    icons[icon.name] = { id: emoji.id, name: emoji.name, animated: false };
  }
  return icons;
}

module.exports = { syncControlIcons };
