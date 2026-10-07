// The level in the engine's memory as the text a LEVELS section would hold: one legend glyph per
// cell. This runs in the engine's own global scope, in the editor page and in the bot's engine
// host, and uses only what the engine defines (state, level, BitVec, STRIDE_OBJ).
//
// The glyph for a cell is chosen the way the engine's own printLevel chooses it (matchGlyph in
// inputoutput.js, which the bot's host does not load): of the single-character legend names whose
// objects, background aside, are all in the cell, the one that accounts for the most of it. Where
// printLevel would print a placeholder for a cell nothing matches, this throws.
function levelToText() {
  var glyphs = [];
  var backgroundMask = state.layerMasks[state.backgroundlayer];
  for (var name in state.glyphDict) {
    if (!Object.prototype.hasOwnProperty.call(state.glyphDict, name) || name.length !== 1) continue;
    var ids = state.glyphDict[name];
    var bits = new BitVec(STRIDE_OBJ);
    for (var i = 0; i < ids.length; i++) {
      if (ids[i] >= 0) bits.ibitset(ids[i]);
    }
    var mask = bits.clone();
    mask.iclear(backgroundMask);
    glyphs.push({ name: name, mask: mask, bits: bits });
  }
  var rows = [];
  for (var y = 0; y < level.height; y++) {
    var row = '';
    for (var x = 0; x < level.width; x++) {
      var cell = level.getCell(y + x * level.height);
      var best = null;
      var bestCount = 0;
      for (var g = 0; g < glyphs.length; g++) {
        if (!glyphs[g].mask.bitsSetInArray(cell.data)) continue;
        var count = 0;
        for (var bit = 0; bit < 32 * STRIDE_OBJ; bit++) {
          if (!cell.get(bit)) continue;
          if (glyphs[g].bits.get(bit)) count++;
          if (glyphs[g].mask.get(bit)) count++;
        }
        if (count > bestCount) {
          bestCount = count;
          best = glyphs[g].name;
        }
      }
      if (best === null) throw new Error('no glyph for a cell');
      row += best;
    }
    rows.push(row);
  }
  return rows.join('\n');
}
