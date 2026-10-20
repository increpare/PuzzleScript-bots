# Custom Discord control icons

**Goal:** Ship the approved blue-tile icon set, circled-X Action, and plus-labelled New game button on master.

**Architecture:** Keep SVG sources and 128px PNG uploads in `discord-bot/icons/controls/`. Before starting the bot, list application-owned emoji and upload missing assets using content-versioned names. Feed the resulting custom emoji objects into presentation. Reuse existing uploads and retain old versions so older messages keep their icons. No guild emoji or message permissions need changing.

## Steps

- [x] Add focused tests for repeated startup, recovery after a partial upload, and custom icons across playing, animation, message and finished states.
- [x] Run the new tests before implementing the missing uploader.
- [x] Copy the approved SVG/PNG assets and manifest into the repository.
- [x] Implement `syncControlIcons(rest, appId)` and presentation configuration; initialize before workers and Discord interactions.
- [x] Rename the finished-game button to New game and update existing expectations and README.
- [x] Run focused tests, the full Discord suite and diff checks; review startup and upload failure behavior.
- [ ] Commit on master, push, deploy, and verify application emoji, deployed file hashes and Discord login.

Verification before release: all 426 Discord tests pass; focused tests pass 40/40; rebuilding SVGs reproduces the approved PNGs exactly. The live bot can list application emoji. Independent review found no actionable issues.
