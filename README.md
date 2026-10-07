# PuzzleScript bots

Two bots that play [PuzzleScript](https://github.com/increpare/PuzzleScript) games:

- [`discord-bot/`](discord-bot/README.md) — play a game inside a Discord channel.
- [`twitch-bot/`](twitch-bot/README.md) — a stream where chat plays through the gallery. It uses
  several modules of the Discord bot as a library.

## The engine

Both run the real PuzzleScript engine, which is the `puzzlescript/` submodule, pinned to one commit.
Clone with it:

    git clone --recurse-submodules <url>

or, in a clone made without it, `git submodule update --init`.

To move to a newer engine:

    git -C puzzlescript fetch origin master
    git -C puzzlescript checkout FETCH_HEAD
    (cd discord-bot && npm test) && (cd twitch-bot && npm test)
    git commit -m "Update the engine" puzzlescript

To run against another PuzzleScript checkout instead, for instance to try an engine change before
it is committed, set `PUZZLESCRIPT_DIR`. The tests, the bots and `deploy.sh` all follow it. It is
read from the environment itself, not from a bot's `.env` file:

    PUZZLESCRIPT_DIR=~/Documents/GitHub/PuzzleScript npm test
