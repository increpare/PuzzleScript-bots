'use strict';
// Opt-in checks against the actual labs editor, including a cross-origin, download-sandboxed frame.
// Needs a labs checkout with Playwright installed and a Chromium browser (see README).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { createRequire } = require('node:module');
const { createHttpServer } = require('../http-server');
const { createSigner } = require('../signing');
const { createWorkshopDoc } = require('../workshop-doc');
const { createWorkshopSaves } = require('../workshop-saves');
const { createPresence } = require('../workshop-presence');
const { workshopPage } = require('../workshop-page');
const { createExports } = require('../workshop-exports');
const { createSignals } = require('../workshop-signals');

const labs = process.env.PUZZLESCRIPT_LABS_DIR || path.resolve(__dirname, '../../../PuzzleScript-labs/.claude/worktrees/discord-workshop');
const { chromium } = createRequire(path.join(labs, 'package.json'))('playwright');
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const viewCode = 'window.PuzzleScriptCM6Runtime.EditorView.findFromDOM(document.querySelector(".cm-editor"))';
const cursor = (frame, pos) => frame.evaluate(({ code, pos }) => { const view = eval(code); view.dispatch({ selection: { anchor: pos }, scrollIntoView: true }); view.focus(); }, { code: viewCode, pos });

test('the workshop editor in a Discord-like frame', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'workshop-browser-'));
  const doc = createWorkshopDoc({ dataDir: dir });
  const saves = createWorkshopSaves({ dataDir: dir });
  const presence = createPresence();
  const source = fs.readFileSync(path.join(labs, 'src/demo/sokoban_basic.txt'), 'utf8') + '\n' + Array.from({ length: 180 }, (_, i) => '(navigation row ' + i + ')').join('\n');
  const { ChangeSet } = require('../vendor/codemirror-state.cjs');
  doc.push(0, [{ clientID: 'initial', changes: ChangeSet.of({ from: 0, insert: source }, 0).toJSON() }]);
  const server = createHttpServer({
    staticDirs: [path.resolve(__dirname, '../activity'), path.join(labs, 'src')],
    indexHtml: workshopPage(fs.readFileSync(path.join(labs, 'src/editor.html'), 'utf8')),
    signer: createSigner('browser tests'),
    oauth: { exchange: async (name) => ({ accessToken: 'access', user: { id: name, name } }) },
    api: {}, workshop: doc, workshopSaves: saves, workshopPresence: presence,
    workshopExports: createExports(),
    workshopSignals: createSignals(),
    workshopPublicUrl: 'http://127.0.0.1/',
  });
  const port = await server.listen(0);
  const wrapper = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<iframe style="border:0;width:100%;height:95vh" sandbox="allow-scripts allow-same-origin" src="http://127.0.0.1:' + port + '/"></iframe>');
  });
  await new Promise((resolve) => wrapper.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await new Promise((resolve) => wrapper.close(resolve)); await server.close(); doc.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const peers = [];
  const errors = [];
  for (const name of ['Ada', 'Bob']) {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await context.route('**/vendor/embedded-app-sdk.js', (route) => route.fulfill({ contentType: 'application/javascript', body: `window.__openedLinks=[]; window.DiscordEmbeddedAppSDK={DiscordSDK:class {platform='desktop';ready(){return Promise.resolve()} commands={authorize:async()=>({code:${JSON.stringify(name)}}),authenticate:async()=>({}),openExternalLink:async({url})=>{window.__openedLinks.push(url);return {opened:true}}}}};` }));
    const page = await context.newPage();
    page.on('pageerror', (e) => errors.push(name + ': ' + e.message));
    await page.goto('http://localhost:' + wrapper.address().port + '/');
    const frame = page.frames().find((f) => f.url().startsWith('http://127.0.0.1:'));
    await frame.waitForFunction(() => document.querySelector('#workshopRoster')?.textContent.includes(' (you)'));
    peers.push({ context, page, frame });
  }
  const [a, b] = peers.map((p) => p.frame);
  await a.waitForFunction(() => document.querySelector('#workshopRoster').textContent.includes('Bob'));
  const screenshot = async (name, page) => {
    if (!process.env.WORKSHOP_SCREENSHOT_DIR) return;
    fs.mkdirSync(process.env.WORKSHOP_SCREENSHOT_DIR, { recursive: true });
    await page.screenshot({ path: path.join(process.env.WORKSHOP_SCREENSHOT_DIR, name + '.png') });
  };

  await t.test('signal diagnostics identify loaded code, raw input and a rejected slow double-click', async () => {
    assert.match(await a.locator('#consoletextarea').textContent(), /Workshop signals \[diag-1\]: ready/);
    await cursor(a, 0);
    const line = a.locator('.cm-line').first();
    await line.click({ button: 'right', position: { x: 20, y: 8 } });
    await delay(550);
    await line.click({ button: 'right', position: { x: 20, y: 8 } });
    const log = await a.locator('#consoletextarea').textContent();
    assert.match(log, /pointerdown button=2.*region=code/);
    assert.match(log, /mousedown button=2.*region=code/);
    assert.match(log, /contextmenu button=2.*region=code/);
    assert.match(log, /gesture rejected:.*limit=400ms/);
    assert.equal(await a.locator('.ws-signal').count(), 0);
    await delay(450);
  });

  await t.test('sound buttons print a seed and play without touching the parent frame', async () => {
    for (let i = 0; i < 10; i++) await a.locator('#newsound' + i).click();
    await a.waitForFunction(() => document.querySelectorAll('#consoletextarea .cm-SOUND').length === 10, null, { timeout: 2000 });
    const seeds = await a.locator('#consoletextarea .cm-SOUND').allTextContents();
    assert.deepEqual(seeds.map((s) => Number(s) % 100), Array.from({ length: 10 }, (_, i) => i));
    assert.equal(errors.length, 0, errors.join('\n'));
  });

  await t.test('a line number in the console moves the cursor to that line without touching the parent frame', async () => {
    await cursor(a, 0);
    // As the engine prints a rule in its debug output: the rule's line number is a link.
    await a.evaluate(() => consolePrintFromRule('applied', { lineNumber: 40, direction: 1 }, true));
    await a.locator('#consoletextarea a').filter({ hasText: /^40$/ }).last().click();
    const line = await a.evaluate((code) => { const v = eval(code); return v.state.doc.lineAt(v.state.selection.main.head).number; }, viewCode);
    assert.equal(line, 40);
    assert.equal(errors.length, 0, errors.join('\n'));
  });

  await t.test('EXPORT offers immutable HTML and source download links in the console', async () => {
    await a.locator('#exportClickLink').click();
    await a.waitForFunction(() => document.querySelectorAll('#consoletextarea a.ws-download').length === 2, null, { timeout: 3000 });
    const links = await a.locator('#consoletextarea a.ws-download').evaluateAll((nodes) => nodes.map((n) => n.href));
    for (const link of links) {
      // The fixture's public URL has no known port until listen returns.
      const local = new URL(link); local.port = String(port);
      const result = await fetch(local);
      assert.equal(result.status, 200);
      assert.match(result.headers.get('content-disposition'), /^attachment;/);
      const body = await result.text();
      assert.ok(body.includes('navigation row 179'));
    }
    await a.locator('#consoletextarea a.ws-download').first().click();
    assert.equal((await a.evaluate(() => window.__openedLinks)).at(-1), links[0]);
  });

  await t.test('a cursor on the top row has its whole name inside the editor', async () => {
    await cursor(a, 0); await cursor(b, 0);
    await a.waitForFunction(() => document.querySelector('.ws-peer-name')?.textContent === 'Bob');
    await delay(100);
    const boxes = await a.evaluate(() => {
      const label = document.querySelector('.ws-peer-name').getBoundingClientRect();
      const editor = document.querySelector('.cm-scroller').getBoundingClientRect();
      return { top: label.top, bottom: label.bottom, left: label.left, right: label.right, editorTop: editor.top, editorBottom: editor.bottom, editorLeft: editor.left, editorRight: editor.right };
    });
    assert.ok(boxes.top >= boxes.editorTop && boxes.bottom <= boxes.editorBottom, JSON.stringify(boxes));
    assert.ok(boxes.left >= boxes.editorLeft && boxes.right <= boxes.editorRight, JSON.stringify(boxes));
    await screenshot('top-row-name', peers[0].page);
  });

  await t.test('clicking a roster name reveals their cursor without moving the local selection', async () => {
    await cursor(b, source.length - 1);
    await delay(500);
    await cursor(a, 0);
    await a.locator('#workshopRoster button').filter({ hasText: 'Bob' }).click({ timeout: 2000 });
    await a.waitForFunction((code) => eval(code).scrollDOM.scrollTop > 1000, viewCode, { timeout: 2000 });
    const state = await a.evaluate((code) => { const v = eval(code); return { head: v.state.selection.main.head, scroll: v.scrollDOM.scrollTop }; }, viewCode);
    assert.equal(state.head, 0);
    assert.ok(state.scroll > 1000, JSON.stringify(state));
  });

  await t.test('a single right-click does not signal; Shift-right-click retains the context menu', async () => {
    await cursor(a, 0);
    const result = await a.evaluate(() => {
      const line = document.querySelector('.cm-line');
      const box = line.getBoundingClientRect();
      const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: box.left + 20, clientY: box.top + 8 });
      line.dispatchEvent(event);
      const shifted = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, shiftKey: true });
      line.dispatchEvent(shifted);
      return [event.defaultPrevented, shifted.defaultPrevented];
    });
    assert.deepEqual(result, [true, false]);
    assert.equal(await a.locator('.ws-signal').count(), 0);
    await delay(450);
  });

  await t.test('double-right-click broadcasts a signal and an off-screen arrow that expires', async () => {
    await cursor(a, 0); await cursor(b, source.length - 1);
    const line = a.locator('.cm-line').first();
    await line.click({ button: 'right', position: { x: 20, y: 8 } });
    await line.click({ button: 'right', position: { x: 20, y: 8 } });
    await a.waitForFunction(() => document.querySelector('.ws-signal'), null, { timeout: 2500 });
    await b.waitForFunction(() => document.querySelector('.ws-signal-arrow'), null, { timeout: 2500 });
    await screenshot('offscreen-signal', peers[1].page);
    await b.locator('.ws-signal-arrow').first().click();
    await b.waitForFunction(() => document.querySelector('.ws-signal'), null, { timeout: 2000 });
    assert.equal(await b.locator('.ws-signal').first().textContent(), 'Ada');
    await screenshot('visible-signal', peers[1].page);
    await b.waitForFunction(() => !document.querySelector('.ws-signal') && !document.querySelector('.ws-signal-arrow'), null, { timeout: 6500 });
  });

  await t.test('an active signal follows concurrent document edits and navigation', async () => {
    await cursor(a, 0); await cursor(b, 0);
    const line = a.locator('.cm-line').first();
    await line.click({ button: 'right', position: { x: 40, y: 8 } });
    await line.click({ button: 'right', position: { x: 40, y: 8 } });
    await b.waitForFunction(() => document.querySelector('.ws-signal'), null, { timeout: 2500 });
    const before = await b.locator('.ws-signal').first().evaluate((el) => el.wsPosition);
    const inserted = '(inserted above the signal)\n';
    await a.evaluate(({ code, inserted }) => eval(code).dispatch({ changes: { from: 0, insert: inserted } }), { code: viewCode, inserted });
    await b.waitForFunction(({ pos, inserted }) => document.querySelector('.ws-signal')?.wsPosition === pos + inserted.length, { pos: before, inserted }, { timeout: 2500 });
    await cursor(b, source.length - 1);
    await b.waitForFunction(() => document.querySelector('.ws-signal-arrow'), null, { timeout: 2000 });
    await b.locator('.ws-signal-arrow').click();
    const after = await b.locator('.ws-signal').evaluate((el) => el.wsPosition);
    assert.equal(after, before + inserted.length);
  });

  await t.test('a fresh peer cursor is mapped through local pending edits before jumping', async () => {
    await cursor(b, 1); await cursor(a, 0); await delay(500);
    const held = [];
    await peers[0].context.route('**/api/workshop/push', (route) => { held.push(route); });
    const insert = '(pending local line)\n'.repeat(80);
    let result;
    try {
      await a.evaluate(({ code, insert }) => eval(code).dispatch({ changes: { from: 0, insert } }), { code: viewCode, insert });
      await cursor(b, 2); await delay(500);
      const before = await a.evaluate((code) => eval(code).state.selection.main.head, viewCode);
      await a.locator('#workshopRoster button').filter({ hasText: 'Bob' }).click();
      result = await a.evaluate(({ code, target }) => {
        const v = eval(code); const c = v.coordsAtPos(target); const r = v.scrollDOM.getBoundingClientRect();
        return { head: v.state.selection.main.head, expectedVisible: c && c.top >= r.top && c.bottom <= r.bottom, target, coords: c && { top: c.top, bottom: c.bottom }, bounds: { top: r.top, bottom: r.bottom } };
      }, { code: viewCode, target: insert.length + 2 });
      assert.equal(result.head, before);
    } finally {
      await peers[0].context.unroute('**/api/workshop/push');
      for (const route of held) await route.continue();
    }
    assert.ok(result.expectedVisible, JSON.stringify(result));
  });

  await t.test('right-button presses signal even when contextmenu events are intercepted', async () => {
    await cursor(a, 0); await cursor(b, source.length - 1); await delay(650);
    const sent = [];
    const onRequest = (request) => { if (request.url().endsWith('/api/workshop/signal')) sent.push(request); };
    peers[0].page.on('request', onRequest);
    try {
      await a.evaluate(() => {
        const line = document.querySelector('.cm-line');
        const r = line.getBoundingClientRect();
        // Discord/desktop context menus need not dispatch a DOM contextmenu event at all.
        for (let i = 0; i < 2; i++) {
          line.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, button: 2, clientX: r.left + 32, clientY: r.top + 8 }));
          line.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 2, clientX: r.left + 32, clientY: r.top + 8 }));
        }
      });
      await delay(250);
      assert.equal(sent.length, 1, 'one signal should be sent from two right-button presses');
      await b.waitForFunction(() => document.querySelector('.ws-signal-arrow'), null, { timeout: 1500 });
    } finally { peers[0].page.off('request', onRequest); }
  });

  await t.test('the sender sees an immediate signal while its request is still pending', async () => {
    await cursor(a, 0); await delay(650);
    let held;
    let arrived;
    const started = new Promise((resolve) => { arrived = resolve; });
    await peers[0].context.route('**/api/workshop/signal', (route) => { held = route; arrived(); });
    let visible;
    try {
      const line = a.locator('.cm-line').first();
      await line.click({ button: 'right', position: { x: 64, y: 8 } });
      await line.click({ button: 'right', position: { x: 64, y: 8 } });
      await Promise.race([started, delay(2000).then(() => { throw new Error('signal request did not start'); })]);
      await delay(50);
      visible = await a.locator('.ws-signal').evaluateAll((nodes) => nodes.some((n) => n.wsPosition < 100 && n.dataset.pending === 'true'));
      // An unrelated peer move causes a poll while this request is still held.
      await cursor(b, 10); await delay(500);
      assert.equal(await a.locator('.ws-signal[data-pending="true"]').count(), 1);
    } finally {
      await peers[0].context.unroute('**/api/workshop/signal');
      if (held) await held.continue();
    }
    assert.equal(visible, true, 'sender feedback must not wait for the server or the next poll');
    await a.waitForFunction(() => document.querySelector('.ws-signal[data-pending="false"]')?.textContent === 'Ada', null, { timeout: 2500 });
    assert.equal(await a.locator('.ws-signal').count(), 1, 'broadcast and acknowledgement reconcile with the local preview');
  });

  await t.test('a rejected signal gives visible feedback to the sender', async () => {
    await cursor(a, 0); await delay(650);
    await peers[0].context.route('**/api/workshop/signal', (route) => route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: 'the document has changed' }) }));
    try {
      const line = a.locator('.cm-line').first();
      await line.click({ button: 'right', position: { x: 80, y: 8 } });
      await line.click({ button: 'right', position: { x: 80, y: 8 } });
      await a.waitForFunction(() => [...document.querySelectorAll('.ws-signal')].some((n) => n.textContent.includes('not sent')), null, { timeout: 2000 });
      assert.match(await a.locator('#consoletextarea').textContent(), /signal was not sent.*document has changed/);
    } finally { await peers[0].context.unroute('**/api/workshop/signal'); }
  });

  await t.test('signaling after typing waits for sync and gives both users a full broadcast lifetime', async () => {
    await cursor(a, 0); await cursor(b, 0); await delay(650);
    const held = [];
    await peers[0].context.route('**/api/workshop/push', (route) => { held.push(route); });
    const sent = [];
    const onRequest = (request) => { if (request.url().endsWith('/api/workshop/signal')) sent.push(request); };
    peers[0].page.on('request', onRequest);
    try {
      await a.evaluate((code) => eval(code).dispatch({ changes: { from: 0, insert: '(signal sync test)\n' } }), viewCode);
      const line = a.locator('.cm-line').first();
      await line.click({ button: 'right', position: { x: 48, y: 8 } });
      await line.click({ button: 'right', position: { x: 48, y: 8 } });
      await a.waitForFunction(() => document.querySelector('.ws-signal[data-pending="true"]'), null, { timeout: 1000 });
      await delay(1500);
      assert.equal(sent.length, 0, 'signal must wait for the edited document version');
    } finally {
      await peers[0].context.unroute('**/api/workshop/push');
      for (const route of held) await route.continue();
      peers[0].page.off('request', onRequest);
    }
    await a.waitForFunction(() => document.querySelector('.ws-signal[data-pending="false"]')?.textContent === 'Ada', null, { timeout: 2500 });
    await b.waitForFunction(() => document.querySelector('.ws-signal')?.textContent === 'Ada', null, { timeout: 2500 });
    await delay(4100);
    assert.equal(await a.locator('.ws-signal').count(), 1, 'sender gets five seconds after acceptance, even after waiting for sync');
    assert.equal(await b.locator('.ws-signal').count(), 1);
  });

  await t.test('a late rejection still leaves a visible failure marker', async () => {
    await cursor(a, 0); await delay(650);
    let held;
    await peers[0].context.route('**/api/workshop/signal', (route) => { held = route; });
    try {
      const line = a.locator('.cm-line').first();
      await line.click({ button: 'right', position: { x: 80, y: 8 } });
      await line.click({ button: 'right', position: { x: 80, y: 8 } });
      await delay(5500);
      assert.ok(held);
      await held.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: 'the document has changed' }) });
      await a.waitForFunction(() => [...document.querySelectorAll('.ws-signal')].some((n) => n.textContent.includes('not sent')), null, { timeout: 1000 });
    } finally { await peers[0].context.unroute('**/api/workshop/signal'); }
  });

  await t.test('a delivered broadcast stays confirmed after the marker expires, even if its POST response is lost', async () => {
    await cursor(a, 0); await delay(650);
    let held;
    let response;
    await peers[0].context.route('**/api/workshop/signal', async (route) => { held = route; response = await route.fetch(); });
    try {
      const line = a.locator('.cm-line').first();
      await line.click({ button: 'right', position: { x: 80, y: 8 } });
      await line.click({ button: 'right', position: { x: 80, y: 8 } });
      await a.waitForFunction(() => document.querySelector('.ws-signal[data-pending="false"]')?.textContent === 'Ada', null, { timeout: 2000 });
      await delay(10500);
      assert.equal(await a.locator('.ws-signal').count(), 0);
      assert.doesNotMatch(await a.locator('#consoletextarea').textContent(), /request timed out/);
    } finally {
      await peers[0].context.unroute('**/api/workshop/signal');
      if (held && response) await held.fulfill({ response }).catch(() => {});
    }
  });

  await t.test('broadcast diagnostics still appear when the POST acknowledgement arrives first', async () => {
    await cursor(a, 0); await cursor(b, 0); await delay(650);
    const originalNudge = doc.nudge;
    doc.nudge = () => setTimeout(() => originalNudge(), 400);
    try {
      const line = a.locator('.cm-line').first();
      await line.click({ button: 'right', position: { x: 80, y: 8 } });
      await line.click({ button: 'right', position: { x: 80, y: 8 } });
      await a.waitForFunction(() => document.querySelector('#consoletextarea').textContent.includes('POST response HTTP 200'), null, { timeout: 2000 });
      await a.waitForFunction(() => document.querySelector('.ws-signal[data-pending="false"]')?.textContent === 'Ada', null, { timeout: 2000 });
      await delay(600);
      const log = await a.locator('#consoletextarea').textContent();
      assert.ok(log.lastIndexOf('broadcast received for your signal') > log.lastIndexOf('POST response HTTP 200'), 'both acknowledgement and later broadcast must be logged');
    } finally { doc.nudge = originalNudge; }
  });

  await t.test('no uncaught browser errors', () => assert.deepEqual(errors, []));
});
