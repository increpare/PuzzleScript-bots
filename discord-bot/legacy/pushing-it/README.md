# Pushing It — Jack Lance

Unmodified `script.txt` from [Jack Lance's published gist](https://gist.github.com/JackLance/2fe3172d2b9fe684977d184f1b6226d5), revision `922c1a2fbf1fb887b3903f350c0af6cd0fbc8b9c` (2021-04-13).

- Original play link: https://www.puzzlescript.net/play.html?p=2fe3172d2b9fe684977d184f1b6226d5
- Raw source: https://gist.githubusercontent.com/JackLance/2fe3172d2b9fe684977d184f1b6226d5/raw/85292132d168e2bc8892fd98fcf81cb60fe0d8e6/script.txt
- SHA-256: `c7c54bd07ead0d24de38bda35d093e3daf1cb9d50ba724e997d3efdc719db3a0`

The homepage metadata contains the real game's JavaScript, executed by an HTML event handler. PuzzleScript's `play.html` explicitly retains this behaviour for this gist ([issue 829](https://github.com/increpare/PuzzleScript/issues/829)). The visible PuzzleScript rules and single level are a decoy. The payload implements twelve levels, continuous collision detection, sprite rotation, Canvas drawing and timed piston movement.

The bot serves this preserved source for the original gist and selects a dedicated host only when the complete source fingerprint matches. `pushing-it-host.js` executes the original payload with Canvas 2D and a deterministic timer queue. No game mechanics or level data in this file have been rewritten. Other homepage metadata remains inert. Changes to this file require an explicit review and a new fingerprint.

The adapter supplies muted audio and browser globals, maps Discord controls to the original functions, advances timed callbacks to completion (or a deterministic step cap), captures the original 400×300 drawing, and reports the custom level index to the bot. The usual PuzzleScript level editor is unavailable because it cannot represent the game's custom geometry.
