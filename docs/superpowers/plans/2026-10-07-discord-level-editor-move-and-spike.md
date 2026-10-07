# Discord level editor, part 1: move and spike — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run the Discord bot on the increpare.com server, then prove that a web page served by the bot opens as a Discord Activity in the real PuzzleScript server and can do what the level editor will need.

**Architecture:** The bot process moves unchanged from the Pi to `locus@95.211.62.202`. It then gains a small HTTP server on `127.0.0.1:8787`, which Caddy exposes at `https://games.increpare.com/puzzlescriptbot/app/`. A pencil button on game messages, shown only in the beta channel, answers with Discord's `LAUNCH_ACTIVITY`. The page it opens is a throwaway probe that reports what works back to the bot's log.

**Tech Stack:** Node 24 (server) and 18+ compatible code, discord.js 14.27, node's `http`, `node:test`, Caddy, systemd user units, `@discord/embedded-app-sdk` 2.5.0 bundled with esbuild 0.28.2.

**Spec:** `docs/superpowers/specs/2026-10-07-discord-level-editor-design.md` (build steps 1 and 2).

## Global Constraints

- No new runtime dependencies. `discord-bot/package.json` keeps `discord.js` as its only dependency.
- The HTTP server listens on `127.0.0.1` only. Request bodies are JSON, 64 KB at most.
- `TWEAK_CHANNEL_IDS` unset means the pencil button appears nowhere. During the beta it names only the private `#mapeditor-test` channel. Nothing in this plan may show the button, or launch the Activity, anywhere else.
- The bot on the Pi and the bot on the server must never run at the same time.
- Secrets (`DISCORD_TOKEN`, `GITHUB_TOKEN`, `DISCORD_CLIENT_SECRET`) are never printed, logged or committed. Steps that move or type them are marked **USER** and are done by the user.
- Steps marked **USER (root)** need root on the server; `locus` has none.
- Tests run with `cd discord-bot && npm test`. Match the existing style: `'use strict'`, `node:test`, `node:assert`, two-space indent, comments that say why.
- Commit after each task, on the branch `discord-level-editor`. End commit messages with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Code marked "spike" is throwaway and is removed by the next plan: `activity/index.html`, `activity/spike.js`, and the `/api/ping` and `/api/spike-report` routes.

Hosts: the server is `locus@95.211.62.202` (node at `~/.local/bin/node`). The Pi is `box@192.168.178.69` and is reachable only from the home network.

---

## Part A — Move the bot to the server

### Task 1: The tests pass on Node 24

No code changes. This is a check, made on the server because the Mac has Node 25 and the Pi Node 18.

- [ ] **Step 1: Copy the bot, the engine and the test data to a scratch directory on the server**

```bash
cd /Users/stephenlavelle/Documents/GitHub/PuzzleScript-bots
ssh locus@95.211.62.202 'mkdir -p ~/psbot-node24-check/puzzlescript/src/tests ~/psbot-node24-check/discord-bot'
rsync -az --delete --exclude node_modules --exclude data --exclude .env discord-bot/ locus@95.211.62.202:psbot-node24-check/discord-bot/
rsync -az --delete puzzlescript/src/js puzzlescript/src/demo puzzlescript/src/games_dat.js locus@95.211.62.202:psbot-node24-check/puzzlescript/src/
rsync -az --delete puzzlescript/src/tests/resources locus@95.211.62.202:psbot-node24-check/puzzlescript/src/tests/
```

- [ ] **Step 2: Run the tests there**

```bash
ssh locus@95.211.62.202 'export PATH="$HOME/.local/bin:$PATH" && cd ~/psbot-node24-check/discord-bot && npm ci --no-audit --no-fund >/dev/null && node -v && node --test 2>&1 | tail -12'
```

Expected: `v24.21.0`, then a summary ending with `# fail 0`.

If a test fails, stop and fix it before going on: the failure is a real difference between Node versions and the fix belongs in this task, with the test run repeated on both the Mac (`npm test`) and the server.

- [ ] **Step 3: Remove the scratch directory**

```bash
ssh locus@95.211.62.202 'rm -rf ~/psbot-node24-check'
```

### Task 2: Deploy script and service unit for the server

**Files:**
- Modify: `discord-bot/deploy.sh`
- Modify: `discord-bot/puzzlescript-bot.service`
- Modify: `discord-bot/README.md`

**Interfaces:**
- Produces: `./discord-bot/deploy.sh` deploys to `locus@95.211.62.202:~/puzzlescript-bot/`. `PSBOT_NO_START=1` syncs and installs without touching the service.

- [ ] **Step 1: Replace `discord-bot/deploy.sh`**

```bash
#!/usr/bin/env bash
# discord-bot/deploy.sh — sync the engine and bot to the server and restart the user service.
# PSBOT_NO_START=1 syncs and installs but leaves the service alone (for the first install, before .env exists).
set -euo pipefail
HOST="${PSBOT_HOST:-locus@95.211.62.202}"
DEST="${PSBOT_DEST:-puzzlescript-bot}"
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
# The engine comes from the puzzlescript submodule, or from the checkout named by PUZZLESCRIPT_DIR.
PS="${PUZZLESCRIPT_DIR:-$ROOT/puzzlescript}"
[ -f "$PS/src/js/engine.js" ] || { echo "No engine in $PS/src — run: git submodule update --init" >&2; exit 1; }
# Node is installed in the home directory on the server (there is no root there), which a
# non-login shell does not have on its PATH.
REMOTE_PATH='export PATH="$HOME/.local/bin:$PATH"'

ssh "$HOST" "mkdir -p ~/$DEST/puzzlescript/src ~/$DEST/discord-bot ~/.config/systemd/user"
rsync -az --delete "$PS/src/js/" "$HOST:~/$DEST/puzzlescript/src/js/"
rsync -az "$PS/src/games_dat.js" "$HOST:~/$DEST/puzzlescript/src/games_dat.js"
rsync -az --delete --exclude node_modules --exclude data --exclude .env "$HERE/" "$HOST:~/$DEST/discord-bot/"
ssh "$HOST" "$REMOTE_PATH && cd ~/$DEST/discord-bot && npm ci --omit=dev --no-audit --no-fund \
  && cp puzzlescript-bot.service ~/.config/systemd/user/ \
  && systemctl --user daemon-reload"
if [ "${PSBOT_NO_START:-}" = "1" ]; then
  echo "synced; the service was not started (PSBOT_NO_START=1)"
  exit 0
fi
ssh "$HOST" "systemctl --user enable puzzlescript-bot >/dev/null \
  && systemctl --user restart puzzlescript-bot \
  && sleep 2 && systemctl --user is-active --quiet puzzlescript-bot && systemctl --user --no-pager status puzzlescript-bot | head -5"
```

- [ ] **Step 2: Replace `discord-bot/puzzlescript-bot.service`**

```ini
[Unit]
Description=PuzzleScript Discord play bot
After=network-online.target

[Service]
WorkingDirectory=%h/puzzlescript-bot/discord-bot
# node may be in the home directory (the server, which has no root) or system-wide
Environment=PATH=%h/.local/bin:/usr/local/bin:/usr/bin:/bin
ExecStart=/usr/bin/env node bot.js
Restart=on-failure
RestartSec=5
Environment=NODE_ENV=production

[Install]
WantedBy=default.target
```

- [ ] **Step 3: Update `discord-bot/README.md`**

Replace the paragraph under `## Layout`:

```markdown
The bot loads the engine from `../puzzlescript/src/js`, the PuzzleScript
submodule at the root of this repository (see the README there). `deploy.sh`
syncs both to `~/puzzlescript-bot/` on the increpare.com server
(`locus@95.211.62.202`).
```

In `## Setup (once)`, replace items 2 to 4:

```markdown
2. On the server: `cp .env.example .env` in `~/puzzlescript-bot/discord-bot/` and
   fill in the keys. `DISCORD_GUILD_ID` is the server id.
3. `node register-commands.js` once (on the server or locally with the same `.env`).
4. So that the service survives logout and reboot, as root: `loginctl enable-linger locus`.

Node is installed in `locus`'s home directory (`~/.local/bin/node`), because
that account has no root. In a shell there, put it on the path first:
`export PATH="$HOME/.local/bin:$PATH"`.
```

- [ ] **Step 4: Check the script parses**

Run: `bash -n discord-bot/deploy.sh && echo ok`
Expected: `ok`

- [ ] **Step 5: Commit**

```bash
git add discord-bot/deploy.sh discord-bot/puzzlescript-bot.service discord-bot/README.md
git commit -m "discord-bot: deploy to the increpare.com server instead of the Pi"
```

### Task 3: Cutover

No code changes. The order matters: the Pi's bot stops before the server's starts.

- [ ] **Step 1: First install on the server, without starting**

```bash
PSBOT_NO_START=1 ./discord-bot/deploy.sh
```

Expected: ends with `synced; the service was not started (PSBOT_NO_START=1)`.

- [ ] **Step 2 (USER): Copy `.env` from the Pi to the server**

The file holds the bot's tokens, so the user runs this. It goes Pi → Mac → server without being shown.

```bash
scp -3 box@192.168.178.69:puzzlescript-bot/discord-bot/.env locus@95.211.62.202:puzzlescript-bot/discord-bot/.env
```

```bash
ssh locus@95.211.62.202 'chmod 600 ~/puzzlescript-bot/discord-bot/.env'
```

- [ ] **Step 3 (USER, root): Let the service outlive a logout**

As root on the server:

```bash
loginctl enable-linger locus
```

Check, as `locus`: `loginctl show-user locus -p Linger` prints `Linger=yes`.

- [ ] **Step 4: Stop the bot on the Pi**

```bash
ssh box@192.168.178.69 'systemctl --user stop puzzlescript-bot && systemctl --user is-active puzzlescript-bot || true'
```

Expected: `inactive`.

- [ ] **Step 5: Copy the data across**

```bash
T="$(mktemp -d)" && rsync -az box@192.168.178.69:puzzlescript-bot/discord-bot/data/ "$T/data/" && rsync -az "$T/data/" locus@95.211.62.202:puzzlescript-bot/discord-bot/data/ && rm -rf "$T"
```

- [ ] **Step 6: Start the bot on the server**

```bash
./discord-bot/deploy.sh
```

Then:

```bash
ssh locus@95.211.62.202 'journalctl --user -u puzzlescript-bot -n 15 --no-pager'
```

Expected: a line `loaded <n> games ...` with n above zero, and `logged in as PuzzleScriptBot#...`.

- [ ] **Step 7 (USER): Try it in Discord**

`/play` a game and press a few buttons. Press a button on a game that was started before the move. Both must work.

If they do not: `ssh locus@95.211.62.202 'systemctl --user stop puzzlescript-bot'`, then `ssh box@192.168.178.69 'systemctl --user start puzzlescript-bot'`, and investigate with the Pi serving again.

- [ ] **Step 8: Retire the Pi's copy**

```bash
ssh box@192.168.178.69 'systemctl --user disable puzzlescript-bot'
```

The files stay on the Pi as a fallback. The Twitch bot there has its own directory and is not touched.

---

## Part B — Spike

### Task 4: Settings for the Activity

**Files:**
- Create: `discord-bot/tweaks.js`
- Create: `discord-bot/test/tweaks.test.js`
- Modify: `discord-bot/config.js`
- Modify: `discord-bot/test/config.test.js`
- Modify: `discord-bot/.env.example`

**Interfaces:**
- Produces: `parseTweakChannels(value: string|undefined) → string[] | '*'` and `tweakAllowed(channels: string[] | '*', channelId: string, parentId: string|null) → boolean` from `tweaks.js`.
- Produces: `loadConfig()` gains `clientSecret: string|null`, `httpPort: number` (default 8787) and `tweakChannels: string[] | '*'`.

- [ ] **Step 1: Write the failing tests**

Create `discord-bot/test/tweaks.test.js`:

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { parseTweakChannels, tweakAllowed } = require('../tweaks');

test('unset means nowhere, a list means those channels, a star means everywhere', () => {
  assert.deepEqual(parseTweakChannels(undefined), []);
  assert.deepEqual(parseTweakChannels('  '), []);
  assert.deepEqual(parseTweakChannels('111, 222 ,'), ['111', '222']);
  assert.equal(parseTweakChannels(' * '), '*');
});

test('a channel is allowed by its own id or by its parent, for a thread', () => {
  assert.equal(tweakAllowed([], '111', null), false);
  assert.equal(tweakAllowed(['111'], '111', null), true);
  assert.equal(tweakAllowed(['111'], '999', '111'), true);
  assert.equal(tweakAllowed(['111'], '999', '888'), false);
  assert.equal(tweakAllowed(['111'], '999', null), false);
  assert.equal(tweakAllowed('*', '999', null), true);
});
```

Append to `discord-bot/test/config.test.js`:

```js
test('activity settings are optional and have safe defaults', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'psbot-cfg-'));
  const file = path.join(dir, '.env');
  const base = 'DISCORD_TOKEN=abc\nDISCORD_APP_ID=1\nDISCORD_GUILD_ID=2\nGITHUB_TOKEN=ghp\n';
  fs.writeFileSync(file, base);
  let cfg = loadConfig(file);
  assert.equal(cfg.clientSecret, null);
  assert.equal(cfg.httpPort, 8787);
  assert.deepEqual(cfg.tweakChannels, []);
  fs.writeFileSync(file, base + 'DISCORD_CLIENT_SECRET=shh\nHTTP_PORT=9000\nTWEAK_CHANNEL_IDS=111,222\n');
  cfg = loadConfig(file);
  assert.equal(cfg.clientSecret, 'shh');
  assert.equal(cfg.httpPort, 9000);
  assert.deepEqual(cfg.tweakChannels, ['111', '222']);
  fs.writeFileSync(file, base + 'HTTP_PORT=nope\n');
  assert.throws(() => loadConfig(file), /HTTP_PORT/);
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `cd discord-bot && node --test test/tweaks.test.js test/config.test.js`
Expected: FAIL, `Cannot find module '../tweaks'` and `cfg.httpPort` undefined.

- [ ] **Step 3: Create `discord-bot/tweaks.js`**

```js
'use strict';

// Where the Tweak (level editor) button may appear, from TWEAK_CHANNEL_IDS.
// Unset: nowhere, so that an unfinished editor never shows by accident.
// A comma-separated list of channel ids: those channels, and threads under them.
// "*": everywhere.
function parseTweakChannels(value) {
  const s = String(value || '').trim();
  if (!s) return [];
  if (s === '*') return '*';
  return s.split(',').map((x) => x.trim()).filter(Boolean);
}

// parentId is the channel a thread belongs to, or null for an ordinary channel.
function tweakAllowed(channels, channelId, parentId) {
  if (channels === '*') return true;
  return channels.includes(channelId) || (!!parentId && channels.includes(parentId));
}

module.exports = { parseTweakChannels, tweakAllowed };
```

- [ ] **Step 4: Extend `discord-bot/config.js`**

Add after the existing `require` lines:

```js
const { parseTweakChannels } = require('./tweaks');
```

In `loadConfig`, after the `missing` check and before `return`, add:

```js
  const httpPort = env.HTTP_PORT ? Number(env.HTTP_PORT) : 8787;
  if (!Number.isInteger(httpPort) || httpPort < 1 || httpPort > 65535) throw new Error('HTTP_PORT must be a port number');
```

and add these three keys to the returned object:

```js
    // The level editor Activity: without the client secret the http server is not started at all.
    clientSecret: env.DISCORD_CLIENT_SECRET || null,
    httpPort,
    tweakChannels: parseTweakChannels(env.TWEAK_CHANNEL_IDS),
```

- [ ] **Step 5: Document them in `discord-bot/.env.example`**

Append:

```
# Optional, for the level editor (a Discord Activity). OAuth2 page of the developer portal → Client Secret.
# Without it the bot's http server is not started.
DISCORD_CLIENT_SECRET=
# Optional: the local port that http server listens on (Caddy forwards to it). Default 8787.
HTTP_PORT=
# Where the pencil (Tweak) button appears: unset = nowhere, channel ids separated by commas = those
# channels and their threads, * = everywhere.
TWEAK_CHANNEL_IDS=
```

- [ ] **Step 6: Run the tests**

Run: `cd discord-bot && npm test 2>&1 | tail -8`
Expected: `# fail 0`

- [ ] **Step 7: Commit**

```bash
git add discord-bot/tweaks.js discord-bot/test/tweaks.test.js discord-bot/config.js discord-bot/test/config.test.js discord-bot/.env.example
git commit -m "discord-bot: settings for the level editor Activity"
```

### Task 5: Discord sign-in for the page

**Files:**
- Create: `discord-bot/discord-oauth.js`
- Create: `discord-bot/test/discord-oauth.test.js`

**Interfaces:**
- Produces: `createOAuth({ clientId, clientSecret, fetchImpl? }) → { exchange(code: string) → Promise<{ accessToken: string, user: { id: string, name: string } }> }`. `exchange` rejects with `OAuthError` (exported) for a bad code or a failure at Discord.

- [ ] **Step 1: Write the failing test**

Create `discord-bot/test/discord-oauth.test.js`:

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { createOAuth, OAuthError } = require('../discord-oauth');

function fakeFetch(responses) {
  const calls = [];
  const impl = async (url, opts) => {
    calls.push({ url, opts });
    const r = responses.shift();
    if (!r) throw new Error('unexpected fetch');
    if (r.throws) throw new Error('network down');
    return { status: r.status, ok: r.status >= 200 && r.status < 300, json: async () => r.body };
  };
  return { impl, calls };
}

test('a code is exchanged for a token and the user it belongs to', async () => {
  const f = fakeFetch([
    { status: 200, body: { access_token: 'tok' } },
    { status: 200, body: { id: 42, username: 'ada', global_name: 'Ada L' } },
  ]);
  const oauth = createOAuth({ clientId: 'app', clientSecret: 'shh', fetchImpl: f.impl });
  assert.deepEqual(await oauth.exchange('the-code'), { accessToken: 'tok', user: { id: '42', name: 'Ada L' } });
  assert.equal(f.calls[0].url, 'https://discord.com/api/oauth2/token');
  assert.equal(f.calls[0].opts.method, 'POST');
  const sent = new URLSearchParams(f.calls[0].opts.body);
  assert.equal(sent.get('client_id'), 'app');
  assert.equal(sent.get('client_secret'), 'shh');
  assert.equal(sent.get('grant_type'), 'authorization_code');
  assert.equal(sent.get('code'), 'the-code');
  assert.equal(f.calls[1].url, 'https://discord.com/api/users/@me');
  assert.equal(f.calls[1].opts.headers.authorization, 'Bearer tok');
});

test('a user with no display name is known by their username', async () => {
  const f = fakeFetch([{ status: 200, body: { access_token: 'tok' } }, { status: 200, body: { id: '7', username: 'bob', global_name: null } }]);
  const out = await createOAuth({ clientId: 'a', clientSecret: 's', fetchImpl: f.impl }).exchange('c');
  assert.equal(out.user.name, 'bob');
});

test('bad codes and failures at Discord are OAuthErrors, and a bad code is never sent', async () => {
  const none = fakeFetch([]);
  const o = createOAuth({ clientId: 'a', clientSecret: 's', fetchImpl: none.impl });
  await assert.rejects(o.exchange(''), OAuthError);
  await assert.rejects(o.exchange(undefined), OAuthError);
  await assert.rejects(o.exchange('x'.repeat(201)), OAuthError);
  assert.equal(none.calls.length, 0);
  const cases = [
    [{ status: 400, body: { error: 'invalid_grant' } }],
    [{ throws: true }],
    [{ status: 200, body: {} }],
    [{ status: 200, body: { access_token: 'tok' } }, { status: 401, body: {} }],
    [{ status: 200, body: { access_token: 'tok' } }, { throws: true }],
  ];
  for (const responses of cases) {
    const f = fakeFetch(responses);
    await assert.rejects(createOAuth({ clientId: 'a', clientSecret: 's', fetchImpl: f.impl }).exchange('c'), OAuthError);
  }
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `cd discord-bot && node --test test/discord-oauth.test.js`
Expected: FAIL, `Cannot find module '../discord-oauth'`

- [ ] **Step 3: Create `discord-bot/discord-oauth.js`**

```js
'use strict';

class OAuthError extends Error {}

// The sign-in step of a Discord Activity. The page gets a one-time code from the Discord client and
// posts it here; only the bot holds the client secret that turns the code into an access token.
// Discord is then asked whose token it is, so the bot never takes the page's word for who is using it.
function createOAuth({ clientId, clientSecret, fetchImpl = globalThis.fetch }) {
  async function ask(url, opts) {
    try { return await fetchImpl(url, opts); }
    catch (e) { throw new OAuthError('could not reach Discord'); }
  }

  async function exchange(code) {
    if (typeof code !== 'string' || !code || code.length > 200) throw new OAuthError('bad code');
    const res = await ask('https://discord.com/api/oauth2/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, grant_type: 'authorization_code', code }).toString(),
    });
    if (!res.ok) throw new OAuthError('Discord refused the code (' + res.status + ')');
    const accessToken = (await res.json()).access_token;
    if (typeof accessToken !== 'string' || !accessToken) throw new OAuthError('Discord sent no token');
    const who = await ask('https://discord.com/api/users/@me', { headers: { authorization: 'Bearer ' + accessToken } });
    if (!who.ok) throw new OAuthError('Discord refused the token (' + who.status + ')');
    const u = await who.json();
    return { accessToken, user: { id: String(u.id), name: String(u.global_name || u.username || '') } };
  }

  return { exchange };
}

module.exports = { createOAuth, OAuthError };
```

- [ ] **Step 4: Run the test**

Run: `cd discord-bot && node --test test/discord-oauth.test.js`
Expected: PASS, 3 tests.

- [ ] **Step 5: Commit**

```bash
git add discord-bot/discord-oauth.js discord-bot/test/discord-oauth.test.js
git commit -m "discord-bot: exchange an Activity's sign-in code for a token"
```

### Task 6: The http server

**Files:**
- Create: `discord-bot/http-server.js`
- Create: `discord-bot/test/http-server.test.js`

**Interfaces:**
- Consumes: `oauth.exchange(code)` and `OAuthError` from Task 5.
- Produces: `createHttpServer({ staticDir, oauth, onReport?, log? }) → { listen(port, host = '127.0.0.1') → Promise<number /* the port */>, close() → Promise<void> }`.
- Routes: `GET` files under `staticDir` (`/` is `index.html`; only `.html .js .css .json .png`); `GET /api/ping` → `{ok: true, path}` (spike); `POST /api/token {code}` → `{access_token}` or 401 `{error}`; `POST /api/spike-report {…}` → `onReport(body)`, `{ok: true}` (spike). A leading `/.proxy` on the path is ignored.

- [ ] **Step 1: Write the failing tests**

Create `discord-bot/test/http-server.test.js`:

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { createHttpServer } = require('../http-server');
const { OAuthError } = require('../discord-oauth');

async function start(t, { oauth } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'psbot-http-'));
  const staticDir = path.join(dir, 'site');
  fs.mkdirSync(path.join(staticDir, 'vendor'), { recursive: true });
  fs.writeFileSync(path.join(staticDir, 'index.html'), '<p>hello</p>');
  fs.writeFileSync(path.join(staticDir, 'vendor', 'lib.js'), 'var x = 1;');
  fs.writeFileSync(path.join(staticDir, 'notes.txt'), 'not a served type');
  fs.writeFileSync(path.join(dir, 'secret.js'), 'var secret = 1;');
  const reports = [];
  const server = createHttpServer({
    staticDir,
    oauth: oauth || { exchange: async (code) => ({ accessToken: 'tok-' + code, user: { id: '1', name: 'n' } }) },
    onReport: (r) => reports.push(r),
    log: () => {},
  });
  const port = await server.listen(0);
  t.after(() => server.close());
  return { base: 'http://127.0.0.1:' + port, port, reports };
}

const post = (url, body) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: typeof body === 'string' ? body : JSON.stringify(body) });

// fetch() tidies ".." out of a URL before sending it, so path traversal is tried with a raw request.
function rawGet(port, rawPath) {
  return new Promise((resolve, reject) => {
    http.request({ host: '127.0.0.1', port, path: rawPath, method: 'GET' }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    }).on('error', reject).end();
  });
}

test('serves the page and its files, with their types', async (t) => {
  const { base } = await start(t);
  const index = await fetch(base + '/');
  assert.equal(index.status, 200);
  assert.match(index.headers.get('content-type'), /^text\/html/);
  assert.equal(await index.text(), '<p>hello</p>');
  const lib = await fetch(base + '/vendor/lib.js');
  assert.match(lib.headers.get('content-type'), /^text\/javascript/);
  assert.equal(await lib.text(), 'var x = 1;');
  const head = await fetch(base + '/vendor/lib.js', { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), '');
});

test('serves nothing outside the page directory, and no other file types', async (t) => {
  const { base, port } = await start(t);
  assert.equal((await fetch(base + '/missing.js')).status, 404);
  assert.equal((await fetch(base + '/notes.txt')).status, 404);
  assert.equal((await fetch(base + '/vendor')).status, 404);
  for (const p of ['/../secret.js', '/..%2fsecret.js', '/vendor/..%2f..%2fsecret.js', '/%2e%2e/secret.js', '/vendor/%00.js', '/%zz.js']) {
    const r = await rawGet(port, p);
    assert.equal(r.status, 404, p);
    assert.doesNotMatch(r.body, /secret/, p);
  }
  assert.equal((await post(base + '/vendor/lib.js', {})).status, 405);
});

test('token: a code becomes an access token', async (t) => {
  const { base } = await start(t);
  const r = await post(base + '/api/token', { code: 'abc' });
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { access_token: 'tok-abc' });
});

test('token: a refusal at Discord is a 401 with its reason, and bad bodies are refused', async (t) => {
  const { base } = await start(t, { oauth: { exchange: async () => { throw new OAuthError('Discord refused the code (400)'); } } });
  const r = await post(base + '/api/token', { code: 'abc' });
  assert.equal(r.status, 401);
  assert.deepEqual(await r.json(), { error: 'Discord refused the code (400)' });
  assert.equal((await post(base + '/api/token', 'not json')).status, 400);
  assert.equal((await post(base + '/api/token', '[1]')).status, 400);
  assert.equal((await post(base + '/api/token', { code: 'x'.repeat(70 * 1024) })).status, 413);
});

test('a failure that is not about sign-in is a 500 that says nothing', async (t) => {
  const { base } = await start(t, { oauth: { exchange: async () => { throw new Error('secret detail'); } } });
  const r = await post(base + '/api/token', { code: 'abc' });
  assert.equal(r.status, 500);
  assert.deepEqual(await r.json(), { error: 'server error' });
});

test('ping answers with or without the proxy prefix; unknown api paths are 404', async (t) => {
  const { base } = await start(t);
  assert.deepEqual(await (await fetch(base + '/api/ping')).json(), { ok: true, path: '/api/ping' });
  assert.deepEqual(await (await fetch(base + '/.proxy/api/ping')).json(), { ok: true, path: '/.proxy/api/ping' });
  assert.equal((await fetch(base + '/api/nope')).status, 404);
  assert.equal((await fetch(base + '/api/token')).status, 404);
});

test('spike reports are handed on', async (t) => {
  const { base, reports } = await start(t);
  const r = await post(base + '/api/spike-report', { steps: [{ name: 'x', ok: true }] });
  assert.deepEqual(await r.json(), { ok: true });
  assert.deepEqual(reports, [{ steps: [{ name: 'x', ok: true }] }]);
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `cd discord-bot && node --test test/http-server.test.js`
Expected: FAIL, `Cannot find module '../http-server'`

- [ ] **Step 3: Create `discord-bot/http-server.js`**

```js
'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { OAuthError } = require('./discord-oauth');

// Only these are served. Anything else in the page directory is not for the browser.
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
};
const MAX_BODY = 64 * 1024;

// no-cache: Discord's proxy and its clients hold on to files, and a deploy has to show at once.
function json(res, status, obj) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-cache' });
  res.end(JSON.stringify(obj));
}

// Reads a JSON object from the request. Rejects with {status} for a body that is too large or is not one.
// An oversize body is read to its end and thrown away, so that the client gets its answer.
function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size <= MAX_BODY) chunks.push(c);
    });
    req.on('error', () => reject({ status: 400 }));
    req.on('end', () => {
      if (size > MAX_BODY) return reject({ status: 413 });
      try {
        const v = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!v || typeof v !== 'object' || Array.isArray(v)) return reject({ status: 400 });
        resolve(v);
      } catch (e) { reject({ status: 400 }); }
    });
  });
}

// The page of the level editor Activity and the api it talks to. It listens on localhost only;
// Caddy forwards one public path to it, and Discord's proxy reaches that path.
function createHttpServer({ staticDir, oauth, onReport = () => {}, log = console.error }) {
  const root = path.resolve(staticDir);

  function serveStatic(pathname, res, headOnly) {
    let rel;
    try { rel = decodeURIComponent(pathname); } catch (e) { return json(res, 404, { error: 'not found' }); }
    if (rel.endsWith('/')) rel += 'index.html';
    const file = path.resolve(root, '.' + rel);
    const type = TYPES[path.extname(file)];
    if (rel.includes('\0') || !file.startsWith(root + path.sep) || !type) return json(res, 404, { error: 'not found' });
    fs.stat(file, (err, st) => {
      if (err || !st.isFile()) return json(res, 404, { error: 'not found' });
      res.writeHead(200, { 'content-type': type, 'content-length': st.size, 'cache-control': 'no-cache' });
      if (headOnly) return res.end();
      fs.createReadStream(file).on('error', () => res.destroy()).pipe(res);
    });
  }

  async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    // A request that came through Discord's proxy as /.proxy/api/... is the same request as /api/...
    const p = url.pathname.replace(/^\/\.proxy(?=\/)/, '');
    if (p === '/api/ping' && req.method === 'GET') return json(res, 200, { ok: true, path: url.pathname });
    if (p === '/api/token' && req.method === 'POST') {
      const body = await readJson(req);
      try {
        const { accessToken } = await oauth.exchange(body.code);
        return json(res, 200, { access_token: accessToken });
      } catch (e) {
        if (!(e instanceof OAuthError)) throw e;
        return json(res, 401, { error: e.message });
      }
    }
    if (p === '/api/spike-report' && req.method === 'POST') {
      onReport(await readJson(req));
      return json(res, 200, { ok: true });
    }
    if (p.startsWith('/api/')) return json(res, 404, { error: 'not found' });
    if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { error: 'method not allowed' });
    return serveStatic(p, res, req.method === 'HEAD');
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((e) => {
      if (e && e.status) return json(res, e.status, { error: e.status === 413 ? 'too large' : 'bad request' });
      log('http request failed', e);
      if (res.headersSent) res.destroy();
      else json(res, 500, { error: 'server error' });
    });
  });

  return {
    listen: (port, host = '127.0.0.1') => new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, () => { server.off('error', reject); resolve(server.address().port); });
    }),
    close: () => new Promise((resolve) => { server.close(() => resolve()); server.closeAllConnections(); }),
  };
}

module.exports = { createHttpServer };
```

- [ ] **Step 4: Run the tests**

Run: `cd discord-bot && node --test test/http-server.test.js`
Expected: PASS, 7 tests.

- [ ] **Step 5: Run the whole suite and commit**

Run: `cd discord-bot && npm test 2>&1 | tail -8`
Expected: `# fail 0`

```bash
git add discord-bot/http-server.js discord-bot/test/http-server.test.js
git commit -m "discord-bot: an http server for the level editor page and its api"
```

### Task 7: The SDK and the probe page (spike)

**Files:**
- Create: `discord-bot/scripts/build-sdk.sh`
- Create: `discord-bot/activity/vendor/embedded-app-sdk.js` (generated by the script, committed)
- Create: `discord-bot/activity/index.html` (spike)
- Create: `discord-bot/activity/spike.js` (spike)

**Interfaces:**
- Consumes: `GET api/ping`, `POST api/token`, `POST api/spike-report` from Task 6.
- Produces: `window.DiscordEmbeddedAppSDK = { DiscordSDK, Events, Platform }` from the vendored file. The next plan's editor page uses the same file.

- [ ] **Step 1: Create `discord-bot/scripts/build-sdk.sh`**

```bash
#!/usr/bin/env bash
# Rebuilds activity/vendor/embedded-app-sdk.js: Discord's Embedded App SDK and its dependencies as
# one browser file. The page cannot load it from a CDN, because inside Discord every request has to
# go through the Activity's own proxy. The result is committed; run this only to change the version.
set -euo pipefail
SDK_VERSION="2.5.0"
ESBUILD_VERSION="0.28.2"
HERE="$(cd "$(dirname "$0")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
cd "$TMP"
npm init -y >/dev/null
npm install --no-audit --no-fund "@discord/embedded-app-sdk@$SDK_VERSION" "esbuild@$ESBUILD_VERSION" >/dev/null
printf 'export { DiscordSDK, Events, Platform } from "@discord/embedded-app-sdk";\n' > entry.mjs
mkdir -p "$HERE/activity/vendor"
npx esbuild entry.mjs --bundle --format=iife --global-name=DiscordEmbeddedAppSDK --minify --target=es2019 \
  --banner:js="/* @discord/embedded-app-sdk $SDK_VERSION, bundled by scripts/build-sdk.sh. Do not edit. */" \
  --outfile="$HERE/activity/vendor/embedded-app-sdk.js"
```

- [ ] **Step 2: Run it**

```bash
chmod +x discord-bot/scripts/build-sdk.sh && ./discord-bot/scripts/build-sdk.sh && head -c 90 discord-bot/activity/vendor/embedded-app-sdk.js && echo && wc -c discord-bot/activity/vendor/embedded-app-sdk.js
```

Expected: the banner `/* @discord/embedded-app-sdk 2.5.0, bundled by scripts/build-sdk.sh. Do not edit. */`, and a size near 150,000 bytes.

- [ ] **Step 3: Create `discord-bot/activity/index.html`**

```html
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>PuzzleScript level editor</title>
<style>
  html, body { margin: 0; height: 100%; background: #111; color: #eee; font: 14px/1.4 system-ui, sans-serif; }
  #wrap { display: flex; flex-direction: column; height: 100%; }
  #bar { padding: 8px 8px 0; }
  #pad { flex: 1; min-height: 120px; margin: 8px; border: 1px solid #666; touch-action: none; outline: none; }
  #pad:focus { border-color: #9cf; }
  #log { height: 45%; overflow: auto; margin: 0 8px 8px; padding: 6px; background: #000; white-space: pre-wrap; font: 12px/1.35 ui-monospace, monospace; }
</style>
</head>
<body>
<div id="wrap">
  <div id="bar">Level editor test page. Click, right-click, drag, tap and type in the box.</div>
  <div id="pad" tabindex="0"></div>
  <div id="log"></div>
</div>
<script src="vendor/embedded-app-sdk.js"></script>
<script src="spike.js"></script>
</body>
</html>
```

- [ ] **Step 4: Create `discord-bot/activity/spike.js`**

```js
'use strict';
// Throwaway page for the spike. It finds out what works inside Discord's Activity frame and posts
// what it finds to the bot, which writes it to its log. The editor replaces it.
(function () {
  const logEl = document.getElementById('log');
  const pad = document.getElementById('pad');
  const report = {
    at: new Date().toISOString(),
    ua: navigator.userAgent,
    host: location.hostname,
    inDiscord: /\.discordsays\.com$/.test(location.hostname),
    viewport: [],
    steps: [],
    input: {},
    layout: [],
    csp: [],
  };
  let dirty = true;
  let apiBase = null;

  function log(line) {
    logEl.textContent += line + '\n';
    logEl.scrollTop = logEl.scrollHeight;
  }
  function step(name, ok, detail) {
    report.steps.push({ name, ok, detail: detail === undefined ? null : String(detail).slice(0, 300) });
    log((ok ? 'ok    ' : 'FAIL  ') + name + (detail === undefined ? '' : ': ' + detail));
    dirty = true;
  }

  // The engine compiles every game's rules with new Function. If the frame's content security
  // policy forbids that, the engine cannot run here at all.
  try { step('new Function', new Function('return 6 * 7')() === 42); } catch (e) { step('new Function', false, e.message); }
  document.addEventListener('securitypolicyviolation', (e) => {
    report.csp.push(e.violatedDirective + ' ' + e.blockedURI);
    log('csp   ' + e.violatedDirective + ' ' + e.blockedURI);
    dirty = true;
  });

  function size() {
    const s = innerWidth + 'x' + innerHeight + ' @' + devicePixelRatio;
    if (report.viewport[report.viewport.length - 1] !== s) { report.viewport.push(s); log('size  ' + s); dirty = true; }
  }
  size();
  addEventListener('resize', size);

  // The same events the engine's editor listens for, on the document as it does.
  function count(type, describe) {
    document.addEventListener(type, (e) => {
      const first = !report.input[type];
      report.input[type] = (report.input[type] || 0) + 1;
      if (first) { log('input ' + type + ' ' + describe(e)); dirty = true; }
    }, { passive: true });
  }
  const at = (e) => { const p = e.touches && e.touches[0] ? e.touches[0] : e; return Math.round(p.clientX) + ',' + Math.round(p.clientY); };
  count('mousedown', (e) => 'button ' + e.button + ' at ' + at(e));
  count('mousemove', at);
  count('mouseup', at);
  count('touchstart', at);
  count('touchmove', at);
  count('touchend', () => '');
  count('pointerdown', (e) => e.pointerType + ' at ' + at(e));
  count('keydown', (e) => e.key);
  count('wheel', () => '');
  pad.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    if (!report.input.contextmenu) log('input contextmenu (right-click reached the page)');
    report.input.contextmenu = (report.input.contextmenu || 0) + 1;
    dirty = true;
  });

  // Inside Discord every request goes through the Activity's proxy. Which of these two forms
  // reaches the bot is one of the things being found out.
  async function findApi() {
    for (const base of ['api/', '/.proxy/api/']) {
      try {
        const r = await fetch(base + 'ping');
        const j = r.ok ? await r.json() : null;
        step('fetch ' + base + 'ping', !!(j && j.ok), r.status + (j ? ', the bot saw ' + j.path : ''));
        if (j && j.ok && apiBase === null) apiBase = base;
      } catch (e) { step('fetch ' + base + 'ping', false, e.message); }
    }
  }
  async function post(name, body) {
    const r = await fetch(apiBase + name, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { status: r.status, body: await r.json().catch(() => null) };
  }

  async function discord() {
    const lib = window.DiscordEmbeddedAppSDK;
    if (!lib) return step('sdk loaded', false, 'vendor/embedded-app-sdk.js did not run');
    step('sdk loaded', true);
    // Inside Discord the page is served from <application id>.discordsays.com.
    const clientId = location.hostname.split('.')[0];
    let sdk;
    try { sdk = new lib.DiscordSDK(clientId); } catch (e) { return step('sdk constructed', false, e.message); }
    step('sdk constructed', true);
    await sdk.ready();
    step('sdk ready', true, 'platform ' + sdk.platform + ', guild ' + sdk.guildId + ', channel ' + sdk.channelId);
    try {
      sdk.subscribe(lib.Events.ACTIVITY_LAYOUT_MODE_UPDATE, (e) => {
        report.layout.push(e.layout_mode);
        log('layout mode ' + e.layout_mode + ' (0 focused, 1 picture-in-picture, 2 grid)');
        dirty = true;
      });
      step('layout events subscribed', true);
    } catch (e) { step('layout events subscribed', false, e.message); }
    const { code } = await sdk.commands.authorize({ client_id: clientId, response_type: 'code', state: '', prompt: 'none', scope: ['identify'] });
    step('authorize', true);
    if (apiBase === null) return step('token', false, 'no way to reach the bot');
    const t = await post('token', { code });
    if (t.status !== 200) return step('token', false, t.status + ' ' + JSON.stringify(t.body));
    step('token', true);
    const auth = await sdk.commands.authenticate({ access_token: t.body.access_token });
    step('authenticate', !!(auth && auth.user), auth && auth.user ? 'signed in' : 'no user');
  }

  setInterval(() => {
    if (!dirty || apiBase === null) return;
    dirty = false;
    post('spike-report', report).catch(() => { dirty = true; });
  }, 3000);

  findApi().then(discord).catch((e) => step('discord', false, e && e.message ? e.message : String(e)));
})();
```

The report holds no names or user ids: `authenticate` records only that it worked.

- [ ] **Step 5: Try the page outside Discord**

```bash
cd discord-bot && node -e "
const path = require('node:path');
const { createHttpServer } = require('./http-server');
const s = createHttpServer({ staticDir: path.join(__dirname, 'activity'), oauth: { exchange: async () => { throw new Error('not here'); } }, onReport: (r) => { console.log(JSON.stringify(r.steps)); process.exit(0); } });
s.listen(8799).then(() => console.log('open http://127.0.0.1:8799/'));
setTimeout(() => process.exit(1), 60000);
"
```

Open `http://127.0.0.1:8799/` in a browser. Expected on the page: `ok new Function`, a size line, `ok fetch api/ping`, `FAIL fetch /.proxy/api/ping` or ok (both are fine here), `ok sdk loaded`, then `FAIL sdk constructed` (there is no Discord around it). Within a few seconds the command prints the steps as JSON and exits.

- [ ] **Step 6: Commit**

```bash
git add discord-bot/scripts/build-sdk.sh discord-bot/activity
git commit -m "discord-bot: Discord's SDK as one file, and a probe page for the Activity spike"
```

### Task 8: The pencil button, the launch and the http server in the bot

**Files:**
- Modify: `discord-bot/presentation.js`
- Modify: `discord-bot/test/presentation.test.js`
- Modify: `discord-bot/bot.js`
- Modify: `discord-bot/register-commands.js`

**Interfaces:**
- Consumes: `tweakAllowed` (Task 4), `createOAuth` (Task 5), `createHttpServer` (Task 6), `cfg.clientSecret`, `cfg.httpPort`, `cfg.tweakChannels` (Task 4).
- Produces: `buildComponents(snapshot, meta, { tweak = false } = {})`; `parseCustomId('ps:tweak') === 'tweak'`.

- [ ] **Step 1: Write the failing test**

Append to `discord-bot/test/presentation.test.js`:

```js
test('the tweak button joins the control row of a level, only when asked for', () => {
  const moves = ['ps:left', 'ps:up', 'ps:down', 'ps:right', 'ps:action'];
  assert.deepEqual(ids(buildComponents({ kind: 'level' }, meta({}), { tweak: true })), [moves, ['ps:undo', 'ps:restart', 'ps:tweak']]);
  assert.deepEqual(ids(buildComponents({ kind: 'level' }, meta({ noundo: true, norestart: true }), { tweak: true })), [moves, ['ps:tweak']]);
  assert.deepEqual(ids(buildComponents({ kind: 'level' }, meta({}), { tweak: false })), [moves, ['ps:undo', 'ps:restart']]);
  assert.deepEqual(ids(buildComponents({ kind: 'message' }, meta({}), { tweak: true })), [['ps:continue']]);
  assert.deepEqual(ids(buildComponents({ kind: 'level', animating: 'loop' }, meta({}), { tweak: true })), [['ps:undo', 'ps:restart']]);
  assert.equal(parseCustomId('ps:tweak'), 'tweak');
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `cd discord-bot && node --test test/presentation.test.js`
Expected: FAIL in the new test (no `ps:tweak` in the row; `parseCustomId` returns null).

- [ ] **Step 3: Change `discord-bot/presentation.js`**

Replace the two constant lines at the top:

```js
// tweak is not a move: it opens the level editor (see bot.js) and never reaches the game registry.
const ACTIONS = ['up', 'left', 'down', 'right', 'action', 'undo', 'restart', 'continue', 'tweak'];
const ACTION_EMOJI = { left: '⬅️', up: '⬆️', down: '⬇️', right: '➡️', action: '✖️', undo: '↩️', restart: '🔄', continue: '▶️', tweak: '✏️' };
```

Change the signature of `buildComponents` and its second row:

```js
function buildComponents(snapshot, meta, { tweak = false } = {}) {
```

```js
  const row2 = [];
  if (!flags.noundo) row2.push(button('undo'));
  if (!flags.norestart) row2.push(button('restart'));
  if (tweak) row2.push(button('tweak'));
```

Nothing else in the function changes: message screens and running `again` chains return before this point, so they get no pencil.

- [ ] **Step 4: Run the test**

Run: `cd discord-bot && node --test test/presentation.test.js`
Expected: PASS.

- [ ] **Step 5: Change `discord-bot/bot.js`**

Add to the requires at the top:

```js
const path = require('node:path');
const { tweakAllowed } = require('./tweaks');
const { createOAuth } = require('./discord-oauth');
const { createHttpServer } = require('./http-server');
```

Replace `frame` so that the caller says whether this channel gets the pencil:

```js
// gif: the animation of the move that led here, when there is one; otherwise a still is drawn.
// tweak: whether the level editor is offered in the channel the game is in.
function frame(record, snapshot, gif, tweak) {
  const name = gif ? 'frame.gif' : 'frame.png';
  const data = gif ? Buffer.from(gif) : renderSnapshot(snapshot).png;
  return {
    content: '',
    embeds: [buildEmbed({ record, snapshot, attachmentName: name })],
    files: [new AttachmentBuilder(data, { name })],
    components: record.status === 'playing' ? buildComponents(snapshot, record.meta, { tweak }) : [],
  };
}
```

In `main`, after `const client = new Client(...)`, add:

```js
  // A thread counts as the channel it belongs to.
  const canTweak = (interaction) => tweakAllowed(cfg.tweakChannels, interaction.channelId, (interaction.channel && interaction.channel.parentId) || null);

  // The level editor page. Without the client secret it cannot sign anyone in, so it is not served.
  let httpServer = null;
  if (cfg.clientSecret) {
    httpServer = createHttpServer({
      staticDir: path.join(__dirname, 'activity'),
      oauth: createOAuth({ clientId: cfg.appId, clientSecret: cfg.clientSecret }),
      onReport: (r) => console.log('spike report', JSON.stringify(r)),
    });
    console.log('http on 127.0.0.1:' + await httpServer.listen(cfg.httpPort));
  }
```

In the interaction handler, inside the outer `try`, before the `/play` branch, add:

```js
      // The app launcher entry Discord adds once Activities are enabled. The editor is opened from
      // a game, not from there.
      if (interaction.isPrimaryEntryPointCommand()) {
        const hint = cfg.tweakChannels === '*' ? 'To edit a level, press the pencil button under a game.' : 'The level editor is still being tested and is not open yet.';
        await interaction.reply({ content: hint, flags: MessageFlags.Ephemeral });
        return;
      }
```

In the `/play` branch, change the frame call:

```js
          await interaction.editReply(frame(record, snapshot, null, canTweak(interaction)));
```

In the button branch, directly after `if (!action) return;`, add:

```js
        if (action === 'tweak') {
          if (!canTweak(interaction)) {
            await interaction.reply({ content: 'the level editor is not available here', flags: MessageFlags.Ephemeral });
            return;
          }
          // The only answer: Discord allows three seconds, and a launch cannot be deferred.
          await interaction.launchActivity();
          return;
        }
```

and change the frame call further down in that branch:

```js
          await enqueueEdit(gameId, () => interaction.editReply(frame(record, snapshot, gif, canTweak(interaction))));
```

Change `shutdown` to close the http server too:

```js
  const shutdown = async () => { await registry.close(); await pool.close(); if (httpServer) await httpServer.close(); client.destroy(); process.exit(0); };
```

- [ ] **Step 6: Change `discord-bot/register-commands.js`**

Change the first require line to:

```js
const { REST, Routes, SlashCommandBuilder, ApplicationCommandType, EntryPointCommandHandlerType } = require('discord.js');
```

After the `console.log('registered ...')` line, add:

```js
  // Once Activities are enabled, Discord adds a global Entry Point command that launches the
  // Activity for anyone who picks the app in the launcher. Hand it to the bot, which answers with a
  // hint instead (see bot.js).
  const globals = await rest.get(Routes.applicationCommands(cfg.appId));
  const entry = globals.find((c) => c.type === ApplicationCommandType.PrimaryEntryPoint);
  if (!entry) console.log('no entry point command (Activities are not enabled)');
  else if (entry.handler === EntryPointCommandHandlerType.AppHandler) console.log('entry point command already handled by the bot');
  else {
    await rest.patch(Routes.applicationCommand(cfg.appId, entry.id), { body: { handler: EntryPointCommandHandlerType.AppHandler } });
    console.log('entry point command handed to the bot');
  }
```

- [ ] **Step 7: Check both files load, and run the suite**

```bash
cd discord-bot && node --check bot.js && node --check register-commands.js && npm test 2>&1 | tail -8
```

Expected: no output from the two checks, then `# fail 0`.

- [ ] **Step 8: Add the settings to the README**

In `discord-bot/README.md`, add before `## Scores`:

```markdown
## Level editor (in progress)

The bot can serve a page that opens inside Discord as an Activity. It is being built; see
`docs/superpowers/specs/2026-10-07-discord-level-editor-design.md`.

- `DISCORD_CLIENT_SECRET` starts the bot's http server on `127.0.0.1:HTTP_PORT` (8787 by default).
  Caddy forwards `https://games.increpare.com/puzzlescriptbot/app/` to it.
- `TWEAK_CHANNEL_IDS` says where the pencil button appears under a game: unset, nowhere; a list of
  channel ids, those channels and their threads; `*`, everywhere.
- After enabling Activities in the developer portal, run `node register-commands.js` again. It
  hands the app launcher entry to the bot, so that it answers with a hint rather than launching.
- `scripts/build-sdk.sh` rebuilds `activity/vendor/embedded-app-sdk.js`.
```

- [ ] **Step 9: Commit**

```bash
git add discord-bot/presentation.js discord-bot/test/presentation.test.js discord-bot/bot.js discord-bot/register-commands.js discord-bot/README.md
git commit -m "discord-bot: a pencil button that launches the Activity, in the channels that allow it"
```

### Task 9: Set it up and run the spike

No code changes except the findings written into the spec.

- [ ] **Step 1: Deploy**

```bash
./discord-bot/deploy.sh
```

Nothing visible changes yet: there is no client secret on the server, so the http server does not start, and `TWEAK_CHANNEL_IDS` is unset, so there is no pencil.

- [ ] **Step 2: Find the test channel's id and set it**

```bash
ssh locus@95.211.62.202 'export PATH="$HOME/.local/bin:$PATH" && cd ~/puzzlescript-bot/discord-bot && node -e "
const { REST, Routes } = require(\"discord.js\");
const { loadConfig } = require(\"./config\");
const cfg = loadConfig();
new REST({ version: \"10\" }).setToken(cfg.discordToken).get(Routes.guildChannels(cfg.guildId))
  .then((cs) => console.log(cs.filter((c) => c.name === \"mapeditor-test\").map((c) => c.id).join(\",\") || \"not found\"));
"'
```

Expected: one channel id. Then, with that id in place of `ID`:

```bash
ssh locus@95.211.62.202 'cd ~/puzzlescript-bot/discord-bot && printf "\nHTTP_PORT=8787\nTWEAK_CHANNEL_IDS=%s\n" ID >> .env'
```

- [ ] **Step 3 (USER): Add the client secret**

In the developer portal, PuzzleScriptBot → OAuth2 → Client Secret → Reset Secret, and copy it. On the server, add it to `~/puzzlescript-bot/discord-bot/.env` as a line `DISCORD_CLIENT_SECRET=<the secret>`.

- [ ] **Step 4 (USER, root): The Caddy rule**

In `/etc/caddy/Caddyfile`, inside the `games.increpare.com, ded.increpare.com, ded.bfxr.net` block, after the `handle /ws/imissyou { … }` block, add:

```
	# PuzzleScriptBot: the level editor page and its api (a Discord Activity), served by the bot.
	handle_path /puzzlescriptbot/app/* {
		reverse_proxy 127.0.0.1:8787
	}
```

Then, as root:

```bash
caddy validate --config /etc/caddy/Caddyfile && systemctl reload caddy
```

- [ ] **Step 5: Restart and check the public path**

```bash
ssh locus@95.211.62.202 'systemctl --user restart puzzlescript-bot && sleep 2 && journalctl --user -u puzzlescript-bot -n 6 --no-pager | grep -c "http on 127.0.0.1:8787"'
curl -s https://games.increpare.com/puzzlescriptbot/app/api/ping
curl -s -o /dev/null -w '%{http_code} %{content_type}\n' https://games.increpare.com/puzzlescriptbot/app/
curl -s -o /dev/null -w '%{http_code}\n' https://games.increpare.com/puzzlescriptbot/puzzlescriptbot_privacy.html
```

Expected: `1`; `{"ok":true,"path":"/api/ping"}`; `200 text/html; charset=utf-8`; `200` (the privacy page is still served as a file).

- [ ] **Step 6 (with the USER, in the developer portal): Configure the Activity**

Each of these changes the application's settings, so each is confirmed with the user before it is made.

1. OAuth2 → Redirects → add `https://games.increpare.com/puzzlescriptbot/app/`. Discord requires one; an Activity never uses it.
2. Activities → URL Mappings → Root Mapping: prefix `/`, target `games.increpare.com/puzzlescriptbot/app`.
3. Activities → Settings → supported platforms: Web, iOS and Android.
4. Activities → Settings → enable Activities.

If the portal refuses a target with a path in it, that is a finding. The fallback is a name of its own, `psbot.increpare.com`: a DNS record and a Caddy site block containing only `reverse_proxy 127.0.0.1:8787`, both made by the user, and the root mapping pointed at that.

- [ ] **Step 7: Hand the launcher entry to the bot, straight away**

Until this is run, anyone in the server can open the probe page from the app launcher.

```bash
ssh locus@95.211.62.202 'export PATH="$HOME/.local/bin:$PATH" && cd ~/puzzlescript-bot/discord-bot && node register-commands.js'
```

Expected: `entry point command handed to the bot`.

- [ ] **Step 8 (USER): Try it**

On desktop, in `#mapeditor-test`:
1. `/play` a game. A pencil button is under it. Press it.
2. In the page: click, right-click, drag, and type a few keys in the box. Read the lines in the log.
3. Shrink the Activity to picture-in-picture and bring it back. Note how it sits beside the chat and how big it is.

On a phone, in the same channel: press the pencil on the same game, then tap and drag in the box.

Elsewhere: `/play` in another channel shows no pencil. Picking PuzzleScriptBot in the app launcher gives the "still being tested" hint.

- [ ] **Step 9: Read the reports**

```bash
ssh locus@95.211.62.202 'journalctl --user -u puzzlescript-bot --since "2 hours ago" --no-pager | grep "spike report" | tail -4'
```

- [ ] **Step 10: Write the findings into the spec and commit**

Add a section `## Spike findings (2026-10-…)` to `docs/superpowers/specs/2026-10-07-discord-level-editor-design.md`, with one line per assumption in the spec's Build order step 2, giving what was found on desktop and on the phone:

- launches in the real server (a verified app, in a server of that size)
- the proxy path that reached the bot (`api/` or `/.proxy/api/`), and whether a mapping target may have a path
- `launchActivity()` from a button
- the Entry Point command handed to the bot
- `authorize` without a visible prompt, the token exchange, `authenticate`
- `new Function` allowed, and any content security policy violations
- mouse, right-click, keyboard and touch events reaching the page
- how the panel is presented, and its size in each layout mode

Where a finding contradicts the spec, change the spec in the same commit and say so in the commit message.

```bash
git add docs/superpowers/specs/2026-10-07-discord-level-editor-design.md
git commit -m "Level editor spec: what the Activity spike found"
```
