'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { workshopPage } = require('../workshop-page');

const EDITOR = ['<html><head><title>PuzzleScript</title></head><body>', '<script src="js/jsgif/GIFEncoder.js"></script>', '<script src="js/storagewrapper.js"></script>', '<script src="js/engine.js"></script>', '<script src="js/makegif.js"></script>', '', '</body>', '</html>'].join('\n');

test('the editor page gets the workshop\'s storage in place of its own, and its scripts at the end', () => {
  const page = workshopPage(EDITOR);
  assert.equal(page.includes('js/storagewrapper.js'), false);
  const order = ['js/jsgif/GIFEncoder.js', 'workshop/storage.js', 'js/engine.js', 'js/makegif.js', 'vendor/embedded-app-sdk.js', 'workshop/main.js', '</body>'].map((s) => page.indexOf(s));
  assert.ok(order.every((at) => at >= 0), JSON.stringify(order));
  assert.deepEqual(order, order.slice().sort((a, b) => a - b));
  // nothing else is touched
  assert.equal(page.replace('<script src="workshop/storage.js"></script>', '<script src="js/storagewrapper.js"></script>').replace('<script src="vendor/embedded-app-sdk.js"></script>\n<script src="workshop/main.js"></script>\n', ''), EDITOR);
});

test('a page that is not laid out as expected is refused, not half-changed', () => {
  assert.throws(() => workshopPage(EDITOR.replace('<script src="js/storagewrapper.js"></script>', '')), /not laid out as expected/);
  assert.throws(() => workshopPage(EDITOR + '<script src="js/storagewrapper.js"></script>'), /not laid out as expected/);
  assert.throws(() => workshopPage(EDITOR.replace('</body>', '')), /not laid out as expected/);
});
