'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createGallerySync } = require('../gallery-sync');

const GUILD = '1557028386633678848';
const RELEASES = '1562643319341715486';
const record = (id = 'aa11', title = 'A game') => ({ url: 'https://author.itch.io/' + id, source: 'https://www.puzzlescript.net/editor.html?hack=' + id, title, author: 'Ann' });
const script = (records = [record()]) => '// gallery data\nlet games_gallery = [\n' + records.map((r) => JSON.stringify(r)).join(',\n') + ',\n]\n';
const thread = (extra = {}) => ({ guildId: GUILD, parentId: RELEASES, ...extra });

function fixture(t, options = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'psbot-gallery-sync-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const updates = [], logs = [], requests = [];
  const service = createGallerySync({
    dataDir, guildId: GUILD, releasesChannelId: RELEASES,
    onRefresh: (gallery) => updates.push(gallery),
    log: (...args) => logs.push(args.join(' ')),
    fetchImpl: async (url, opts) => { requests.push({ url, opts }); return new Response(script()); },
    ...options,
  });
  return { service, dataDir, file: path.join(dataDir, 'gallery.json'), updates, logs, requests };
}

test('refresh reads the public list, resolves sources, and atomically caches its records', async (t) => {
  const { service, file, dataDir, updates, requests } = fixture(t);
  assert.equal(await service.refresh(), true);
  assert.equal(requests[0].url, 'https://www.puzzlescript.net/games_dat.js');
  assert.ok(requests[0].opts.signal instanceof AbortSignal);
  assert.deepEqual(updates, [[{ gistId: 'aa11', title: 'A game', author: 'Ann', starred: true }]]);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), [record()]);
  assert.deepEqual(fs.readdirSync(dataDir), ['gallery.json']);
});

test('restart restores the last good gallery without needing a successful fetch', async (t) => {
  const { service, file, updates } = fixture(t, { fetchImpl: async () => { throw new Error('offline'); } });
  fs.writeFileSync(file, JSON.stringify([record('bb22', 'Cached game')]));
  assert.equal(service.restore(), true);
  assert.equal(await service.refresh(), false);
  assert.equal(updates.length, 1);
  assert.equal(updates[0][0].title, 'Cached game');
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8'))[0].title, 'Cached game');
});

test('a missing or corrupt cache leaves the bundled startup list alone', (t) => {
  const { service, file, updates } = fixture(t);
  assert.equal(service.restore(), false);
  fs.writeFileSync(file, 'broken JSON');
  assert.equal(service.restore(), false);
  fs.writeFileSync(file, JSON.stringify([]));
  assert.equal(service.restore(), false);
  assert.deepEqual(updates, []);
});

test('only a newly created thread in the configured releases channel and guild refreshes', async (t) => {
  const { service, requests } = fixture(t);
  for (const [candidate, isNew] of [
    [thread(), false], [thread(), undefined], [thread({ parentId: 'other' }), true],
    [thread({ guildId: 'other' }), true], [null, true],
  ]) assert.equal(await service.onThread(candidate, isNew), false);
  assert.equal(requests.length, 0);
  assert.equal(await service.onThread(thread(), true), true);
  assert.equal(requests.length, 1);
});

test('a release during an earlier refresh gets its own later fetch', async (t) => {
  let finishFirst;
  const firstResponse = new Promise((resolve) => { finishFirst = resolve; });
  let calls = 0;
  const { service, updates } = fixture(t, { fetchImpl: async () => {
    calls++;
    return calls === 1 ? firstResponse : new Response(script([record('bb22', 'New release')]));
  } });
  const first = service.refresh();
  await new Promise((resolve) => setImmediate(resolve));
  const release = service.onThread(thread(), true);
  assert.equal(calls, 1);
  finishFirst(new Response(script()));
  assert.equal(await first, true);
  assert.equal(await release, true);
  assert.equal(calls, 2);
  assert.deepEqual(updates.map((g) => g[0].title), ['A game', 'New release']);
});

test('HTTP and network failures keep the previous cache and allow the next release to retry', async (t) => {
  const responses = [new Error('offline'), new Response('unavailable', { status: 503 }), new Response(script([record('bb22')]))];
  const { service, file, updates, logs } = fixture(t, { fetchImpl: async () => {
    const response = responses.shift();
    if (response instanceof Error) throw response;
    return response;
  } });
  fs.writeFileSync(file, JSON.stringify([record()]));
  const previous = fs.readFileSync(file, 'utf8');
  assert.equal(await service.refresh(), false);
  assert.equal(await service.onThread(thread(), true), false);
  assert.equal(fs.readFileSync(file, 'utf8'), previous);
  assert.equal(updates.length, 0);
  assert.equal(logs.filter((s) => s.includes('failed')).length, 2);
  assert.equal(await service.onThread(thread(), true), true);
  assert.equal(updates[0][0].gistId, 'bb22');
});

test('invalid, empty, oversized and executable downloaded scripts never replace a good list', async (t) => {
  const invalid = [
    '<html>error</html>', 'let games_gallery = [];', script([null]),
    script([{ ...record(), title: 42 }]),
    script([{ ...record(), source: undefined }]),
    script() + '\nthrow new Error("EXECUTED");',
    script([{ ...record(), title: 'é'.repeat(500_000) }]),
  ];
  const { service, file, updates } = fixture(t, { fetchImpl: async () => new Response(invalid.shift()) });
  fs.writeFileSync(file, JSON.stringify([record('cc33')]));
  const previous = fs.readFileSync(file, 'utf8');
  while (invalid.length) {
    assert.equal(await service.refresh(), false);
    assert.equal(fs.readFileSync(file, 'utf8'), previous);
  }
  assert.equal(updates.length, 0);
});

test('JSON strings with commas, brackets and semicolons survive the declaration parser', async (t) => {
  const title = 'Game, ]; "quotes" \\ newline\n';
  const { service, updates } = fixture(t, { fetchImpl: async () => new Response('// header\nconst games_gallery = ' + JSON.stringify([record('aa11', title)]) + ';\n') });
  assert.equal(await service.refresh(), true);
  assert.equal(updates[0][0].title, title);
});

test('cache-write failure leaves the current suggestions alone', async (t) => {
  const { service, file, updates, logs } = fixture(t);
  fs.mkdirSync(file + '.tmp');
  assert.equal(await service.refresh(), false);
  assert.equal(updates.length, 0);
  assert.equal(fs.existsSync(file), false);
  assert.ok(logs.some((s) => s.includes('failed')));
});
