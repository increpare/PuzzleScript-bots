#!/usr/bin/env bash
# discord-bot/deploy.sh — sync the engine and bot to the Pi and restart the user service.
set -euo pipefail
HOST="${PSBOT_HOST:-box@192.168.178.69}"
DEST="${PSBOT_DEST:-puzzlescript-bot}"
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
# The engine comes from the puzzlescript submodule, or from the checkout named by PUZZLESCRIPT_DIR.
PS="${PUZZLESCRIPT_DIR:-$ROOT/puzzlescript}"
[ -f "$PS/src/js/engine.js" ] || { echo "No engine in $PS/src — run: git submodule update --init" >&2; exit 1; }

ssh "$HOST" "mkdir -p ~/$DEST/puzzlescript/src ~/$DEST/discord-bot ~/.config/systemd/user"
rsync -az --delete "$PS/src/js/" "$HOST:~/$DEST/puzzlescript/src/js/"
rsync -az "$PS/src/games_dat.js" "$HOST:~/$DEST/puzzlescript/src/games_dat.js"
rsync -az --delete --exclude node_modules --exclude data --exclude .env "$HERE/" "$HOST:~/$DEST/discord-bot/"
ssh "$HOST" "cd ~/$DEST/discord-bot && npm ci --omit=dev --no-audit --no-fund \
  && cp puzzlescript-bot.service ~/.config/systemd/user/ \
  && systemctl --user daemon-reload \
  && systemctl --user enable puzzlescript-bot >/dev/null \
  && systemctl --user restart puzzlescript-bot \
  && sleep 2 && systemctl --user is-active --quiet puzzlescript-bot && systemctl --user --no-pager status puzzlescript-bot | head -5"
