# Workshop feedback

Approved in chat on 8 October 2026. Signals belong in the shared code editor.

## Controls and downloads

Replace the workshop's sound-button handler with one which generates and prints a playable seed without reading the cross-origin parent frame. Keep these adaptations in the bot, rather than modifying the separate labs checkout.

Keep EXPORT's standalone HTML output. In Discord, replace its blob download with an authenticated upload of the generated file and the current source text. Print ordinary HTTPS download links in the editor console; use Discord's existing external-link command to open them. Outside Discord, retain the browser download.

Files are immutable snapshots, held in memory for 15 minutes, under unguessable tokens. Downloads require possession of the token, with no session token in a URL. Bound both request size and total memory. Serve files as attachments with nosniff. The public app URL is configurable, defaulting to the existing Caddy app address. Export does not create a gist or send channel messages.

## Presence and signals

Move cursor name labels below the caret whenever they would clip above the editor viewport, and constrain their horizontal position to the viewport. Names in the participant list are keyboard-accessible buttons; clicking scrolls the code editor to that person's mapped cursor without moving the local selection. Disable names without a known code position.

Two right clicks within 400 ms and six pixels in the code editor create a five-second signal at the clicked document position. One right click keeps its normal context menu. Broadcast authenticated, bounded signals through the existing long-poll channel; derive the sender's name and colour from the session. Map positions through document changes, expire signals on every client, and display a coloured pulse and sender name. Off-screen signals have a clickable arrow at the editor edge which scrolls to the position. No signal edits the shared text or enters undo history.

Debug-window peeking is outside this scope: compilation, execution and debugging currently belong to each browser.

## Validation

Use Node regression tests for exports, HTTP access and signal expiry/validation. Use Chromium with the real labs editor for sound buttons, standalone export, name-label placement, roster navigation, double-right-click delivery, off-screen arrows, expiration and concurrent document edits. Run the complete Discord bot suite. Preserve existing animation edits.
