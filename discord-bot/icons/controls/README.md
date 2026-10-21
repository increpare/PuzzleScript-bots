# Control icons

Approved white symbols on blue (`#3B88C3`) tiles. Action uses a circled X and Replay game uses a plus.
The manifest associates game inputs and interface actions with their SVG source and 128x128 PNG.
Rebuild with `node scripts/build-control-icons.js` from `discord-bot/`.

The blue tile and directional arrows are adapted from [Twemoji](https://github.com/jdecked/twemoji),
by the Twemoji contributors, under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/).
The remaining symbols were drawn for this bot in the same style. The sources replace the normal
emoji artwork with a consistent set; colors and proportions have been kept close to the originals.

Application emoji names contain a hash of the PNG. Startup reuses matching uploads; changing a PNG
creates a new emoji without deleting older IDs referenced by existing messages.
