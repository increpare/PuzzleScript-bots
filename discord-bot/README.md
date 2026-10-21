# PuzzleScript Discord play bot

Play a PuzzleScript game inside a Discord channel. `/play <gist>` posts the
level as an image with move, action, undo and restart buttons. Anyone in the
channel can press them. Realtime games are not supported.

Finished games offer **Replay game**, which posts a fresh game from the beginning in
the same channel and keeps the completed game intact. A private jump link takes you
to the new post if it is out of view. Solved custom levels keep their existing replay
button, which restarts the level in place.

Controls use matching blue-tile custom emoji owned by the Discord application. Startup reuses
existing uploads and creates missing icons from `icons/controls/`. Action is a circled X; Replay game
is a plus. Uploaded versions are retained so icons on older messages still work. No guild emoji
slots or extra server permissions are needed. SVG sources and 128px PNGs are committed; run
`node scripts/build-control-icons.js` after editing an SVG to rebuild its PNG.

## Layout

The bot loads the engine from `../puzzlescript/src/js`, the PuzzleScript
submodule at the root of this repository (see the README there). `deploy.sh`
syncs both to `~/puzzlescript-bot/` on the increpare.com server
(`locus@95.211.62.202`).

## Setup (once)

1. Create a Discord application at https://discord.com/developers/applications,
   add a Bot, copy the token. Invite it with scopes `bot` and
   `applications.commands` and permissions Send Messages, Attach Files,
   Embed Links, Manage Roles.
2. On the server: `cp .env.example .env` in `~/puzzlescript-bot/discord-bot/` and
   fill in the keys. `DISCORD_GUILD_ID` is the server id.
3. `node register-commands.js` once (on the server or locally with the same `.env`).
4. So that the service survives logout and reboot, as root: `loginctl enable-linger locus`.

Node is installed in `locus`'s home directory (`~/.local/bin/node`), because
that account has no root. In a shell there, put it on the path first:
`export PATH="$HOME/.local/bin:$PATH"`.

Typing `/play` suggests games: those of the puzzlescript.net gallery first, marked ⭐, then the community's
games listed in `community-games.json` (made from `community-gists.txt` by `scripts/build-community-games.js`).
Any gist id or play link also works.

## Deploy

    ./deploy.sh

This also publishes `legal/puzzlescriptbot_privacy.html`, `legal/puzzlescriptbot_terms.html` and
`skinner/skinner.html` to `~/www/puzzlescriptbot/` on the server, which is where the links
registered with Discord point. When a change alters what the bot keeps about people, change the privacy page with it.

## Run locally

    npm install && npm test
    node bot.js        # needs .env

## Operations

- Logs: `journalctl --user -u puzzlescript-bot -f`
- Games persist under `discord-bot/data/games/`, gist cache under `data/gists/`.
  Games never expire by age. Per-game records (seed and input history) are capped at 1 MB in total and game data at 100 MB (`data/sources/` holds every game's source once, by hash, up to 99 MB; `data/gists/` is a small index of gist id to source, up to 1 MB); over a cap, finished games go first, then the least recently played. A game keeps its original source, so editing a gist does not affect games already started unless that source has been evicted.
- Every frame is 400×300 px (matches Discord's embed placeholder size so the panel never resizes).
- Limits: 1 MB source, 10 s compile, 3 s for any single turn of the engine, 20 s for a move's whole chain of `again` turns, 30 live games.

## Pushing It

[Pushing It by Jack Lance](https://www.puzzlescript.net/play.html?p=2fe3172d2b9fe684977d184f1b6226d5)
works with the usual `/play` link, buttons, typed moves, level selection, scores and saved games.
Its real game is JavaScript hidden in its homepage metadata; compiling its PuzzleScript alone
only loads a decoy. A dedicated host runs Jack's original code with Canvas 2D and deterministic
timers, including its fractional positions, rotations and piston animations.

The original gist resolves to a preserved copy in `legacy/pushing-it/script.txt`, so it can be
started without GitHub. Its revision, fingerprint and attribution are in that folder's README.
Only that exact source selects the custom host. Other games' homepage code is never executed.
The pencil is unavailable for this game because an ordinary PuzzleScript level cannot represent
its custom geometry. `npm ci` installs the Canvas dependency, including its platform binary;
no browser is needed to run the bot.

`npm run test:pushing-it-browser` compares the host with the original homepage injection in
Chromium across all twelve levels. Like the other browser checks, it uses Playwright from
`PUZZLESCRIPT_LABS_DIR` (or the default labs checkout) and an installed Chromium browser.
The regular `npm test` covers the custom host and real-worker persistence without a browser.

## Again chains and animation

A move that sets off `again` turns is shown as one animated GIF, a frame per turn at the game's
`again_interval`. A chain that ends plays once and rests on the final state (its first frame is the
final state for one blink, so a client that shows GIFs as stills still shows the right board).
The GIF omits the loop extension and uses normal frame delays, including the final picture;
an artificial long pause could make Discord's duration-limited conversion discard that picture.

- **Loops.** Some games animate for ever on purpose (an explosion that keeps flickering after you
  lose). The chain is stopped as soon as a state repeats, the GIF loops, and only undo and restart
  are offered, because the engine ignores moves while an `again` chain is running. Two loops are
  shown playing once instead, resting on the state the game was left in: one reached through a
  lead-in (a fuse that burns down before the explosion starts flickering), since a GIF can only
  repeat from its first frame, and one whose move also raised a message, which has to be seen.
- **Very long chains** pause after 1000 turns with a continue button. Chains of more than 300
  distinct frames are shown as a still.
- **Too slow.** A move whose chain takes more than 20 s is refused and not recorded; the game
  carries on from where it was. A single turn that takes more than 3 s stops the worker, which is
  also only a refused move. Three refused presses in a row stop the game, because each one costs
  the worker seconds; any press that works starts the count again. Rebuilding a game from its
  input log allows three times each of these limits, compiling included.

Loop and pause points depend only on the game and its inputs, never on timing, so a game rebuilt
from its input log lands in the same place.

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
- Sent levels are kept in `data/levels/`, one file each, up to 5 MB; after that new ones are
  refused, and none is ever deleted to make room. `data/threads.json` records which thread holds
  the levels of which game. A sent level is posted as a game of its own in that thread; solving
  it is noted on its message and gives no rank credit.
- The bot's role needs Create Public Threads, Send Messages in Threads and Read Message History
  wherever the pencil is allowed.

## Shared workshop

The sound buttons print playable sound seeds in the console. In Discord, EXPORT prints download
links for the standalone HTML game and its source text. They hold the version exported, expire
after 15 minutes, and disappear on a bot restart. Anyone given a link can download its file;
exporting does not post to the channel. The export cache holds up to 32 MB or 128 exports, so older
links can expire sooner if it fills. `WORKSHOP_PUBLIC_URL` sets the public app address used for
these links; the default is `https://games.increpare.com/puzzlescriptbot/app/`.

Loading an example or a room save asks for confirmation inside the editor. **Save current game &
load** waits for the current shared game to be saved to the room's Load list before replacing it
for everyone. Cancel or Escape leaves it alone. Save/load failures appear in the console; edits
received while saving prevent replacement, so you can retry with the latest text.

Click a participant's name to scroll to their code cursor without moving your own selection.
Double-right-click a place in the code editor to signal it to everyone for five seconds. A signal
outside your view appears as an arrow at the editor's edge; click the arrow to jump to it. A single
right-click is reserved for this gesture; Shift-right-click opens the usual context menu. You see
your own marker immediately, with a sending indicator until it is accepted. Signals follow edits
to the document and wait briefly for your outstanding edits to sync. Failed sends show a visible
notice on the marker and an explanation in the console.

Workshop client scripts use content-versioned URLs so a new deployment fetches fresh code through
Discord's proxy. The participant strip shows a persistent `Build` identifier, which remains visible
after clearing the console or running a game, so users can verify which client release loaded.

`npm run test:workshop-browser` checks the real labs editor in Chromium inside a cross-origin frame
with downloads blocked, using two participants. It needs a labs checkout with Playwright installed
and its Chromium browser available. Set `PUZZLESCRIPT_LABS_DIR` to that checkout; by default it uses
the same `PuzzleScript-labs/.claude/worktrees/discord-workshop` checkout as deployment.
`npm run test:workshop-loading` uses the same setup to check confirmation, backups, failures,
and edits during loading. The regular `npm test` suite does not need browsers or labs.

## Gallery

`/admin_gallery game:<gist>` adds a game to the puzzlescript.net gallery. It is for the bot's
owner: Discord shows it to the server's administrators only (it cannot be hidden from them), and
the bot answers nobody but `OWNER_USER_ID`. The design is in
`docs/superpowers/specs/2026-10-08-admin-gallery-design.md`.

The answer is a link, good for six hours, to a page of the bot's at `gallery/` under the public
app address. The page runs the game in the engine of the PuzzleScript checkout, exactly as
`play.html` does, so realtime games work there. Pick a level and play it; **Make GIF** replays
what was pressed since the level was started into a looping GIF of the level, as the editor's
recorder does. Title, author and homepage are filled in from the game and can be changed.
**Submit** then:

1. makes one commit to `increpare/PuzzleScript` master, adding `src/Gallery/gifs/<gist id>.gif` and
   the game's record at the end of `src/games_dat.js`;
2. writes the same GIF and record into the live site's directory, so the gallery shows the game at
   once;
3. adds the record to the bot's own copy of the list, so `/play` suggests the game at once.

If the commit fails nothing else is done. If a later step fails the page says which, and the
commit stands.

Settings, all of which are needed (and `DISCORD_CLIENT_SECRET`, for the http server):

- `OWNER_USER_ID`: the owner's Discord user id.
- `GALLERY_TOKEN`: a fine-grained GitHub token for the PuzzleScript repository alone, with
  Contents read and write.
- `GALLERY_SITE_DIR`: the directory puzzlescript.net is served from on this machine, as an
  absolute path. It has `games_dat.js` and `Gallery/gifs/` in it.

Run `node register-commands.js` where these are set (the server): run without them, it registers
the other commands and takes `/admin_gallery` away.

Things to know:

- Pull PuzzleScript before the next `upload`: an upload from a checkout without the bot's commit
  puts the old `games_dat.js` back on the live site.
- `deploy.sh` copies `games_dat.js` from the submodule. Until the submodule is moved on to the
  bot's commit, a deploy drops the game from what `/play` suggests (not from the site).
- The GIF on the live site is as the page made it until the next `upload`, which optimises the
  gallery's GIFs.
- A GIF may be 2 MB at most. There is no removing or changing an entry from Discord.

`npm run test:gallery-browser` checks the page in Chromium with the real engine and a stand-in for
the submitter. Like the workshop's browser check, it needs a labs checkout with Playwright.

## Skinner of the Day

Each day the bot posts one of David W. Skinner's Sokoban puzzles in the channel named by
`SKINNER_CHANNEL_ID`, as "Skinner of the Day: Microban II.3", with a game of it underneath as
`/play` would start it. Without that channel, or without `GIST_TOKEN`, it posts nothing.

- The puzzles are his Microban I to IV and Sasquatch I to XI, 1043 in all, in `skinner/sets/` as
  he published them (Microban V and Sasquatch XII, which his page names, are not on the mirror they
  came from). His page says the sets may be freely distributed provided they remain properly
  credited.
- Each puzzle is a game of one level: the Microban demo of PuzzleScript (`skinner/game.txt`) around
  it, with one glyph added to the legend, `+` for the player on a target. `skinner.js` writes the game.
- On the day a puzzle is posted its game is made a public gist under `GIST_TOKEN`'s account, which
  is what the play link points at. A puzzle that comes round again keeps its gist.
- The puzzle is picked at random from those not yet posted; when all have been, from all again.
  The 19 puzzles too big to be drawn at more than 5 px a cell (wider than 40 cells or taller than
  30) are never picked.
  It is posted from `SKINNER_HOUR_UTC` on (9 by default), once per day by the UTC calendar. If
  GitHub or Discord fails it is tried again an hour later with the same puzzle. A day on which the
  bot was not running is skipped.
- `data/skinner.json` records the day of the last post, the puzzles posted and their gists.
- The games' `homepage` is `https://games.increpare.com/puzzlescriptbot/skinner.html`
  (`skinner/skinner.html`, published by `deploy.sh`), which credits him and links to his page.
  play.html makes every homepage an https link, and his page is not served over https, so a game
  cannot link to it directly. The post in Discord does.

## Scores

Whoever makes the winning move on a level gets credit for it, once per game and level, but only on the server named by `DISCORD_GUILD_ID`: wins anywhere else (another server, a DM) do not count. Ranks rise at 1, 5, 10, 15, 20, 25, 30, 40, 50, 60, 70, 80, 90 and 100 levels. Rank-ups are announced in the channel named by `SCORE_CHANNEL_ID` only (or in the game's channel if unset). `/rank` shows your own count privately. Scores live in `data/scores.json`.

## Keyword roles

`/role <keyword>` gives you a joke role named after a PuzzleScript keyword: CRATE, PLAYER, BACKGROUND, WALL, TARGET, DIRECTION, SFX or WIN. You hold one at a time, so picking another swaps it, and `/role none` drops it. Replies are private.

The bot does not create the roles. Each must exist on the server under the keyword's name (capitalisation does not matter), and the bot's own role must sit above them in the server's role list, or Discord refuses the change. The bot only ever touches roles on the list in `roles.js`. To add a keyword, add it there, create the role on the server, and run `node register-commands.js` again.

## Typed moves

The ⌨️ button under a game opens a box for a line of moves: `u d l r` for the directions, `x` for action and `z` for undo. Restart has no letter. Capitals, spaces and commas are ignored. Any other letter refuses the whole line, and so does `x` or `z` in a game that has no action or no undo.

The moves are made as one press, by whoever typed them, and the game's message is redrawn once with one GIF of the whole run: where it started, then a move every 150 ms. The turns of an `again` chain inside the run go by at the game's own `again_interval`. The run stops where a level is solved, a message comes up or the game stops taking moves (an animation that loops), and whoever typed is told privately how many of the moves were made. Only those are recorded. The whole line shares one move's time limit of 20 s.

A line holds at most 50 moves. Discord cuts an animation short past a length it does not publish, and fifty moves are about eight seconds.

## Sounds

`/sfx 36772507` posts the sound of that seed as a WAV file. `/sfx explosion` makes a new seed of that kind, the way the editor's sound buttons do (the ten kinds are suggested as you type), and `/sfx` alone picks a kind. The reply gives the seed, to copy into a game's SOUNDS section.

The sound is made by the engine's own generator and put through the filter the editor plays it through. The noise in a sound differs from one playing to the next, as it does in the editor: the engine does not seed it.

## Sprites

`/sprite` opens a box for object definitions as an OBJECTS section holds them (colours, then five rows of five; a name above them is optional), and posts them drawn large on a transparent background, with their text for others to copy. A whole OBJECTS section can be pasted, heading and all; up to 40 objects are drawn.

They are read by the engine's own parser, so what it would refuse in a game is refused here in the same words. Colours are those of the default palette.

Both commands are for everyone, in every channel. After a change to either, run `node register-commands.js` again.
