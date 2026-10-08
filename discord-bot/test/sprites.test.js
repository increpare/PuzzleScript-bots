'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { readSprites, drawSprites, renderSprites } = require('../sprites');
const { decodePNG } = require('../png');

const PLAYER = ['Player', 'black orange white red', '.000.', '.111.', '22222', '.333.', '.3.3.'].join('\n');

// The colour of one pixel of a picture, as [r, g, b, a].
const at = (img, x, y) => Array.from(img.rgba.subarray((y * img.width + x) * 4, (y * img.width + x) * 4 + 4));

test('an object is read as the engine reads it: its name as written, its colours from the default palette, its pixels', () => {
  const r = readSprites(PLAYER);
  assert.equal(r.ok, true);
  assert.deepEqual(r.sprites, [{
    name: 'Player',
    colors: ['#000000', '#eb8931', '#ffffff', '#be2633'],
    dat: [[-1, 0, 0, 0, -1], [-1, 1, 1, 1, -1], [2, 2, 2, 2, 2], [-1, 3, 3, 3, -1], [-1, 3, -1, 3, -1]],
  }]);
});

test('several objects are read in order: one of a single colour is filled with it, and colours may be hex or transparent', () => {
  const r = readSprites(['Background', 'GREEN', '', 'Crate', '#f80 Transparent', '00000', '0...0', '0.1.0', '0...0', '00000'].join('\n'));
  assert.equal(r.ok, true);
  assert.deepEqual(r.sprites.map((s) => s.name), ['Background', 'Crate']);
  assert.deepEqual(r.sprites[0], { name: 'Background', colors: ['#44891a'], dat: [[0, 0, 0, 0, 0], [0, 0, 0, 0, 0], [0, 0, 0, 0, 0], [0, 0, 0, 0, 0], [0, 0, 0, 0, 0]] });
  assert.deepEqual(r.sprites[1].colors, ['#f80', 'transparent']);
});

test('a whole OBJECTS section can be pasted, with its heading, its rules of equals signs and whatever follows it', () => {
  const pasted = ['title my game', '', '========', 'OBJECTS', '========', '', PLAYER, '', '=======', 'LEGEND', '=======', '', '. = Background', 'P = Player'].join('\n');
  const r = readSprites(pasted);
  assert.equal(r.ok, true);
  assert.deepEqual(r.sprites.map((s) => s.name), ['Player']);
});

test('what the engine would not accept is refused in the engine\'s words, with the line it is on', () => {
  const problem = (text) => { const r = readSprites(text); assert.equal(r.ok, false); return r.problems.join('\n'); };
  assert.match(problem('Thing\nblurple'), /line 2 : Was looking for color for object THING, got "blurple" instead\./);
  assert.match(problem('Thing\nred\n01000\n00000\n00000\n00000\n00000'), /line 3 : Trying to access color number 1/);
  assert.match(problem('Thing\nred\n000\n000'), /line 1 : Sprite graphics must be 5 wide and 5 high exactly\./);
  assert.match(problem('Thing'), /line 1 : color not specified for object "thing"\./i);
  // the line is the one in what was pasted, heading and all
  assert.match(problem('OBJECTS\n=======\n\nThing\nblurple'), /line 5 : Was looking for color/);
});

test('a mistake the parser has already named is not reported again in other words', () => {
  const r = readSprites('Player\nblurple\n.000.');
  assert.equal(r.ok, false);
  assert.match(r.problems[0], /line 2 : Was looking for color/);
  assert.ok(!r.problems.some((p) => /color not specified|5 wide and 5 high exactly/.test(p)), r.problems.join(' | '));
});

test('a warning from the engine does not stop the drawing, and comes back with it', () => {
  const r = readSprites('Again\nred');
  assert.equal(r.ok, true);
  assert.deepEqual(r.sprites.map((s) => s.name), ['Again']);
  assert.equal(r.notes.length, 1);
  assert.match(r.notes[0], /line 1 : You named an object "AGAIN", but this is a keyword/);
});

test('nothing to draw is refused', () => {
  assert.equal(readSprites('').ok, false);
  assert.equal(readSprites('\n  \n').ok, false);
  assert.equal(readSprites(undefined).ok, false);
});

test('more objects than can be drawn at once are refused', () => {
  const many = (n) => Array.from({ length: n }, (_, i) => 'Thing' + i + '\nred\n').join('\n');
  assert.equal(readSprites(many(40)).ok, true);
  const r = readSprites(many(41));
  assert.equal(r.ok, false);
  assert.match(r.problems[0], /41/);
});

test('one sprite is drawn large, on nothing: where it has no pixel the picture is clear', () => {
  const img = drawSprites(readSprites(PLAYER).sprites);
  assert.deepEqual([img.width, img.height], [160, 160], 'five pixels, each 32 across');
  assert.deepEqual(at(img, 0, 0), [0, 0, 0, 0], 'a dot is see-through');
  assert.deepEqual(at(img, 32, 0), [0, 0, 0, 255], 'black hair, solid');
  assert.deepEqual(at(img, 63, 31), [0, 0, 0, 255], 'to the far corner of that pixel');
  assert.deepEqual(at(img, 64, 32), [0xeb, 0x89, 0x31, 255], 'an orange face in the row below');
  assert.deepEqual(at(img, 159, 159), [0, 0, 0, 0]);
  assert.deepEqual(at(img, 96, 159), [0xbe, 0x26, 0x33, 255], 'a red foot at the bottom');
});

test('a colour written as transparent is see-through too', () => {
  const img = drawSprites(readSprites('Ring\nred transparent\n00000\n01110\n01110\n01110\n00000').sprites);
  assert.deepEqual(at(img, 80, 80), [0, 0, 0, 0]);
  assert.deepEqual(at(img, 0, 0), [0xbe, 0x26, 0x33, 255]);
});

test('several sprites stand in a row with a clear gap between them, eight to a row', () => {
  const colours = ['red', 'green', 'white'];
  const three = drawSprites(readSprites(colours.map((c, i) => 'T' + i + '\n' + c + '\n').join('\n')).sprites);
  // three or four are drawn 24 to a pixel: each sprite 120 across, with a gap of one pixel (24)
  assert.deepEqual([three.width, three.height], [120 * 3 + 24 * 2, 120]);
  assert.deepEqual(at(three, 119, 0), [0xbe, 0x26, 0x33, 255], 'the first ends');
  assert.deepEqual(at(three, 120, 0), [0, 0, 0, 0], 'the gap');
  assert.deepEqual(at(three, 144, 0), [0x44, 0x89, 0x1a, 255], 'the second begins');
  const nine = drawSprites(readSprites(Array.from({ length: 9 }, (_, i) => 'T' + i + '\nred\n').join('\n')).sprites);
  // more than eight are drawn 12 to a pixel: 60 across with a gap of 12, and the ninth starts a second row
  assert.deepEqual([nine.width, nine.height], [60 * 8 + 12 * 7, 60 * 2 + 12]);
  assert.deepEqual(at(nine, 0, 72), [0xbe, 0x26, 0x33, 255], 'the ninth, under the first');
  assert.deepEqual(at(nine, 72, 72), [0, 0, 0, 0], 'and nothing beside it');
});

test('the picture is a PNG of what was drawn', () => {
  const sprites = readSprites(PLAYER).sprites;
  const out = renderSprites(sprites);
  const back = decodePNG(Buffer.from(out.png));
  assert.deepEqual([back.width, back.height], [160, 160]);
  assert.deepEqual(Array.from(back.rgba), Array.from(drawSprites(sprites).rgba));
});
