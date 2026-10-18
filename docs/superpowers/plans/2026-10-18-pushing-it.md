# Pushing It Implementation Plan

> Execute inline in this chat, following the approved design and test-first verification. Source and host changes share state and are performed sequentially.

**Goal:** Play Jack Lance's original Pushing It seamlessly in Discord.

**Architecture:** Fingerprint the preserved source, route it to a dedicated host, and execute the original payload with Canvas 2D and virtual timers. Adapt its raster output and game state to the existing worker, persistence and presentation interfaces.

**Tech Stack:** Node.js VM, @napi-rs/canvas, node:test, existing PuzzleScript submodule, PNG/GIF writers.

- [x] Preserve `discord-bot/legacy/pushing-it/script.txt` unchanged, document revision/hash/attribution, and add source recognition and offline gist resolution. Test offline lookup and source verification before implementing resolution.
- [x] Add `discord-bot/pushing-it-host.js` and a source-aware `discord-bot/game-host.js` factory. First assert twelve levels rather than the decoy's one, movement/undo/restart, and replay using the real source. Run `node --test test/pushing-it.test.js`, observe missing behaviour, then implement and rerun.
- [x] Implement deterministic timer draining with stable equal-time ordering, progress callbacks, deadlines, replay budget, callback step cap and frame capture. Test piston motion, continuation, failure rollback through worker disposal and game isolation.
- [x] Add raster handling to `discord-bot/renderer.js` and `discord-bot/animation.js`. First test rendered PNG dimensions/pixels and GIF frames/delays. Preserve the current tile path and test suite.
- [x] Route `discord-bot/worker-ops.js` through the factory; test actual worker load/play/run/rebuild. Mark the game uneditable in metadata, hide the pencil in `presentation.js`, and reject direct requests in `bot.js`. Add presentation coverage.
- [x] Add a browser comparison script using the original payload and engine; compare custom state and canvas across levels and inputs, including fractional and rotated geometry. Verify a real solution and final completion.
- [x] Update `discord-bot/README.md`, run the Discord and Twitch suites with local HTTP permissions, review the complete diff, and report results and any remaining limitations. Keep the branch local.

Verification: 419 Discord tests and 133 Twitch tests passed. The Chromium check compared 87 states across all twelve levels: geometry and undo history were identical, with a worst mean channel error of 0.00574. The real first-level solution advances normally; the original final win callback finishes the game. Review found and verified a fix for old records retaining decoy metadata: fingerprint-matched records now receive the preserved game metadata before interactions are handled. No deployment or push was performed.
