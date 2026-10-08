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
# The workshop's editor is the PuzzleScript-labs one. Labs is too big to be a submodule here, so its
# editor is copied from a checkout: by default the discord-workshop worktree of the labs checkout
# beside this repository.
LABS="${PUZZLESCRIPT_LABS_DIR:-$ROOT/../PuzzleScript-labs/.claude/worktrees/discord-workshop}"
# The privacy policy and terms registered with Discord are plain files, served by the web server on
# the same machine as https://games.increpare.com/puzzlescriptbot/. They are published with the
# bot, so that what they say is never behind what the bot does.
LEGAL_DEST="${PSBOT_LEGAL_DEST:-www/puzzlescriptbot}"
# Node is installed in the home directory on the server (there is no root there), which a
# non-login shell does not have on its PATH.
REMOTE_PATH='export PATH="$HOME/.local/bin:$PATH"'

ssh "$HOST" "mkdir -p ~/$DEST/puzzlescript/src ~/$DEST/discord-bot ~/.config/systemd/user"
rsync -az --delete "$PS/src/js/" "$HOST:~/$DEST/puzzlescript/src/js/"
rsync -az "$PS/src/games_dat.js" "$HOST:~/$DEST/puzzlescript/src/games_dat.js"
rsync -az --delete --exclude node_modules --exclude data --exclude .env "$HERE/" "$HOST:~/$DEST/discord-bot/"
if [ -f "$LABS/src/editor.html" ]; then
  # The workshop's CodeMirror runtime is built from labs' runtime source and committed here. If
  # labs has changed that source since, the two no longer belong together.
  WANT="sha256:$(shasum -a 256 "$LABS/src/js/codemirror6/runtime/source/index.js" | cut -d' ' -f1)"
  grep -q "$WANT" "$HERE/activity/workshop/codemirror6-runtime.js" || { echo "the workshop's CodeMirror runtime was built from a different labs source: run discord-bot/scripts/build-workshop-runtime.sh" >&2; exit 1; }
  # only what the editor page loads: nothing else of labs is put on the server
  ssh "$HOST" "mkdir -p ~/$DEST/labs/src"
  rsync -az --delete --delete-excluded \
    --include='/editor.html' --include='/standalone_inlined.txt' --include='/js/***' --include='/css/***' --include='/images/***' \
    --include='/demo/***' --include='/fonts/***' --include='/Documentation/' --include='/Documentation/ico/***' \
    --exclude='*' "$LABS/src/" "$HOST:~/$DEST/labs/src/"
else
  echo "no labs editor in $LABS/src: the workshop page is not deployed" >&2
fi
if ssh "$HOST" "[ -d ~/$LEGAL_DEST ]"; then
  # skinner.html is the homepage of the Skinner of the Day's games (see skinner.js)
  rsync -az "$HERE/legal/puzzlescriptbot_privacy.html" "$HERE/legal/puzzlescriptbot_terms.html" "$HERE/skinner/skinner.html" "$HOST:~/$LEGAL_DEST/"
else
  echo "no ~/$LEGAL_DEST on $HOST: the privacy, terms and Skinner pages were not published" >&2
fi
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
