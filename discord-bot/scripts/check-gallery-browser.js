'use strict';
// Opt-in check of the gallery submission page in Chromium, with the real PuzzleScript engine and a
// stand-in for the submitter. Needs a labs checkout with Playwright installed (see README).
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { createRequire } = require('node:module');
const { createHttpServer } = require('../http-server');
const { createSigner } = require('../signing');
const { SRC_DIR } = require('../engine-src');
const { GALLERY_LINK_MS } = require('../gallery-entry');

const labs = process.env.PUZZLESCRIPT_LABS_DIR || path.resolve(__dirname, '../../../PuzzleScript-labs/.claude/worktrees/discord-workshop');
const { chromium } = createRequire(path.join(labs, 'package.json'))('playwright');

const game = (prelude, rules, win, levels) => `${prelude}

========
OBJECTS
========

Background
black

Wall
grey

Player
white

Crate
orange

Target
blue

=======
LEGEND
=======

. = Background
# = Wall
P = Player
* = Crate
O = Target

=======
SOUNDS
=======

================
COLLISIONLAYERS
================

Background
Target
Player, Wall, Crate

======
RULES
======

${rules}

==============
WINCONDITIONS
==============

${win}

=======
LEVELS
=======

${levels}
`;

// Level 1 is won by one step right, level 2 by two. Message screens are levels too, to the engine.
const TURNS = game('title Gallery Fixture\nauthor Fixture Author\nhomepage www.example.com', '[ > Player | Crate ] -> [ > Player | > Crate ]', 'All Target on Crate',
  'message hello\n\n#######\n#P*O..#\n#######\n\nmessage between\n\n#######\n#P.*O.#\n#######');
// The crate walks to the right wall by itself, one step a tick, and then every tick changes nothing.
const REALTIME = game('title Realtime Fixture\nrealtime_interval 0.05', '[ stationary Crate ] -> [ right Crate ]', '',
  '#########\n#P......#\n#*......#\n#########');
const SOURCES = { aaaa1111: TURNS, bbbb2222: REALTIME, cccc3333: TURNS };

// The size, frame count, frame delays (hundredths of a second) and looping of a GIF.
function gifInfo(buf) {
  assert.equal(buf.toString('latin1', 0, 6), 'GIF89a');
  const info = { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8), frames: 0, delays: [], loops: false };
  const table = (flags) => (flags & 0x80 ? 3 * (1 << ((flags & 7) + 1)) : 0);
  let p = 13 + table(buf[10]);
  const skipBlocks = () => { while (buf[p] !== 0) p += buf[p] + 1; p++; };
  for (;;) {
    const kind = buf[p++];
    if (kind === 0x3b) break;
    if (kind === 0x21) {
      const label = buf[p++];
      if (label === 0xff && buf.toString('latin1', p + 1, p + 12) === 'NETSCAPE2.0') info.loops = true;
      if (label === 0xf9) info.delays.push(buf.readUInt16LE(p + 2));
      skipBlocks();
    } else if (kind === 0x2c) {
      info.frames++;
      p += 9 + table(buf[p + 8]) + 1;
      skipBlocks();
    } else throw new Error('not a GIF block: ' + kind);
  }
  return info;
}

test('the gallery submission page', async (t) => {
  const signer = createSigner('gallery browser check');
  const submissions = [];
  const server = createHttpServer({
    staticDirs: [path.resolve(__dirname, '../activity')],
    signer,
    oauth: { exchange: async () => { throw new Error('not used'); } },
    api: {},
    gallery: {
      ownerId: 'owner',
      engineDir: path.join(SRC_DIR, 'js'),
      game: async (gistId) => ({ gistId, source: SOURCES[gistId], inGallery: gistId === 'cccc3333' }),
      submit: async (gistId, body) => {
        submissions.push({ gistId, body });
        return { ok: true, commitUrl: 'https://github.com/increpare/PuzzleScript/commit/abc123', galleryUrl: 'https://www.puzzlescript.net/Gallery/index.html', site: null, botCopy: null };
      },
    },
    log: () => {},
  });
  const port = await server.listen(0);
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await server.close(); });
  const errors = [];

  async function open(gistId, { token = signer.sign({ kind: 'gallery', uid: 'owner', gistId }, GALLERY_LINK_MS) } = {}) {
    const page = await (await browser.newContext({ viewport: { width: 1100, height: 800 } })).newPage();
    page.on('pageerror', (e) => errors.push(gistId + ': ' + e.message));
    await page.goto('http://127.0.0.1:' + port + '/gallery/' + (token === null ? '' : '#t=' + token));
    return page;
  }
  const inputs = (page) => page.locator('#take').evaluate((el) => JSON.parse(el.dataset.inputs));
  const takeIs = (page, want) => page.waitForFunction((want) => document.getElementById('take').dataset.inputs === want, JSON.stringify(want), { timeout: 3000 });
  const gifOf = async (page) => Buffer.from((await page.locator('#preview').getAttribute('src')).replace(/^data:image\/gif;base64,/, ''), 'base64');

  await t.test('without a link there is nothing to do, and it says so', async () => {
    const page = await open('aaaa1111', { token: null });
    await page.waitForFunction(() => /\/admin_gallery/.test(document.getElementById('status').textContent));
    assert.equal(await page.locator('#submit').isDisabled(), true);
    const stale = await open('aaaa1111', { token: signer.sign({ kind: 'gallery', uid: 'somebody else', gistId: 'aaaa1111' }, GALLERY_LINK_MS) });
    await stale.waitForFunction(() => /run out/.test(document.getElementById('status').textContent));
  });

  await t.test('a level is picked, played, made into a GIF and submitted', async () => {
    const page = await open('aaaa1111');
    await page.waitForFunction(() => document.querySelectorAll('#level option').length === 2);
    assert.deepEqual(await page.locator('#level option').allTextContents(), ['Level 1', 'Level 2']);
    assert.equal(await page.locator('#title').inputValue(), 'Gallery Fixture');
    assert.equal(await page.locator('#author').inputValue(), 'Fixture Author');
    assert.equal(await page.locator('#homepage').inputValue(), 'www.example.com');
    assert.equal(await page.locator('#make').isDisabled(), true);
    assert.equal(await page.locator('#submit').isDisabled(), true);

    await page.locator('#level').selectOption({ label: 'Level 2' });
    await takeIs(page, []);
    await page.keyboard.press('ArrowRight');
    await takeIs(page, [3]);

    // typing in a field is typing: spaces arrive, and the player does not move
    await page.locator('#title').click();
    await page.keyboard.press('End');
    await page.keyboard.type(' x y');
    await page.keyboard.press('ArrowLeft');
    assert.equal(await page.locator('#title').inputValue(), 'Gallery Fixture x y');
    assert.deepEqual(await inputs(page), [3]);
    await page.locator('#gameCanvas').click();
    await page.keyboard.press('ArrowLeft');
    await takeIs(page, [3, 1]);

    await page.locator('#again').click();
    await takeIs(page, []);
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');
    await page.waitForFunction(() => document.getElementById('take').dataset.closed === 'won', null, { timeout: 3000 });
    // the engine goes on to the next level, and what is pressed there is not part of the take
    await page.waitForFunction(() => curlevel !== 3, null, { timeout: 3000 });
    await page.keyboard.press('ArrowRight');
    assert.deepEqual(await inputs(page), [3, 3]);

    await page.locator('#make').click();
    await page.waitForFunction(() => document.getElementById('preview').src.startsWith('data:image/gif'));
    const gif = await gifOf(page);
    const info = gifInfo(gif);
    // the level alone, 7 cells by 3, within the 400 pixel play area
    assert.ok(info.width <= 400 && info.width > 300, 'width ' + info.width);
    assert.equal(info.width * 3, info.height * 7);
    assert.equal(info.frames, 3);
    assert.equal(info.loops, true);
    // the replay rests on the solved level and does not go on to the next
    assert.equal(await page.evaluate(() => curlevel), 3);
    assert.match(await page.locator('#gifinfo').textContent(), new RegExp(info.width + ' × ' + info.height));

    await page.locator('#title').fill('Renamed');
    await page.locator('#homepage').fill('');
    assert.equal(await page.locator('#submit').isDisabled(), false);
    await page.locator('#submit').click();
    await page.waitForFunction(() => document.querySelectorAll('#outcome a').length === 2);
    assert.deepEqual(await page.locator('#outcome a').evaluateAll((links) => links.map((a) => a.href)), ['https://github.com/increpare/PuzzleScript/commit/abc123', 'https://www.puzzlescript.net/Gallery/index.html']);
    assert.equal(await page.locator('#submit').isDisabled(), true);
    assert.equal(submissions.length, 1);
    assert.equal(submissions[0].gistId, 'aaaa1111');
    assert.deepEqual(Object.keys(submissions[0].body).sort(), ['author', 'gif', 'homepage', 'title']);
    assert.equal(submissions[0].body.title, 'Renamed');
    assert.equal(submissions[0].body.author, 'Fixture Author');
    assert.equal(submissions[0].body.homepage, '');
    assert.equal(submissions[0].body.gif, gif.toString('base64'));
  });

  await t.test('a realtime game is recorded tick by tick, and a still board is one frame', async () => {
    const page = await open('bbbb2222');
    await page.waitForFunction(() => JSON.parse(document.getElementById('take').dataset.inputs || '[]').length >= 14, null, { timeout: 5000 });
    await page.keyboard.press('ArrowRight');
    await page.waitForFunction(() => JSON.parse(document.getElementById('take').dataset.inputs).includes(3));
    await page.locator('#make').click();
    await page.waitForFunction(() => document.getElementById('preview').src.startsWith('data:image/gif'));
    const take = await inputs(page);
    assert.ok(take.filter((i) => i === 'tick').length >= 14);
    // making the GIF closed the take: ticks since are not added to it
    await new Promise((r) => setTimeout(r, 300));
    assert.deepEqual(await inputs(page), take);
    const info = gifInfo(await gifOf(page));
    // the crate takes six steps to reach the wall, and the player one
    assert.ok(info.frames >= 7 && info.frames <= 9, 'frames ' + info.frames);
    assert.ok(info.frames < take.length);
    // the ticks on which nothing moved are time on the frame before them
    assert.ok(info.delays.reduce((a, b) => a + b, 0) >= take.length * 5 - 5, 'delays ' + info.delays);
    assert.equal(info.loops, true);
  });

  await t.test('a game already in the gallery can be played but not submitted', async () => {
    const page = await open('cccc3333');
    await page.waitForFunction(() => /already in the gallery/.test(document.getElementById('status').textContent));
    await page.waitForFunction(() => document.querySelectorAll('#level option').length === 2);
    await page.keyboard.press('ArrowRight');
    await page.waitForFunction(() => document.getElementById('take').dataset.closed === 'won');
    await page.locator('#make').click();
    await page.waitForFunction(() => document.getElementById('preview').src.startsWith('data:image/gif'));
    assert.equal(await page.locator('#submit').isDisabled(), true);
  });

  assert.deepEqual(errors, []);
});
