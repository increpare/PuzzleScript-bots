# Twitch plays PuzzleScript — design

Date: 2026-10-07
Status: approved; updated 2026-10-07 to match what was built (see the plan's last section for what changed and why)

## Goal

A Twitch stream that runs unattended on the user's Raspberry Pi and loops
through the PuzzleScript gallery. Viewers play by typing moves in chat; every
command is applied immediately, in arrival order. The stream shows the game
inside a frame built from the game's own wall tiles, with a log of who made
which move, and plays the user's own music on shuffle.

It runs on the same Pi as the Discord bot (`box@192.168.178.69`, Raspberry
Pi 5, Ubuntu 24.04, node 18, ffmpeg 6.1.1) as a second `systemd --user`
service, deployed to its own directory so the two bots never share files.

## Non-goals

- Realtime games (`realtime_interval`). Skipped in the rotation.
- Game sound effects. Music only.
- The bot posting in chat. All feedback is on screen.
- Voting on moves. Commands are applied as they arrive.
- Title screens. Games start on a level, as in the Discord bot.
- Resuming mid-level after a service restart. The level reached is kept; the
  moves within it are not.

## Measurements this design rests on

Taken on the Pi, encoding to a null output or a local file, not to Twitch.

- Encoding cost is per frame and does not depend on content: an unchanged
  720p frame costs the same CPU as a changed one (about 13 ms with one encoder
  thread). The saving comes only from sending fewer frames.
- Letting x264 use its default threads nearly doubles CPU at low frame rates
  (21.8 vs 13.0 ms per frame). One thread is used.
- Building full-size frames in Node is slower than sending small frames and
  letting ffmpeg scale them (19% vs 15% of a core at 10 fps).
- A 30-second live-shaped run (frames sent only on change plus a 1-second
  heartbeat, audio fed in real time) used 6.4% of one core in total. Video
  timestamps followed the moment each frame was written to within 33 ms,
  keyframes fell every 1.97–2.00 s, and the audio had no gaps. Output left
  ffmpeg in bursts up to 1 s apart, because it holds audio until the next
  video frame arrives.
- The same run with keyframes spaced by frame count (one every second frame
  at 1 fps) used 6.5% of one core, with keyframes 0.30–2.00 s apart.
- With a move on every frame, a keyframe on every second frame costs about
  15% more CPU per frame than one every 2 s (15.2 vs 13.2 ms at 10 moves a
  second) and four to six times the video bitrate (383 vs 84 kbit/s at 10 a
  second, 695 vs 112 at 20), still far below the 2500 kbit/s cap.

## Components

New code lives in `twitch-bot/`, with its own `package.json` and no runtime
dependencies. It uses these `discord-bot/` modules as a library, unchanged
unless listed under "Changes to shared code": `engine-host.js`, `worker.js`,
`pool.js`, `renderer.js`, `gallery.js`, `gists.js`, `sources.js`, and
`parseEnv` from `config.js`. None of them require `discord.js`.

### Changes to shared code

- `engine-host.js`: new `host.frameTiles()` returning
  `{wall, background, player}`, each a sprite `{colors, dat}` (the shape used
  in snapshots) or `null`. A name is looked up in the compiled objects, then
  through legend synonyms, properties and aggregates (first member). `wall`
  falls back to the first object whose name contains `wall`. A sprite with no
  visible pixel counts as `null`.
- `worker.js` and `pool.js`: a `tiles` operation exposing `frameTiles()`.
- `renderer.js`: export `getGlyphs` so the frame can draw text with the
  engine font.

### `commands.js` — chat text to command

`parseCommand(text)` returns `{type: 'input', action}`, `{type: 'skip'}` or
`null`. The whole message, trimmed and lowercased, must be a command, so
ordinary chat never moves the player.

| Command | Accepted |
|---|---|
| up, down, left, right | the word, or `u` `d` `l` `r` |
| action | `action`, `a`, `x` |
| undo | `undo`, `z` |
| restart | `restart` only (it wipes the level) |
| continue past a message | `go` |
| vote to skip the game | `!skip` |

A single leading `!` is allowed on input commands (`!up`). Invisible format
characters are removed first, because some chat clients add them so that a
viewer can send the same message twice.

### `chat.js` — Twitch chat, read-only

A TLS connection to `irc.chat.twitch.tv:6697` logged in anonymously
(`NICK justinfan<digits>`), joined to `#<channel>`. Twitch's server accepted
this login when tried on 2026-10-07. It answers `PING`, parses
`PRIVMSG` lines into `{user, text}` where `user` is the login name (always
ASCII, so it renders in the engine font), and reconnects with backoff
(1 s doubling to 30 s, reset once a connection has lasted 30 s) on close,
error or a server `RECONNECT`. No Twitch token is needed.

### `rotation.js` — which game is next

- The gallery list (`loadGallery()`) in a shuffled order, reshuffled at the
  end of each pass. Order and position persist in `data/state.json`.
- `data/progress.json` maps gist id to the level index reached. A game starts
  at that level, or at 0 if the index is past the end. Finishing a game clears
  its entry.

### `session.js` — the game being played

Owns one game in the worker pool (pool size 1; compile limit 10 s, input
limit 3 s, as in the Discord bot) and everything chat does to it.

- **Loading**: a game is skipped if its source cannot be fetched, it fails to
  compile, it times out, it sets `realtime_interval`, or it has nothing to
  play. After 10 consecutive skips the session waits 60 s (GitHub is probably
  unreachable) and the stream shows a "back soon" message frame.
- **Inputs** go into a queue and are applied one at a time. At most 30 wait;
  more are dropped. The queue is emptied whenever the level changes or a
  message screen appears, so moves aimed at the old screen do not spill into
  the new one.
- **Message screens** wait for `go`. Nothing else gets past one, so moves
  typed for the screen before cannot skip it. `go` also carries on an `again`
  chain that the engine host paused at its step cap (`animating: 'more'`), and
  does nothing anywhere else. The message shows "type 'go' to continue" and the command list
  shows `go` while it is up.
- **Move log**: the last 12 applied commands with the login that sent them.
  Commands the game refuses (undo in a `noundo` game, and so on) are not
  logged.
- **Next game** when: the game is won (the finished screen shows for 10 s);
  `!skip` votes reach the threshold; or no command has been applied for
  15 minutes.
- **Skip threshold**: distinct voters needed is the smaller of 3 and half
  (rounded up) of the logins that had a command applied in the last
  10 minutes, and never less than 1. Votes clear when the game changes.
- **Progress**: whenever the level index increases, it is saved.
- **Disk trouble**: if saving progress or the game order fails, it is logged
  and play continues; a switch that cannot complete ends on the "back soon"
  screen and is retried after 60 s, never left half-done.
- A game that throws or times out mid-play is dropped and the rotation
  moves on.

### `frame.js` — the picture

`composeFrame(state)` is a pure function returning a 640×360 RGBA image;
ffmpeg doubles it to 1280×720. The canvas is a 64×36 grid of 10 px tiles
(5×5 sprites at ×2).

- **Walls** on tile rows 0 and 35, row 31 from column 0 to 41, and columns 0,
  41 and 63. Each wall tile is the game's background sprite with its wall
  sprite on top. If the game has no usable wall, the classic Sokoban brick
  (brown and dark brown) is used.
- **Game window**, 400×300 at (10, 10): `renderLevelRGBA` for a level,
  `renderTextRGBA` for message and finished screens.
- **Title strip**, under the game: title and author on the left, "level N of
  M" on the right, numbered as the Discord bot does (message screens are not
  counted); below, "music: <track> - <album>".
- **Side panel**, right: "TWITCH PLAYS" / "PUZZLESCRIPT" at double size; a
  row of the game's background tiles with its player sprite; "last moves"
  with the log, newest first, fading through the greys, each with a 5×5 icon
  for the command and the login truncated to fit; then the command list.
  The command list omits action, undo or restart when the game disables
  them, and shows the vote count once anyone has voted to skip.

Text uses the engine font and the default PuzzleScript palette. Nothing on
screen animates by itself: the frame is recomposed only when a command is
applied, the game changes, a vote is cast, or the music track changes.

### `music.js` and `index-music.js` — music

- `node index-music.js` scans the configured album folders under `MUSIC_DIR`
  with ffprobe and writes `data/music-index.json`: for each track its path,
  album (folder name without the leading "increpare - "), title tag and
  length. The music files are never copied or modified. The index is built
  once; rerun the script if the folders ever change.
- Albums: English Country Tune, Hypnocult, Mirror Stage, Moving Stories,
  Oiche Mhaith, Oeuvre (Oeuf OST). 214 tracks, 7.5 hours, all stereo MP3,
  half at 44.1 kHz and half at 48 kHz.
- Playback shuffles all tracks together, plays through, reshuffles, and never
  plays the same track twice in a row across a reshuffle.
- One track at a time is decoded by a short-lived ffmpeg to 44.1 kHz stereo
  PCM. About 2 s is buffered; the decoder is paused while the buffer is full.
- A track that fails to decode, cannot be started, or produces nothing for
  10 s is skipped; five failures in a row wait 30 s. Without an index, or
  with an empty one, the stream runs silent and says so in the log.
  `index-music.js` refuses to write an index with no tracks.

### `encoder.js` — the stream

Owns the long-lived ffmpeg process and is the only clock.

- **Video in**: 640×360 RGBA frames on stdin, stamped with their arrival time
  (`-use_wallclock_as_timestamps 1`). A frame is written when the picture
  changes, at most 20 per second (later changes within 50 ms replace the
  pending one), plus a heartbeat every `1 / MIN_FPS` seconds on a fixed grid.
  `MIN_FPS` defaults to 1 and is kept between 1 and 20. An unchanged frame is
  sent only on the heartbeat.
- **Audio in**: PCM on a second pipe. Every 20 ms the encoder writes exactly
  as many samples as real time has advanced, taking them from `music.js` and
  filling any shortfall with silence. The audio timeline therefore tracks
  real time and cannot drift from the video however long the stream runs.
  The one exception is the system clock being stepped (time sync after a
  power cut, say), which moves only the video timestamps: the encoder notices
  a step of more than a second and restarts ffmpeg.
- **Encode**: scale ×2 nearest-neighbour; x264 `veryfast`, `zerolatency`, one
  thread, CRF 23 capped at 2500 kbit/s; AAC at 160 kbit/s; FLV to
  `rtmp://live.twitch.tv/app/<key>`.
- **Keyframes** are spaced by frame count, one every two seconds' worth of
  heartbeat frames (`-g 2` at 1 fps), so they are 2 s apart while idle and
  closer while the picture is changing. A rule based on stream time was
  tried first and dropped: it depends on how long ffmpeg takes to start,
  which cannot be known, and it let the gap reach 2.8 s.
- **Stalls**: if a pipe backs up, video frames are dropped (the next one
  carries the current picture anyway) rather than queued.
- **Restart**: when ffmpeg exits for any reason it is restarted after a
  backoff (2 s doubling to 60 s, reset after a minute of healthy running),
  the clocks are reset and the current frame is sent again. This also covers
  Twitch ending a broadcast at its 48-hour limit.
- A launch that fails (ffmpeg missing, or no pipes) goes through the same
  backoff.
- The stream key is never logged: ffmpeg's messages are logged line by line
  with both the output address and the key itself replaced. The key is still
  on ffmpeg's command line, so `ps` and the full `systemctl status` show it.

### `main.js`, config, service

`main.js` wires the parts together. Configuration is a `.env` file in
`twitch-bot/`:

| Key | Meaning |
|---|---|
| `TWITCH_CHANNEL` | channel whose chat is read |
| `TWITCH_STREAM_KEY` | stream key; put there by the user |
| `GITHUB_TOKEN` | for fetching gists |
| `MUSIC_DIR` | default `/mnt/media/increpare` |
| `MIN_FPS` | default 1; from 1 to 20 |
| `OUTPUT` | optional; a file path or URL replacing the Twitch address, for tests |
| `DATA_DIR` | default `twitch-bot/data` |

`data/` holds the gist and source caches (its own, built with the Discord
bot's store code), `music-index.json`, `state.json` and `progress.json`.

`deploy.sh` syncs `src/js`, `src/games_dat.js`, the `discord-bot/` code and
`twitch-bot/` to `~/puzzlescript-twitch/` on the Pi and restarts
`puzzlescript-twitch.service`. It does not touch the Discord bot's
deployment in `~/puzzlescript-bot/`.

## Testing

- Unit tests (`node --test`) with fakes for the pool, the clock and child
  processes: command parsing; rotation order, skipping and progress; session
  queueing, messages and `go`, log, votes and idle; frame composition checked at
  known pixels, including the brick fallback; music shuffle and decoder
  handover; encoder frame pacing, audio budgeting, backpressure and restart.
- Tests for `frameTiles()` and the pool `tiles` operation beside the existing
  Discord bot tests, which must keep passing.
- An end-to-end run: the real pipeline with `OUTPUT` set to a local file and
  a scripted chat, about 12 s, then ffprobe checks for one 1280×720 H.264
  stream and one AAC stream, keyframes at most 2.2 s apart, and continuous
  audio.
  Skipped where ffmpeg is not installed.

## To verify on the first live stream

These cannot be tested without the user's stream key.

1. Twitch accepts a stream whose video idles at 1 fps. If it does not, raise
   `MIN_FPS`. From the per-frame cost above, the whole pipeline should take
   roughly 11% of a core at 5 and 18% at 10.
2. Chat messages from the real channel arrive over the anonymous login. If
   not, add login with a token.
3. The 1-second output bursts cause no buffering for viewers. Raising
   `MIN_FPS` shortens them.
4. After a deliberately wrong stream key, the journal does not contain the
   key.
5. After pulling the Pi's power once, the stream comes back with picture and
   sound in step.
6. A repeated move sent from a third-party chat client is applied.
