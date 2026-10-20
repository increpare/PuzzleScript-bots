'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createCanvas, loadImage } = require('@napi-rs/canvas');
const manifest = require('../icons/controls/manifest.json');

async function main() {
  const dir = path.join(__dirname, '..', 'icons', 'controls');
  for (const icon of manifest) {
    const image = await loadImage(fs.readFileSync(path.join(dir, icon.svg)));
    const canvas = createCanvas(128, 128);
    canvas.getContext('2d').drawImage(image, 0, 0, 128, 128);
    fs.writeFileSync(path.join(dir, icon.png), canvas.toBuffer('image/png'));
  }
  console.log('built', manifest.length, 'control icons');
}

main().catch(error => { console.error(error); process.exit(1); });
