# Next level button

Approved behavior: Discord retains the solved board and its ending GIF until the player presses Next level. Winning awards credit immediately; advancing awards none. Messages keep their existing Continue action. Only Next level is offered on a solved board, including the final level; that last press opens the finished screen. Twitch retains automatic advancement.

Implementation:
- [x] Add regression tests for solved frames, blocked inputs, explicit advancement, final levels, typed runs, persistence, solver attribution, and Pushing It.
- [x] Add an optional manualAdvanceFrom input-log boundary to both hosts' load options, propagated through the pool/worker. The default remains automatic for existing engine callers and Twitch. Historical inputs before the boundary replay automatically; newer inputs replay with explicit advancement.
- [x] New Discord records use boundary zero; older records use their existing input count and retain legacy startup progression. Detect solves from the snapshot's won flag as well as legacy transitions; preserve the solver when another player advances.
- [x] Show a labeled Next level button and solved footer, retaining the final board/GIF. Document the interaction.
- [x] Run focused tests, then the Discord and Twitch suites; review the diff.

Validation: all 12 next-level regression tests and the Twitch suite (133 tests) pass. Code review found and verified fixes for legacy startup replay and refused inputs replacing the ending GIF. The full Discord suite is also checked with localhost access for its HTTP tests.
