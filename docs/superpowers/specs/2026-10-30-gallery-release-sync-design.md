# Gallery sources and release-triggered refresh

Approved in chat on 30 October 2026: support the gallery's new `source` links and refresh when a new thread is posted in releases channel `1562643319341715486`.

The bot reads `source` before `url`, using the same gist parser as `/play`. Play links, editor links and gist links work. Invalid source links fall back to the official link; an external page without a usable gist stays out of suggestions. Gallery identities are deduplicated, and gallery submissions recognize existing source links too.

A small gallery-sync module fetches `https://www.puzzlescript.net/games_dat.js` at startup and after a newly created thread in the configured releases channel and guild. Existing-thread join events and other channels do not trigger it. There is no hourly timer. `Guilds`, already requested by the bot, supplies these thread events. The bot does not read thread messages or post a response.

Downloaded JavaScript is parsed as a declaration containing JSON data, allowing the list's final trailing comma; it is never evaluated. Fetches have a ten-second timeout and a one-megabyte limit. Successful data is atomically cached as `data/gallery.json` and replaces the autocomplete list together with the existing community games. A failed request or invalid list leaves the current list alone. Restart loads the last good cache before fetching; missing cache uses the bundled list. Refreshes are serialized so a release during an earlier fetch still gets a later fetch.

`GALLERY_RELEASES_CHANNEL_ID` defaults to the requested channel and can be overridden. `/admin_gallery` still reloads its local addition immediately, then refreshes the published list. The existing engine and realtime restrictions are unchanged.

The eleven source links found in the preceding research are added to the main PuzzleScript checkout's `src/games_dat.js`, preserving existing entries and their official URLs. They are not published to GitHub or the website as part of the bot change.

Validation covers source-link precedence, fallback, deduplication, submission duplicate detection, startup cache restoration, correct new-thread filtering, overlapping requests, HTTP/parse/cache failures, malformed downloaded scripts, and configuration. Run the full bot suite, then smoke-check the real public list. Deploy only the changed bot files so unrelated local scoreboard work is not published. Verify the existing service is active and the gallery refresh succeeds; do not create a Discord test post.
