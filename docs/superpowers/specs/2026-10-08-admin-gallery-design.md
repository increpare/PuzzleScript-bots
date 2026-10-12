# Adding games to the gallery

Approved in chat on 8 October 2026.

The owner adds a game to the PuzzleScript gallery from Discord: a command hands out a private link to a submission page, where the game is played in the real engine, a GIF is made of one level's play, and one press files the game in the PuzzleScript repository and on the live site.

Recording from `/play` was considered and dropped: `/play` rightly refuses realtime games, and the gallery has to take them.

## The command

`/admin_gallery game:<gist id or link>`, registered in the PuzzleScript server with no default member permissions, as `/workshop` is. Discord then hides it from everyone but server administrators; it cannot be hidden from them. The bot refuses anyone whose user id is not `OWNER_USER_ID`.

The answer is ephemeral: a link to the submission page. The link carries a token signed by the existing signer, `{ kind: 'gallery', uid, gistId }`, good for six hours. It is carried in the URL fragment, which is never sent to a server; the page hands it back in an `Authorization` header.

The command is registered and answered only when `OWNER_USER_ID`, `GALLERY_TOKEN`, `GALLERY_SITE_DIR` and the client secret (without which there is no http server) are all set.

## The page

A plain browser page at `<public app url>/gallery/`, served from `discord-bot/activity/gallery/`. It is not a Discord Activity.

It runs the unmodified master engine from the submodule: the scripts `play.html` loads, and the `jsgif` encoder the editor uses. `play.html`'s `debug_off.js` leaves the engine's two recording hooks, `pushInput` and `clearInputHistory`, empty; the page's own script replaces them, and so records every input, ticks included. (The editor's `debug.js` records too, but needs the editor's console.) The engine's scripts are served under their own path, `/gallery/engine/js/`, apart from the labs editor's `js/` that the workshop serves. Nothing in the submodule is changed.

On opening, the page asks `GET /api/gallery/game` for the game: `{ gistId, source, inGallery }`. A game already in the gallery is said to be so and cannot be submitted.

- **Level picker.** The game's levels, numbered from 1 with message screens left out. Choosing one loads it, and it is played with the keyboard in a play area fixed at 400 by 400 pixels, so that GIFs come out the size of those already in the gallery.
- **The take.** The inputs made since the level was loaded, and the random seed it was loaded with. "Start again" reloads the level and empties the take. The engine calls `clearInputHistory` when play moves on to another level; from then the take is closed, as it stood when the level was won, and later inputs are not added to it.
- **Make GIF.** Replays the take as the editor's `makeGIF` does: the same encoder, a looping GIF cropped to the level, moves at the repeat interval, ticks at the realtime interval, again turns at the again interval. It is the page's own code, since upstream's function prints its result into the editor's console. It differs from upstream in three ways: a frame identical to the one before it lengthens that frame rather than being added (a realtime game ticks many times with nothing moving); the replay does not go on to the next level, so a take that ends in a win ends on the solved level; and each frame is held for its own interval. Making a GIF closes the take, so the GIF submitted is always of the take shown.
- **The record.** Title, author and homepage fields, filled from the game's prelude and editable. They sit beside the GIF preview and the Submit button.

After a submission the page shows the commit and gallery links, or which step failed.

## Submission

`POST /api/gallery/submit` with `{ gif (base64), title, author, homepage }` and the token. The server checks, in this order:

- the token is a gallery token whose `uid` is the owner's;
- the GIF starts with a GIF signature and is at most 2 MB (the request body at most 3 MB);
- title and author are not empty, on one line and at most 100 characters; homepage is empty, or a plain web address (with or without `http(s)://`) of at most 200 characters. The gallery page writes a homepage into a link as it is, and the field is filled from the game's own prelude, so nothing that could end the link is let through;
- the gist is not already in master's `games_dat.js`.

The record is `{ url: "https://www.puzzlescript.net/play.html?p=<gist id>", thumb: "<gist id>.gif", title, author, homepage }`, with `homepage` left out when empty (the gallery page then links the game itself).

Submissions are handled one at a time.

### The edit to games_dat.js

One function appends a record to the text of a `games_dat.js`: before the closing `]`, in the file's own layout (two-space indent, trailing comma). It refuses a text that does not end as expected, and it checks its own result by evaluating it as `gallery.js` does: one entry more than before, the last being the record. The function is used for all three copies below, each edited from its own current text, so that a copy that differs from master keeps its differences.

### Landing

1. **The repository.** One commit to `increpare/PuzzleScript` master through the Git Data API (blobs, a tree on the current head's tree, a commit, a non-forced ref update), adding `src/Gallery/gifs/<gist id>.gif` and the edited `src/games_dat.js`, both read and based on master's head at that moment. If master moved in between, it is tried once more from the new head. The message is `gallery: add <title> by <author>`. `GALLERY_TOKEN` is a fine-grained token for that one repository with contents write.
2. **The live site.** The GIF is written to `GALLERY_SITE_DIR/Gallery/gifs/`, then `GALLERY_SITE_DIR/games_dat.js` is edited; each is written to a temporary file and renamed.
3. **The bot's own copy.** The `games_dat.js` beside the engine is edited and the cached gallery dropped, so that `/play` suggests the game at once.

The repository goes first: if it fails, nothing else is touched. If a later step fails, the answer says which, and the commit stands.

## Known limits

- An `upload` from a checkout that has not pulled the bot's commit puts the old `games_dat.js` back on the live site.
- `deploy.sh` copies `games_dat.js` from the submodule, so a deploy before the submodule is moved on drops the game from `/play`'s suggestions (not from the site).
- The GIF on the live site is not optimised until the next `upload`, which runs gifsicle over the gallery.
- `GALLERY_SITE_DIR` is expected to be `~/sites/puzzlescript` on the server, from the `upload` script; this is to be checked there before the feature is switched on.

Not in scope: removing or editing an entry, replacing a GIF, the gallery's `NSFW` flag, trimming a take.

The privacy page does not change: the only play recorded is the owner's own, and nothing new is kept about anyone.

## Validation

Node tests for the `games_dat.js` edit (layout kept, malformed text refused, duplicate refused), the token and owner checks on both endpoints, the size and field limits, the commit against a fake GitHub API (including one retry when master moves), and the site and bot-copy writes against a temporary directory, including what is left alone when the commit fails. A Chromium check of the page in the manner of `scripts/check-workshop-browser.js`, with a turn-based and a realtime game: pick a level, play, win, make a GIF, submit to a fake backend. Run the complete Discord bot suite. Update `README.md` and `.env.example`.
