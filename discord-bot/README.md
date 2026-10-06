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

## Deploy

    ./deploy.sh

## Run locally

    npm install && npm test
    node bot.js        # needs .env

## Operations

- Logs: `journalctl --user -u puzzlescript-bot -f`
- Games persist under `discord-bot/data/games/`, gist cache under `data/gists/`.
  Idle games are pruned after 14 days.
- Editing a gist ends games in progress on it (the bot replays inputs against the original source and refuses to continue if it changed).
- Limits: 1 MB source, 10 s compile, 3 s per input, 30 live games.
