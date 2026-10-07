# Twitch plays PuzzleScript

A stream that loops through the PuzzleScript gallery. Viewers type moves in
chat and each one is applied straight away, in the order it arrived. Realtime
games are skipped. Music is played on shuffle from the album folders on the Pi.

Design: `docs/superpowers/specs/2026-10-07-twitch-plays-puzzlescript-design.md`.

## Chat commands

| Type | To |
|---|---|
| `up` `down` `left` `right`, or `u` `d` `l` `r` | move |
| `action`, `a` or `x` | action |
| `undo` or `z` | undo |
| `restart` | restart the level |
| `!skip` | vote for the next game |

Any case. The whole message has to be the command. A leading `!` also works
(`!up`). The next game comes when the game is won, when enough viewers vote
`!skip` (3, or half of those who moved in the last ten minutes if that is
fewer), or after 15 minutes without a move.

Twitch itself rejects a message identical to the one the same viewer sent less than 30 seconds earlier, so to repeat a move, vary it: `up`, `u`, `UP` and `!up` all mean the same thing.

## Layout

The bot uses the engine in `../src/js` and several modules of `../discord-bot`
as a library, so it must sit beside copies of both. `deploy.sh` syncs all
three to `~/puzzlescript-twitch/` on the Pi, separate from the Discord bot.

## Going live (once)

1. `./deploy.sh` — the first run syncs the files and stops there.
2. On the Pi, in `~/puzzlescript-twitch/twitch-bot/`: `cp .env.example .env`
   and fill in the channel, the stream key and a GitHub token.
3. `node index-music.js` — lists the tracks into `data/music-index.json`. The
   music is only read. Run it again only if the album folders change.
4. `./deploy.sh` again — this time it starts the service.
5. If the service should survive logout and reboot: `sudo loginctl enable-linger box`.

## Check on the first stream

- Twitch accepts the stream and viewers see no buffering. While nothing is
  happening the video is 1 frame a second; if Twitch objects, set `MIN_FPS=5`
  (or 10) in `.env` and restart. Values below 1 are treated as 1.
- Typing `up` in chat moves the player and your name appears in the log.

## Run locally

    npm test                      # the end-to-end test needs ffmpeg
    OUTPUT=/tmp/test.flv TWITCH_CHANNEL=somechannel GITHUB_TOKEN=... node main.js

With `OUTPUT` set the stream goes to that file (or URL) and no stream key is needed.

## Operations

- Logs: `journalctl --user -u puzzlescript-twitch -f`
- Restart: `systemctl --user restart puzzlescript-twitch`
- `data/state.json` is the game order and position; `data/progress.json` is
  the level reached in each game. Delete either to reset it.
- ffmpeg is restarted automatically if it exits, which also covers Twitch
  ending a broadcast after 48 hours.
- Cost on the Pi 5: about 6% of one core while idle.
- The stream key is on ffmpeg's command line, so the output of `ps` and the full
  output of `systemctl --user status puzzlescript-twitch` contain it: do not
  paste either anywhere. The bot's own log never shows it.
