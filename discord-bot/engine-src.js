'use strict';
const path = require('node:path');

// The PuzzleScript checkout whose src/ holds the engine, the gallery list and the demo games:
// the puzzlescript submodule, or the checkout named by the PUZZLESCRIPT_DIR environment variable.
const PUZZLESCRIPT_DIR = process.env.PUZZLESCRIPT_DIR
  ? path.resolve(process.env.PUZZLESCRIPT_DIR)
  : path.join(__dirname, '..', 'puzzlescript');

module.exports = { SRC_DIR: path.join(PUZZLESCRIPT_DIR, 'src') };
