# PuzzleScript level editor in Discord ("Tweak") — design

Date: 2026-10-07
Status: approved 2026-10-07

## Goal

Let anyone in the Discord server make a new level for a game that is being
played there, and share it, without leaving Discord.

Every game message gets a **Tweak** button. It opens the real PuzzleScript
level editor inside Discord, as a Discord Activity, on the level the game is
showing. The editor has Play, to test the level, and Send. A sent level is
posted in a thread for that game as a new game on that level, with its
author and its text, so anyone can play it there or tweak it further.

In PuzzleScript players are authors, so there is no owner and no accept step.
The level text in the post is the export: anyone can copy it into their game.

## Non-goals

- Zooming or scrolling the level. On a phone the cells of a large level are
  small.
- Editing anything but one level: no rules, objects or legend, and one level
  per send.
- The abbreviated form of PuzzleScript discussed alongside this. It is a
  separate project.
- Ranks for custom levels. Solving one is recorded on its post and nowhere
  else, so that trivial levels cannot be used to gain rank.
- Moderation tools. A post names its author, and server moderators can delete
  it like any message.
- Realtime games, which the bot already refuses.

## What changed since the play bot

Two things outside the feature itself:

1. **The bot moves from the Raspberry Pi to the increpare.com server**
   (`locus@95.211.62.202`, Debian 12, Caddy). An Activity is a web page that
   Discord loads over public HTTPS, and it has to hand finished levels to the
   bot, so the bot needs a public address. The Twitch bot stays on the Pi.
2. **The Discord application is verified** (done 2026-10-07) and owned by the
   developer team "increpare". Discord's developer support says an unverified
   Activity only runs in servers with fewer than 25 members. This was read
   from a search summary of the support article, not the article itself, so
   the first build step checks it for real.

## How it fits together

```
Discord client ── Tweak button ──► bot (gateway)        records "user U is tweaking level L"
      │                              ▲                  and answers with LAUNCH_ACTIVITY
      ▼                              │
Activity frame ─► <app id>.discordsays.com ─► Caddy ─► bot HTTP server (127.0.0.1)
  editor page          Discord's proxy       one path      static page, engine files, api
```

The bot process gains an HTTP server. Caddy forwards one path of
games.increpare.com to it. Discord's URL mapping points the Activity at that
path. There is one process, one deployment, and no tunnel.

## Components

All code is in `discord-bot/`. There are no new runtime dependencies: the
HTTP server uses node's `http` module.

### `levels.js` — custom levels

- `splice(source, levelText)` → a full game source whose `LEVELS` section is
  replaced by the one level. Everything up to and including the `LEVELS`
  header line (and a row of `=` under it, if there is one) is kept.
- A store under `data/levels/`, one JSON file per level:
  `{id, gistId, baseSourceHash, text, authorId, authorName, createdAt,
  channelId, threadId, messageId, solvedBy: [{id, name}]}`.
- `id` is the first 10 hex digits of SHA-256 over the gist id and the level
  text (lower-cased, trailing spaces trimmed), so the same level sent twice
  is one level.
- The store is capped at 5 MB. When it is full a new level is refused. Levels
  are never deleted to make room, because they are people's work.

### `games.js` — games on custom levels

- A game record gains an optional `levelId`. Its `sourceHash` is the hash of
  the spliced source, which is saved in the source store like any other.
- When that source has been evicted, it is rebuilt from the level record and
  the base game (the stored base source by hash, or the gist as it is now).
  If the result no longer compiles the game is stopped with "this level no
  longer works with the current version of the game".
- `start()` accepts `levelId`. Such a game has one level; solving it finishes
  the game.
- `again(gameId)` starts a finished custom-level game afresh: the input log
  is emptied and the game is playing again, in the same record.

### `tweaks.js` — which level a user is about to edit

Discord gives a launched Activity the channel and, after sign-in, the user,
but no payload from the button that launched it. So the bot remembers it:

- On a Tweak press: `pending.set(userId, {gistId, sourceHash, levelIndex or
  levelId, gameId, channelId, authorName, at})`. In memory, 15 minutes,
  newest wins. `authorName` is the presser's display name in the server,
  which Discord's sign-in does not give.
- The page asks for it after sign-in and gets it back as a **ticket**: the
  same fields and the user id, signed by the bot (HMAC). The page returns the
  ticket when it sends a level. So a level can be sent long after the pending
  entry has expired, or after the bot has restarted, and a ticket cannot be
  forged or used by another user.

### `http-server.js` — page and api

Listens on `127.0.0.1:HTTP_PORT` only. Request bodies are JSON, 64 KB at
most.

- `GET /` and files under it → the editor page (`activity/`).
- `GET /engine/<file>` → engine files from the PuzzleScript checkout's
  `src/js/`, by name from a fixed list.
- `POST /api/token {code}` → exchanges the Discord OAuth code using the
  client secret, asks Discord who the user is, and returns the access token
  with a session: the user id and an expiry 24 hours on, signed by the bot.
  Nothing about sessions is kept in memory, so a restart does not sign
  anyone out.
- `GET /api/tweak` (session) → `{title, source, levelIndex, ticket}` for the
  user's pending tweak, or 404. For a tweak of a custom level, `source` is
  the spliced source and `levelIndex` is 0.
- `POST /api/levels {ticket, text}` (session) → checks that the ticket is
  the session's user's, checks the limits, splices, compiles in a worker
  under the existing compile deadline, stores the level, posts it, and
  returns `{ok, url}` or `{ok: false, error}` with the compiler's first
  error line.

Without a session only static files are served. A development mode
(`TWEAK_DEV=1`, never set on the server) accepts a session without Discord so
that the page can be worked on as a plain web page.

### `activity/` — the editor page

- Loads the engine with the same script list as upstream `play.html`, except
  that `debug_off.js` is replaced by a local file which sets
  `canOpenEditor = true`. The editing itself is upstream code
  (`levelEditorClick` and friends in `inputoutput.js`): a palette of the
  game's single-character legend glyphs, and click or drag to paint.
- Opens on the level's starting layout, in edit mode. Tweak always starts
  from the level as written, not from the position reached in play.
- A toolbar outside the canvas: **Edit / Play**, **Undo**, **Reset**,
  **Send**. Switching to Play keeps a copy of the edited layout; switching
  back restores it, so playing never changes the level being made.
- **Touch.** Upstream already takes touch in the editor: a tap or a drag
  paints, a tap on the palette picks a glyph, and the swipe handler in
  `mobile.js` stands down while the editor is open. A touch screen has no
  right mouse button and no Z key, so:
  - **Erasing is painting the background.** The background tile is in the
    palette of every game; nothing else is provided for erasing. The right
    mouse button still erases where there is one.
  - **Undo** does what Z does.
- **Resizing: edge arrows.** Each of the four edges of the level has a pair
  of arrow buttons at its middle, outside the canvas. An arrow shows which
  way the edge moves: on the right edge, `>` pushes it out (adds a column)
  and `<` pulls it in (removes one); the other three edges mirror this. One
  tap is one row or column. The buttons call upstream's `addRightColumn`,
  `removeRightColumn` and their six siblings, which already record an undo
  step and refuse to go below one row or column. They are ordinary buttons,
  so they are the same with a mouse or a finger and stay finger-sized
  however small the cells are. This is provisional: it is to be judged in
  real use, on a phone, once the editor page exists (build step 4), and
  replaced if it does not feel right.
  - With a mouse, upstream's own way still works: click the border to add,
    right-click it to remove.
  - On a touch screen a tap on the border does nothing, so that a finger
    slipping off the edge while painting cannot add a row. The page handles
    that touch first and marks it `handled`, which upstream's handlers
    respect.
- The layout works in portrait and landscape.
- Send turns the level into glyph text with the engine's own `matchGlyph`,
  as `printLevel` does, and posts it. A compile error is shown in the page.
- `discord.js` in the page is the only part that knows about Discord: the
  Embedded App SDK handshake, `authorize` (scope `identify`), the code
  exchange, `authenticate`. The SDK is vendored as one file, with a script
  that regenerates it from the npm package.
- Like the upstream editor, it can only place what the legend has a
  single-character glyph for.

### `bot.js` and `presentation.js` — Discord

- **Tweak** (✏️, `ps:tweak`) joins undo and restart in the second button row
  of a level. It is not shown on message screens, or on a normal game that
  has finished.
- A press records the pending tweak and answers with `LAUNCH_ACTIVITY`. No
  other work is done, because that answer has to be sent within three
  seconds.
- **Send always makes something new.** It never changes the game that was
  tweaked, whoever started that game. Nobody owns a game here: anyone in the
  channel can press its buttons, and the record does not say who started it.
  A level has an author, for credit only.
- **A sent level is a new game.** Send posts, in the game's thread, a game
  message on that level: the usual picture and move buttons, titled
  "<game> — level by <author>", with the level text in a code block
  (attached as a file when it is too long for one) and a footer
  "Custom level" where a normal game says "Level n of m". Anyone can play it
  there, as with any game, and Tweak works on it as on any game. There is no
  separate card and no Play button. Sending a level that has already been
  sent answers with a link to the game it has, and posts nothing.
- **The thread.** One per game per channel. The first level sent for a game
  in a channel starts a thread on the game message that was tweaked, named
  "Levels: <game>". Later levels for that game in that channel go to the
  same thread, wherever Tweak was pressed. If the thread has gone, a new one
  is started. A level tweaked from a game that is already inside a thread is
  posted in that thread. Which thread belongs to which game is kept in
  `data/threads.json`.
- **Once solved**, the message shows "Solved by <names>" and, in place of
  the move buttons, 🔄 Play again (`ps:again`) and ✏️ Tweak. Play again
  starts the level afresh in the same message. A solver is added to the
  level record and listed once, however often the level is replayed. A
  normal game that is finished still has no buttons.
- Solving a custom level gives no rank credit.
- The Activity's Entry Point command (the app launcher entry Discord adds
  when Activities are enabled) is handled by the bot, which answers with a
  hint to press Tweak under a game.

## Limits

| Limit | Value |
|---|---|
| Level text | 10,000 characters |
| Level size | 100 × 100 cells |
| Levels sent per user | 10 an hour |
| Pending tweak | 15 minutes |
| Page session and ticket | 24 hours |
| Level store | 5 MB, then new levels are refused |
| Request body | 64 KB |

Compile time, move time and source size keep the limits the play bot has.

## Configuration

Added to `.env`:

```
DISCORD_CLIENT_SECRET=...   # OAuth2 page of the developer portal
HTTP_PORT=8787
TWEAK_CHANNEL_IDS=...       # optional, see Build order
```

In the developer portal: an OAuth2 redirect URI (Discord asks for one even
though an Activity never redirects), the URL mapping `/` →
`games.increpare.com/puzzlescriptbot/app`, all three supported platforms
(web, iOS, Android), and Activities enabled.

On the server, for the bot's role: Create Public Threads and Send Messages
in Threads.

## Deployment

- `deploy.sh` targets `locus@95.211.62.202`. The service unit runs
  `%h/.local/bin/node` (Node 24.21, installed in the home directory; `locus`
  has no root access).
- Two steps need root and are done by the user: `loginctl enable-linger
  locus`, and a rule in the games.increpare.com block of the Caddyfile:

  ```
  handle_path /puzzlescriptbot/app/* {
      reverse_proxy 127.0.0.1:8787
  }
  ```

  The privacy and terms pages stay where they are, as static files under
  `/puzzlescriptbot/`.
- Cutover: stop and disable the service on the Pi, copy `data/` across, copy
  `.env` by hand, start the service on the server. The two must never run at
  once, since both would answer every press.
- The privacy page is updated in the same change that starts storing authors
  and solvers, and uploaded again.

## Build order

Each step leaves the bot working.

1. **Move.** The bot runs on the server, unchanged in behaviour. The tests
   pass on Node 24 first.
2. **Spike.** The HTTP server with a placeholder page, the Caddy rule, the
   URL mapping, and one launch in the real PuzzleScript server. It settles
   the things this design assumes:
   - that a verified app's Activity launches in a server of that size;
   - the exact proxy paths, and that a URL mapping may point at a path;
   - `launchActivity()` in the installed discord.js (14.27);
   - how the Entry Point command is handled;
   - that `authorize` works without a visible prompt;
   - that the engine's keyboard and mouse input work inside the frame, and
     touch input in the Discord app on a phone;
   - how Discord presents an Activity launched from a text channel (it is
     its own panel, never inline in the chat), and at what size.
3. **Custom levels** in the bot: splice, store, games on a level, the share
   post, the thread, Play, solved-by.
4. **The editor page** as a plain web page in development mode.
5. **The Discord wrapper and the Tweak button**, shown only on games in the
   channels named by `TWEAK_CHANNEL_IDS`, and in threads under them. During
   the beta that is the private `#mapeditor-test` channel in the PuzzleScript
   server. The bot's role has to be given access to that channel. The beta
   ends when the user says so; the setting is then removed and Tweak appears
   everywhere.

The spike's launch (step 2) is also done in `#mapeditor-test`, so that
nothing unfinished is seen by the server's members.

Implementation plans are written in two parts: steps 1 and 2 first, then
steps 3 to 5 once the spike has reported, since what it finds may change
them.

A private channel on the live bot replaces the separate development
application and test server considered earlier: now that the live
application is verified, a second application would be the one with the
25-member limit, and would need its own token, deployment and URL mapping.

## Testing

- `levels`: splice against demo games with and without `=` rows and with
  mixed-case headers; id stability; the cap.
- `games`: a game on a custom level survives eviction and rebuild; a level
  whose base game changed is stopped with the right message; no rank credit.
- `http-server`: each route with a stubbed Discord; no session, expired
  session, oversize body, a file name outside the engine list.
- `tweaks`: newest wins, expiry; a ticket that has been altered, or is
  presented by another user, is refused.
- `presentation`: the Tweak button's placement; a custom level's embed; the
  solved state, with its solvers, Play again and Tweak.
- The page's level-to-text function, run in the engine host against levels
  whose text is known.
- By hand, on desktop and on a phone: tweak, paint, erase, grow and shrink
  the level, undo, play, send, solve the sent level, play it again, tweak
  it, in the test channel.

## Open points, decided

- Who a suggestion is for: everyone. No owner, no accept step.
- Front end: the real editor in an Activity, not a text box or a
  button-driven painter.
- Hosting: the whole bot on the increpare.com server.
- Tweak starts from the level's starting layout.
- Send always makes a new game, and that game is the post. It never changes
  the game that was tweaked.
- Phones are supported. Erasing is painting the background; resizing is by
  arrow buttons on the level's edges; undo is a button.
- Custom levels do not count towards ranks.
