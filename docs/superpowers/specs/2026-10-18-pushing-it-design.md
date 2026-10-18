# Preserve Pushing It in the Discord bot

Approved in chat on 2026-10-18: use a dedicated JavaScript + Canvas host, preserving Jack Lance's original game.

The public gist `2fe3172d2b9fe684977d184f1b6226d5` puts its real game in an HTML event handler in the homepage metadata. `puzzlescript/src/play.html` deliberately allows this one gist's homepage to execute. Compiling it alone loads a decoy with one level; the payload contains twelve levels and replaces movement, drawing, undo, restart and level advancement.

Preserve the unmodified `script.txt` from gist revision `922c1a2fbf1fb887b3903f350c0af6cd0fbc8b9c`, with SHA-256 `c7c54bd07ead0d24de38bda35d093e3daf1cb9d50ba724e997d3efdc719db3a0`, attribution, and provenance. Resolve this gist from the bundled source, so starting it also works when GitHub is unavailable. Select the special host by the complete source fingerprint. Other sources keep the existing host; arbitrary homepage code is never executed.

The special host uses the existing engine context for the globals the payload expects, and @napi-rs/canvas for Canvas 2D. Decode and run only the payload in the verified source, without altering its mechanics. Translate bot inputs to its functions. Advance its setTimeout callbacks on a deterministic virtual clock, preserving due-time and insertion order. Drain animations before returning a settled snapshot, respecting the worker heartbeat, move deadline, replay allowance, step cap and frame-memory limit. Paused callback chains support continue; undo/restart cancel outstanding timers before restoring the game.

Expose the existing host interface: metadata for all twelve levels; level index and completion for scoring; individual inputs, typed runs, replay, snapshots, frames, and disposal. Starting at a selected level loads the original custom grid. Return the original canvas as a 400×300 raster; keep generic renderer and animation support for these raster frames. Retain the original animation delays and use a bounded GIF palette with the game's exact colours plus quantized antialias colours. Keep ordinary tile rendering unchanged.

The level editor cannot represent this game's continuous positions and rotations. Mark its metadata uneditable, omit the pencil, and reject stale/manual edit requests. Preserve the author's action-key behaviour, undo stack and restart behaviour. Persistence remains source + seed + input history, so replay must reproduce custom geometry, sprite orientation, level transitions and pending timers.

Verify the source fingerprint, offline lookup, all twelve level starts, original fractional and rotation mechanics, undo/restart, a real level solution, completion, replay, timeout handling, concurrent game isolation, still images, GIFs and worker/registry integration. Compare the adapter with the original payload running in a real browser at the same canvas dimensions. Run both bot suites; no deployment is part of this change.
