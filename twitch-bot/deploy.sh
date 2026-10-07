#!/usr/bin/env bash
# twitch-bot/deploy.sh — sync the engine, the shared bot code and the Twitch bot to the Pi.
# It has its own directory there, so it never disturbs the Discord bot in ~/puzzlescript-bot.
# The status shown is cut to 5 lines because the full one has ffmpeg's command line, and so the stream key.
set -euo pipefail
HOST="${PSTWITCH_HOST:-box@192.168.178.69}"
DEST="${PSTWITCH_DEST:-puzzlescript-twitch}"
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
# The engine comes from the puzzlescript submodule, or from the checkout named by PUZZLESCRIPT_DIR.
PS="${PUZZLESCRIPT_DIR:-$ROOT/puzzlescript}"
[ -f "$PS/src/js/engine.js" ] || { echo "No engine in $PS/src — run: git submodule update --init" >&2; exit 1; }

ssh "$HOST" "mkdir -p ~/$DEST/puzzlescript/src ~/$DEST/discord-bot ~/$DEST/twitch-bot ~/.config/systemd/user"
rsync -az --delete "$PS/src/js/" "$HOST:~/$DEST/puzzlescript/src/js/"
rsync -az "$PS/src/games_dat.js" "$HOST:~/$DEST/puzzlescript/src/games_dat.js"
rsync -az --delete --exclude node_modules --exclude data --exclude .env --exclude test "$ROOT/discord-bot/" "$HOST:~/$DEST/discord-bot/"
rsync -az --delete --exclude node_modules --exclude data --exclude .env "$HERE/" "$HOST:~/$DEST/twitch-bot/"
ssh "$HOST" "cd ~/$DEST/twitch-bot && cp puzzlescript-twitch.service ~/.config/systemd/user/ && systemctl --user daemon-reload \
  && if [ -f .env ] && [ -f data/music-index.json ]; then \
       systemctl --user enable puzzlescript-twitch >/dev/null && systemctl --user restart puzzlescript-twitch && sleep 3 \
       && if systemctl --user is-active --quiet puzzlescript-twitch; then \
            systemctl --user --no-pager status puzzlescript-twitch | head -5; \
          else \
            echo 'puzzlescript-twitch is not running; its last log lines:'; journalctl --user -u puzzlescript-twitch -n 20 --no-pager; exit 1; \
          fi; \
     else echo 'Synced, not started: create .env and run node index-music.js first (see README.md).'; fi"
