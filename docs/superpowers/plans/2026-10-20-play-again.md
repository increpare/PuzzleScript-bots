# Play again implementation plan

**Goal:** Offer a fresh public game from a completed normal game, with a jump link.

**Architecture:** Add a separate `ps:replay` presentation action and a small interaction
handler in `discord-bot/play-again.js`. Keep `ps:again` for sent levels. Wire replay
before normal move handling in `bot.js`; reuse the existing registry and frame function.

**Tech stack:** Node.js, discord.js, node:test, existing PuzzleScript registry.

- [x] Add failing presentation and interaction tests, including a real registry replay.
- [x] Add the replay button and handler; wire finished frames and button dispatch.
- [x] Run focused tests, both bots' suites and `git diff --check`.
- [x] Document the interaction and review the final diff.

Verification: the clean release based on master passed all 435 Discord tests and
all 133 Twitch tests. JavaScript syntax checks and `git diff --check` passed.
