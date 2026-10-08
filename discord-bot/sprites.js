'use strict';
const vm = require('node:vm');
const { createEngineContext } = require('./engine-host');
const { encodePNG } = require('./png');
const { makeImage, fillRect, parseHex } = require('./renderer');

// The most objects drawn in one picture.
const MAX_SPRITES = 40;
const CELL = 5;
// Sprites to a row, and how many pixels across each pixel of a sprite is drawn, by how many there are.
const PER_ROW = 8;
const scaleFor = (count) => (count === 1 ? 32 : count <= 4 ? 24 : count <= 8 ? 16 : 12);

const OTHER_SECTIONS = ['legend', 'sounds', 'collisionlayers', 'rules', 'winconditions', 'levels'];
const isTransparent = (c) => String(c).trim().toLowerCase() === 'transparent';

// Reads object definitions with the engine's own parser, started inside an OBJECTS section, and
// then does to each object what the compiler does to it for a whole game (generateExtraMembers):
// colour names become the default palette's colours, and the rows of pixels become numbers.
// Every complaint is the engine's own, made with its own logError and logWarning.
// An object need not have a name. Where the parser is due one and the line begins with a colour
// (and the line after it does not, or the colour would be the name of an object: Red, then red),
// it is given a name nothing in the text has, on a line of its own that is not counted. Such an
// object comes back with no name; the one it was given shows only in what the engine says of it.
let reader = null;
function getReader() {
  if (reader === null) {
    reader = vm.runInContext(`(function (lines) {
      resetParserErrorState();
      compiling = true;
      const sprites = [];
      let misshapen = false;
      try {
        const processor = new codeMirrorFn();
        const state = processor.startState();
        state.section = 'objects';
        const feed = (line) => {
          const stream = new CodeMirror.StringStream(line, 4);
          do { processor.token(stream, state); } while (stream.eol() === false);
        };
        const startsWithColour = (line) => { const word = /\\S+/.exec(line || ''); return word !== null && isColor(word[0].toLowerCase()); };
        const taken = new Set(lines.join(' ').toLowerCase().split(/\\s+/));
        const nameless = new Set();
        let spare = 0;
        lines.forEach((line, i) => {
          // the parser reads a name at the start of an object, and after colours that no pixels follow
          const nameDue = state.commentLevel === 0 && (state.objects_section === 0 || (state.objects_section === 2 && state.objects_spritematrix.length === 0));
          if (nameDue && startsWithColour(line) && !startsWithColour(lines[i + 1])) {
            let name;
            do { spare++; name = spare === 1 ? 'unnamed' : 'unnamed' + spare; } while (taken.has(name));
            nameless.add(name);
            feed(name);
            state.lineNumber--;
          }
          feed(line);
        });
        // an object the parser has complained of would only be complained of again here, in other words
        for (const n of errorCount > 0 ? [] : Object.keys(state.objects)) {
          const o = state.objects[n];
          // the line its colours are on: the one after its name, or its first when it has no name
          const coloursLine = nameless.has(n) ? o.lineNumber : o.lineNumber + 1;
          if (o.colors.length > 10) logError("a sprite cannot have more than 10 colors.  Why you would want more than 10 is beyond me.", coloursLine);
          const colors = [];
          for (const c of o.colors) {
            if (isColor(c)) colors.push(colorToHex(colorPalettes.arnecolors, c));
            else logError('Invalid color specified for object "' + n + '", namely "' + c + '".', coloursLine);
          }
          if (o.colors.length === 0) logError('color not specified for object "' + n + '".', o.lineNumber);
          let dat = [[0, 0, 0, 0, 0], [0, 0, 0, 0, 0], [0, 0, 0, 0, 0], [0, 0, 0, 0, 0], [0, 0, 0, 0, 0]];
          if (o.spritematrix.length > 0) {
            if (spriteMatrixIs5x5(o.spritematrix)) dat = generateSpriteMatrix(o.spritematrix);
            else { misshapen = true; logWarning("Sprite graphics must be 5 wide and 5 high exactly.", o.lineNumber); }
          }
          sprites.push({ name: nameless.has(n) ? null : state.original_case_names[n] || n, colors, dat });
        }
      } catch (e) {
        // the engine gives up after too many errors: what it had said by then is what is reported
        if (errorCount === 0) throw e;
      } finally { compiling = false; }
      return JSON.stringify({ sprites, said: errorStrings, errors: errorCount, misshapen });
    })`, createEngineContext());
  }
  return reader;
}

const stripTags = (s) => String(s).replace(/<\/?[a-zA-Z][^>]*>/g, '').replace(/\s+/g, ' ').trim();

// text: object definitions as an OBJECTS section holds them, with or without their names (a name
// is null where there was none). A whole section may be pasted, or a
// whole game: anything before an OBJECTS heading and from the next heading on is left out, and so
// are the rules of equals signs. Left-out lines are read as empty ones, so that the engine's line
// numbers are those of what was pasted.
// Returns { ok: true, sprites: [{ name, colors, dat }], notes } or { ok: false, problems }.
function readSprites(text) {
  const lines = String(text === undefined || text === null ? '' : text).replace(/\r\n?/g, '\n').split('\n');
  let kept = lines.slice();
  for (let i = 0; i < kept.length; i++) {
    const word = kept[i].trim().toLowerCase();
    if (word === 'objects') { for (let j = 0; j <= i; j++) kept[j] = ''; }
    else if (OTHER_SECTIONS.includes(word)) { kept = kept.slice(0, i); break; }
    else if (/^=+$/.test(word) || word.startsWith('```')) kept[i] = '';
  }
  const read = JSON.parse(getReader()(kept));
  const said = read.said.map(stripTags);
  if (read.errors > 0 || read.misshapen) return { ok: false, problems: said };
  if (read.sprites.length === 0) return { ok: false, problems: ['there is no object there to draw'] };
  if (read.sprites.length > MAX_SPRITES) return { ok: false, problems: ['that is ' + read.sprites.length + ' objects; ' + MAX_SPRITES + ' is the most in one picture'] };
  const sprites = read.sprites.map((s) => ({ name: s.name, colors: s.colors.map((c) => c.toLowerCase()), dat: s.dat }));
  // what is left in said is warnings: the sprites can be drawn, and the warnings go with the picture
  return { ok: true, sprites, notes: said };
}

// The sprites side by side on nothing: wherever a sprite has no pixel the picture is clear, and so
// is the gap of one sprite pixel between one sprite and the next.
function drawSprites(sprites) {
  const scale = scaleFor(sprites.length);
  const columns = Math.min(sprites.length, PER_ROW), rows = Math.ceil(sprites.length / PER_ROW);
  const step = (CELL + 1) * scale;
  const img = makeImage(columns * step - scale, rows * step - scale, '#00000000');
  sprites.forEach((sprite, i) => {
    const ox = (i % PER_ROW) * step, oy = Math.floor(i / PER_ROW) * step;
    for (let row = 0; row < CELL; row++) {
      for (let col = 0; col < CELL; col++) {
        const colour = sprite.colors[sprite.dat[row][col]];
        if (colour === undefined || isTransparent(colour)) continue;
        fillRect(img, ox + col * scale, oy + row * scale, scale, scale, parseHex(colour));
      }
    }
  });
  return img;
}

function renderSprites(sprites) {
  const img = drawSprites(sprites);
  return { png: encodePNG(img.width, img.height, img.rgba), width: img.width, height: img.height };
}

module.exports = { readSprites, drawSprites, renderSprites, MAX_SPRITES };
