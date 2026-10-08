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

test('loading shared games in a Discord-like frame', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'workshop-browser-'));
  const doc = createWorkshopDoc({ dataDir: dir });
  const saves = createWorkshopSaves({ dataDir: dir, maxEntries: 3, now: () => Date.UTC(2026, 9, 8, 12) });
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
  for (const peer of peers) peer.page.setDefaultTimeout(4000);
  const [a, b] = peers.map((p) => p.frame);
  await a.waitForFunction(() => document.querySelector('#workshopRoster').textContent.includes('Bob'));
  const text = (frame) => frame.evaluate(() => editor.getValue());
  const insert = (frame, value) => frame.evaluate(({ code, value }) => eval(code).dispatch({ changes: { from: 0, insert: value } }), { code: viewCode, value });
  const synced = async () => { const expected = await text(a); await b.waitForFunction((value) => editor.getValue() === value, expected); return expected; };
  const dialog = a.getByRole('dialog');
  const load = async (example = 'blank') => {
    await a.locator('#exampleDropdown').selectOption(example);
    await dialog.waitFor({ state: 'visible', timeout: 2000 });
    assert.match(await dialog.textContent(), /everyone/i);
  };
  const accept = () => dialog.getByRole('button', { name: 'Save current game & load', exact: true }).click();
  const settled = () => a.waitForFunction(() => !document.querySelector('#exampleDropdown').disabled);

  await t.test('Cancel and Escape preserve an edited shared game without saving', async () => {
    await insert(a, '(unsaved edit)\n');
    const before = await synced();
    const rev = saves.get().rev;
    await load();
    if (process.env.WORKSHOP_SCREENSHOT_DIR) {
      fs.mkdirSync(process.env.WORKSHOP_SCREENSHOT_DIR, { recursive: true });
      await peers[0].page.screenshot({ path: path.join(process.env.WORKSHOP_SCREENSHOT_DIR, 'loading-dialog.png') });
    }
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    await settled();
    assert.equal(await text(a), before);
    assert.equal(saves.get().rev, rev);
    assert.equal(await a.evaluate(() => _editorDirty), true);
    await load();
    await a.locator('dialog').press('Escape');
    await settled();
    assert.equal(await text(a), before);
    assert.equal(saves.get().rev, rev);
  });

  await t.test('a successful load saves the current shared text before replacing it for both editors', async () => {
    const before = await synced();
    await load();
    await accept();
    await settled();
    const expected = fs.readFileSync(path.join(labs, 'src/demo/blank.txt'), 'utf8');
    await a.waitForFunction((value) => editor.getValue() === value, expected);
    await synced();
    assert.equal(saves.get().saves.at(-1).text, before);
    assert.equal(await text(b), expected);
    assert.equal(await a.evaluate(() => _editorDirty), false);
  });

  await t.test('even a clean shared game asks before replacing the room document', async () => {
    const before = await synced();
    assert.equal(await a.evaluate(() => _editorDirty), false);
    await load('sokoban_basic');
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    await settled();
    assert.equal(await text(a), before);
  });

  await t.test('a failed save reports the error and keeps the edited game', async () => {
    await insert(a, '(keep me after failed save)\n');
    const before = await synced();
    await peers[0].context.route('**/api/workshop/saves', (route) => route.request().method() === 'POST'
      ? route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'disk full' }) }) : route.continue());
    try {
      await load('sokoban_basic'); await accept(); await settled();
      assert.equal(await text(a), before);
      assert.equal(await a.evaluate(() => _editorDirty), true);
      assert.match(await a.locator('#consoletextarea').textContent(), /not loaded.*disk full/i);
    } finally { await peers[0].context.unroute('**/api/workshop/saves'); }
  });

  await t.test('a missing example reports an error without changing or saving the game', async () => {
    const before = await synced(); const rev = saves.get().rev;
    await peers[0].context.route('**/demo/sokoban_basic.txt', (route) => route.fulfill({ status: 404, body: 'missing' }));
    try {
      await load('sokoban_basic'); await accept(); await settled();
      assert.equal(await text(a), before);
      assert.equal(saves.get().rev, rev);
      assert.match(await a.locator('#consoletextarea').textContent(), /not loaded.*404/i);
    } finally { await peers[0].context.unroute('**/demo/sokoban_basic.txt'); }
  });

  await t.test('edits arriving during a delayed save are kept and prevent replacement', async () => {
    const before = await synced();
    let held; let notify;
    const started = new Promise((resolve) => { notify = resolve; });
    await peers[0].context.route('**/api/workshop/saves', (route) => {
      if (route.request().method() !== 'POST') return route.continue();
      held = route; notify();
    });
    try {
      await load('sokoban_basic'); await accept();
      await Promise.race([started, delay(2000).then(() => { throw new Error('save did not start'); })]);
      assert.equal(await text(a), before);
      assert.equal(await a.locator('#exampleDropdown').isDisabled(), true);
      await insert(b, '(new edit while saving)\n');
      const changed = await text(b);
      await a.waitForFunction((value) => editor.getValue() === value, changed);
      await held.continue(); held = null;
      await settled();
      assert.equal(await text(a), changed);
      assert.equal(saves.get().saves.at(-1).text, before);
      assert.match(await a.locator('#consoletextarea').textContent(), /changed.*try again/i);
    } finally {
      await peers[0].context.unroute('**/api/workshop/saves');
      if (held) await held.continue();
    }
  });

  await t.test('loading a room save preserves its selected text when backup refreshes the dropdown', async () => {
    const target = source;
    saves.add('saves', { title: 'Saved target', text: target });
    // A shared edit wakes the pull, which brings the new room save revision.
    await insert(a, '(wake save-list refresh)\n');
    await synced();
    await a.waitForFunction(() => [...document.querySelector('#loadDropDown').options].some((o) => o.textContent.includes('Saved target')), null, { timeout: 4000 });
    const before = await synced();
    await a.locator('#loadDropDown').selectOption({ label: await a.locator('#loadDropDown option').filter({ hasText: 'Saved target' }).textContent() });
    await dialog.waitFor({ state: 'visible', timeout: 2000 });
    await accept(); await settled();
    await a.waitForFunction((value) => editor.getValue() === value, target);
    await synced();
    assert.equal(saves.get().saves.at(-1).text, before);
    assert.equal(await text(b), target);
  });

  await t.test('two saves with the same visible timestamp and title load the selected entry', async () => {
    const older = source + '\n(older duplicate)';
    const newer = source + '\n(newer duplicate)';
    saves.add('saves', { title: 'Duplicate', text: older });
    saves.add('saves', { title: 'Duplicate', text: newer });
    await insert(a, '(wake duplicate list)\n'); await synced();
    await a.waitForFunction(() => [...document.querySelector('#loadDropDown').options].filter((o) => o.textContent.includes('Duplicate')).length === 2);
    const index = await a.locator('#loadDropDown').evaluate((select) => [...select.options].findIndex((o) => o.textContent.includes('Duplicate')));
    await a.locator('#loadDropDown').selectOption({ index });
    await dialog.waitFor({ state: 'visible' }); await accept(); await settled();
    assert.equal(await text(a), newer);
  });

  await t.test('the selected oldest save can load even when its backup evicts it from a full list', async () => {
    for (let i = 0; i < 3; i++) saves.add('saves', { title: 'Bounded ' + i, text: source + '\n(bounded ' + i + ')' });
    const target = saves.get().saves[0].text;
    await insert(a, '(wake full list)\n'); await synced();
    await a.waitForFunction(() => [...document.querySelector('#loadDropDown').options].some((o) => o.textContent.includes('Bounded 0')));
    const label = await a.locator('#loadDropDown option').filter({ hasText: 'Bounded 0' }).textContent();
    await a.locator('#loadDropDown').selectOption({ label });
    await dialog.waitFor({ state: 'visible' }); await accept(); await settled();
    assert.equal(await text(a), target);
    assert.equal(saves.get().saves.some((entry) => entry.text === target), false);
  });

  assert.equal(errors.length, 0, errors.join('\n'));
});
