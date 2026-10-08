'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { createHost } = require('../engine-host');
const { buildAnimation } = require('../animation');
const { decodeGIF } = require('../gif');
const { renderLevelRGBA, renderTextRGBA } = require('../renderer');

const FIXTURE = (name) => fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8');
const SLIDE = FIXTURE('again-slide.txt');
const LOOP = FIXTURE('again-loop.txt');

// Play a decoded GIF: the canvas, as RGB triples, after each frame is drawn over the ones before.
function play(gif) {
  const canvas = new Uint8Array(gif.width * gif.height);
  return gif.frames.map((f) => {
    for (let y = 0; y < f.h; y++) for (let x = 0; x < f.w; x++) canvas[(f.y + y) * gif.width + f.x + x] = f.indices[y * f.w + x];
    const rgb = new Uint8Array(canvas.length * 3);
    for (let i = 0; i < canvas.length; i++) { const c = gif.palette[canvas[i]]; rgb[i * 3] = c[0]; rgb[i * 3 + 1] = c[1]; rgb[i * 3 + 2] = c[2]; }
    return rgb;
  });
}
function rgbOf(img) {
  const rgb = new Uint8Array(img.width * img.height * 3);
  for (let i = 0; i < img.width * img.height; i++) { rgb[i * 3] = img.rgba[i * 4]; rgb[i * 3 + 1] = img.rgba[i * 4 + 1]; rgb[i * 3 + 2] = img.rgba[i * 4 + 2]; }
  return rgb;
}
const same = (a, b) => Buffer.from(a).equals(Buffer.from(b));

function slide(extra) {
  const host = createHost();
  host.load(extra ? SLIDE.replace('author test', 'author test\n' + extra) : SLIDE, 'seed', 0);
  host.input('right', { capture: true });
  const out = { frames: host.takeFrames(), base: host.snapshot() };
  host.dispose();
  return out;
}

test('a chain that ends plays once: the final state first for a blink, each turn, then the final state to rest on', () => {
  const { frames, base } = slide();
  const gif = decodeGIF(buildAnimation({ base, frames }));
  assert.deepEqual([gif.width, gif.height, gif.loop], [400, 300, false]);
  const shown = play(gif);
  const final = rgbOf(renderLevelRGBA(base));
  assert.equal(gif.frames.length, 6, 'the opening blink and five turns');
  assert.ok(same(shown[0], final), 'someone whose client does not play GIFs still sees the final state');
  assert.equal(gif.frames[0].delayCs, 2);
  assert.ok(!same(shown[1], final), 'then the first turn');
  for (let i = 1; i < shown.length - 1; i++) assert.ok(!same(shown[i], shown[i + 1]), 'each turn changes the picture');
  assert.ok(same(shown[shown.length - 1], final), 'and it comes to rest on the final state');
  assert.deepEqual(gif.frames.slice(1).map((f) => f.delayCs), [15, 15, 15, 15, 15],
    'the final turn has a normal delay; the non-looping GIF stays on it');
});

test('turns after the first only redraw what changed', () => {
  const { frames, base } = slide();
  const gif = decodeGIF(buildAnimation({ base, frames }));
  assert.deepEqual([gif.frames[0].w, gif.frames[0].h], [400, 300]);
  for (const f of gif.frames.slice(2)) assert.ok(f.w * f.h < 400 * 300 / 4, 'a small patch, not the whole frame');
});

test('a loop plays for ever, one pass around it', () => {
  const host = createHost();
  host.load(LOOP, 'seed', 0);
  host.input('right'); host.input('right', { capture: true });
  const frames = host.takeFrames(), base = host.snapshot();
  host.dispose();
  const gif = decodeGIF(buildAnimation({ base, frames }));
  assert.equal(gif.loop, true);
  assert.equal(gif.frames.length, 3);
  assert.deepEqual([gif.frames[0].x, gif.frames[0].y, gif.frames[0].w, gif.frames[0].h], [0, 0, 400, 300], 'each pass starts from a full frame');
  const shown = play(gif);
  assert.ok(same(shown[0], rgbOf(renderLevelRGBA(base))), 'the loop starts on the state the game is left in');
  assert.ok(!same(shown[0], shown[1]) && !same(shown[1], shown[2]) && !same(shown[0], shown[2]));
  assert.deepEqual(gif.frames.map((f) => f.delayCs), [15, 15, 15], 'a loop has no resting frame');
});

test('the delay follows again_interval, held longer for turns that looked the same, and never under 20 ms', () => {
  const fast = slide('again_interval 0.005');
  assert.deepEqual(decodeGIF(buildAnimation(fast)).frames.slice(1).map((f) => f.delayCs), [2, 2, 2, 2, 2]);
  const held = slide();
  held.frames.list[1].repeat = 3;
  assert.equal(decodeGIF(buildAnimation(held)).frames[2].delayCs, 45);
});

test('a chain that ends on a message screen rests on the message', () => {
  const { frames, base } = slide();
  const message = Object.assign({}, base, { kind: 'message', message: 'well done' });
  const gif = decodeGIF(buildAnimation({ base: message, frames }));
  const shown = play(gif);
  const text = rgbOf(renderTextRGBA(message));
  assert.ok(same(shown[0], text));
  assert.ok(same(shown[shown.length - 1], text));
  assert.equal(gif.frames.length, 7, 'the blink, five turns, then the message');
  assert.equal(gif.frames[6].delayCs, 2);
  assert.equal(gif.frames[5].delayCs, 15, 'the last turn is shown for its own interval before the message');
});

test('it reports progress for every frame, and gives up when it runs out of time', () => {
  const { frames, base } = slide();
  let n = 0;
  assert.ok(buildAnimation({ base, frames, onProgress: () => n++ }));
  assert.ok(n >= 5);
  let t = 0;
  assert.equal(buildAnimation({ base, frames, budgetMs: 10, now: () => (t += 6) }), null);
});

test('it gives up on more colours than a GIF can hold, and on a result that is too large', () => {
  const { frames, base } = slide();
  const many = Object.assign({}, frames, { sprites: Object.assign({}, frames.sprites) });
  for (let i = 0; i < 300; i++) many.sprites[1000 + i] = { colors: ['#' + (0x100000 + i * 37).toString(16)], dat: [[0]] };
  assert.equal(buildAnimation({ base, frames: many }), null);
  assert.equal(buildAnimation({ base, frames, maxBytes: 100 }), null);
});

test('a move that raises a message and starts a loop plays once and rests on the message', () => {
  const host = createHost();
  host.load(LOOP.replace('[ Player | Boom1 ] again', '[ Player | Boom1 ] again message boom'), 'seed', 0);
  host.input('right'); host.input('right', { capture: true });
  const frames = host.takeFrames(), base = host.snapshot();
  host.dispose();
  assert.deepEqual([base.kind, base.animating, frames.loop], ['message', 'loop', true]);
  const gif = decodeGIF(buildAnimation({ base, frames }));
  assert.equal(gif.loop, false, 'repeating the turns for ever would never show the message');
  const shown = play(gif);
  const text = rgbOf(renderTextRGBA(base));
  assert.ok(same(shown[0], text));
  assert.ok(same(shown[shown.length - 1], text));
  assert.equal(gif.frames[gif.frames.length - 1].delayCs, 2);
});

test('a loop reached through a lead-in plays once, the lead-in and one pass round, and rests where the game was left', () => {
  const host = createHost();
  host.load(FIXTURE('again-fuse.txt'), 'seed', 0);
  host.input('right', { capture: true });
  const frames = host.takeFrames(), base = host.snapshot();
  host.dispose();
  const gif = decodeGIF(buildAnimation({ base, frames }));
  assert.equal(gif.loop, false);
  assert.equal(gif.frames.length, 7, 'the blink, two fuse turns, three explosion turns, and the final state');
  const shown = play(gif);
  const rest = rgbOf(renderLevelRGBA(base));
  assert.ok(same(shown[0], rest));
  assert.ok(same(shown[6], rest));
  assert.ok(same(shown[6], shown[3]), 'it rests on the first state of the loop');
  assert.equal(gif.frames[6].delayCs, 2);
});

// Discord's Lilliput checks cumulative duration before encoding the current frame:
// https://github.com/discord/lilliput/blob/master/ops.go (ImageOps.Transform).
function truncateDuration(gif, limitCs) {
  let duration = 0;
  return { ...gif, frames: gif.frames.filter((f) => (duration += f.delayCs) <= limitCs) };
}

test('duration-limited conversion still ends on the settled board', () => {
  const { frames, base } = slide();
  const gif = decodeGIF(buildAnimation({ base, frames }));
  const converted = truncateDuration(gif, 1000);
  assert.equal(converted.frames.length, gif.frames.length, 'no artificial long hold exceeds the conversion budget');
  const shown = play(converted);
  assert.ok(same(shown.at(-1), rgbOf(renderLevelRGBA(base))),
    'duration-limited conversion must retain the settled board');
});

test('duration-limited conversion keeps a final message after an animation', () => {
  const { frames, base } = slide();
  const message = { ...base, kind: 'message', message: 'well done' };
  const shown = play(truncateDuration(decodeGIF(buildAnimation({ base: message, frames })), 1000));
  assert.ok(same(shown.at(-1), rgbOf(renderTextRGBA(message))),
    'duration-limited conversion must retain the final message');
});
