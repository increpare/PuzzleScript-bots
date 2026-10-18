'use strict';
// Opt-in fidelity check: the actual homepage injection and original payload in Chromium,
// compared with the bot host. Like the other browser checks, uses Playwright from labs.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { createRequire } = require('node:module');
const { SRC_DIR } = require('../engine-src');
const { getSource } = require('../legacy/pushing-it');
const { createPushingItHost } = require('../pushing-it-host');
const { createCanvas, loadImage } = require('@napi-rs/canvas');

const labs = process.env.PUZZLESCRIPT_LABS_DIR || path.resolve(__dirname, '../../../PuzzleScript-labs/.claude/worktrees/discord-workshop');
const { chromium } = createRequire(path.join(labs, 'package.json'))('playwright');
const files = [
  'storagewrapper.js', 'bitvec.js', 'level.js', 'languageConstants.js', 'globalVariables.js',
  'debug_off.js', 'font.js', 'rng.js', 'riffwave.js', 'sfxr.js', 'codemirror/stringstream.js',
  'colors.js', 'graphics.js', 'engine.js', 'parser.js', 'compiler.js',
];
const html = `<!doctype html><style>body{margin:0}#screen{width:400px;height:300px}</style>
<div id="screen"><canvas id="gameCanvas" width="400" height="300"></canvas></div>
<a id="homepagelink"></a><a id="hacklink"></a><div id="errormessage"></div>
<script>window.requestAnimationFrame=()=>0;</script>
${files.map((f) => '<script src="/js/' + f + '"></script>').join('\n')}`;

async function main() {
  const server = http.createServer((req, res) => {
    const name = req.url.slice('/js/'.length);
    if (req.url.startsWith('/js/') && files.includes(name)) {
      res.setHeader('content-type', 'text/javascript');
      res.end(fs.readFileSync(path.join(SRC_DIR, 'js', name)));
    } else if (req.url === '/') {
      res.setHeader('content-type', 'text/html');
      res.end(html);
    } else { res.statusCode = 404; res.end(); }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 400, height: 300 } });
    await page.clock.install();
    const source = getSource();
    let checks = 0, worstMean = 0;
    for (let levelIndex = 0; levelIndex < 12; levelIndex++) {
      await page.goto('http://127.0.0.1:' + server.address().port + '/');
      await page.evaluate((source) => {
        unitTesting = true;
        lazyFunctionGeneration = false;
        playSound = () => {};
        ULBS = () => {};
        // Preserve the engine names Jack's 2021 title drawing expects.
        window.titleWidth = TERMINAL_WIDTH;
        window.titleHeight = TERMINAL_HEIGHT;
        compile(['restart'], source, 'seed');
        document.getElementById('homepagelink').innerHTML = state.metadata.homepage;
      }, source);
      await page.waitForFunction(() => typeof grid !== 'undefined');
      await page.evaluate((index) => {
        nextLevel();
        if (index) { mylevel = index; undostack = []; loadmylevel(); draw(); }
      }, levelIndex);
      const host = createPushingItHost();
      host.load(source, 'seed', levelIndex);
      try {
        const compare = async (label, rotated = false) => {
          const expected = await page.evaluate(() => ({
            state: JSON.stringify({ level: mylevel, state: getstate(), undo: undostack.length, playing: !titleScreen }),
            png: canvas.toDataURL().split(',')[1],
          }));
          const c = host._ctx;
          const actual = JSON.stringify({ level: c.mylevel, state: c.getstate(), undo: c.undostack.length, playing: host.snapshot().kind !== 'finished' });
          assert.equal(actual, expected.state, label + ': original geometry and history');
          const image = createCanvas(400, 300);
          const imageCtx = image.getContext('2d');
          imageCtx.drawImage(await loadImage(Buffer.from(expected.png, 'base64')), 0, 0);
          const expectedPixels = imageCtx.getImageData(0, 0, 400, 300).data;
          const rgba = host.snapshot().raster.rgba;
          let sum = 0;
          for (let i = 0; i < rgba.length; i++) sum += Math.abs(rgba[i] - expectedPixels[i]);
          const mean = sum / rgba.length;
          worstMean = Math.max(worstMean, mean);
          assert.ok(mean <= (rotated ? 0.5 : 0.01), label + ': canvas mean error ' + mean);
          checks++;
        };
        await compare('level ' + (levelIndex + 1) + ' start');
        const actions = levelIndex === 0 ? ['down', 'down', 'down', 'right', 'down', 'undo', 'restart'] : ['down', 'right', 'up', 'left', 'undo', 'restart'];
        for (const action of actions) {
          host.input(action);
          await page.evaluate((action) => {
            if (action === 'undo') DoUndo();
            else if (action === 'restart') DoRestart();
            else processInput({ up: 0, left: 1, down: 2, right: 3 }[action]);
          }, action);
          await page.clock.runFor(2000);
          await compare('level ' + (levelIndex + 1) + ' ' + action);
        }
        if (levelIndex === 9) {
          host._ctx.myall.box[0].angle = Math.PI / 8;
          host._ctx.draw();
          await page.evaluate(() => { myall.box[0].angle = Math.PI / 8; draw(); });
          await compare('rotated box', true);
          host.input('right');
          await page.evaluate(() => processInput(3));
          await page.clock.runFor(2000);
          await compare('move with rotated box', true);
        }
      } finally { host.dispose(); }
    }
    console.log(`Compared ${checks} states across all 12 levels; geometry/history identical; worst mean pixel error ${worstMean.toFixed(5)}.`);
  } finally {
    if (browser) await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
