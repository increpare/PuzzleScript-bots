# PuzzleScript Discord play bot

Play a PuzzleScript game inside a Discord channel. `/play <gist>` posts the
level as an image with move, action, undo and restart buttons. Anyone in the
channel can press them. Realtime games are not supported.

## Layout

The bot loads the engine from `../src/js`, so it must sit beside a copy of
`src/`. `deploy.sh` syncs both to `~/puzzlescript-bot/` on the Pi.

## Setup (once)

1. Create a Discord application at https://discord.com/developers/applications,
   add a Bot, copy the token. Invite it with scopes `bot` and
   `applications.commands` and permissions Send Messages, Attach Files,
   Embed Links.
2. On the Pi: `cp .env.example .env` in `~/puzzlescript-bot/discord-bot/` and
   fill in the four keys. `DISCORD_GUILD_ID` is the server id.
3. `node register-commands.js` once (on the Pi or locally with the same `.env`).
4. If the service should survive logout/reboot: `sudo loginctl enable-linger box`.

Typing `/play` suggests games from the puzzlescript.net gallery; any gist id or play link also works.

## Deploy

    ./deploy.sh

## Run locally

    npm install && npm test
    node bot.js        # needs .env

## Operations

- Logs: `journalctl --user -u puzzlescript-bot -f`
- Games persist under `discord-bot/data/games/`, gist cache under `data/gists/`.
  Games never expire by age. Per-game records (seed and input history) are capped at 1 MB in total and game data at 100 MB (`data/sources/` holds every game's source once, by hash, up to 99 MB; `data/gists/` is a small index of gist id to source, up to 1 MB); over a cap, finished games go first, then the least recently played. A game keeps its original source, so editing a gist does not affect games already started unless that source has been evicted.
- Every frame is 400×300 px (matches Discord's embed placeholder size so the panel never resizes).
- Limits: 1 MB source, 10 s compile, 3 s for any single turn of the engine, 20 s for a move's whole chain of `again` turns, 30 live games.

## Again chains and animation

A move that sets off `again` turns is shown as one animated GIF, a frame per turn at the game's
`again_interval`. A chain that ends plays once and rests on the final state (its first frame is the
final state for one blink, so a client that shows GIFs as stills still shows the right board, and
its last frame is held for the longest a GIF allows in case a viewer loops it anyway).

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

## Scores

Whoever makes the winning move on a level gets credit for it, once per game and level. Ranks rise at 1, 5, 10, 15, 20, 25, 30, 40, 50, 60, 70, 80, 90 and 100 levels. Rank-ups are announced in the channel named by `SCORE_CHANNEL_ID` only (or in the game's channel if unset). `/rank` shows your own count privately. Scores live in `data/scores.json`.
