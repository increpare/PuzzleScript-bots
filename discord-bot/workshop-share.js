'use strict';

const HOUR = 60 * 60 * 1000;
const refuse = (error) => ({ ok: false, error });

// The title a game gives itself, or null.
function titleOf(source) {
  const m = /^[ \t]*title[ \t]+(.+?)[ \t]*$/im.exec(String(source));
  return m ? m[1] : null;
}

// The workshop's Share: the room's game as a public gist, which is what a puzzlescript.net play
// link points at. The editor's own Share signs each person in to GitHub with a pop-up, which
// Discord's frame does not allow, so here the bot makes the gist, under a GitHub account of its own.
// The gist is shaped exactly as the editor's own share shapes it.
function createSharer({ token, fetchImpl = globalThis.fetch, now = Date.now, perUserHour = 5, perHour = 30 }) {
  const shared = []; // { uid, at } for each share in the last hour

  function recent() {
    while (shared.length && now() - shared[0].at >= HOUR) shared.shift();
    return shared;
  }

  async function share(uid, text) {
    if (typeof text !== 'string' || text.trim() === '') return refuse('there is nothing to share yet');
    if (recent().filter((s) => s.uid === uid).length >= perUserHour) return refuse('you have shared ' + perUserHour + ' games in the last hour; try again later');
    if (recent().length >= perHour) return refuse('the workshop has shared ' + perHour + ' games in the last hour; try again later');
    const title = titleOf(text);
    let res;
    try {
      res = await fetchImpl('https://api.github.com/gists', {
        method: 'POST',
        headers: {
          'user-agent': 'puzzlescript-discord-bot',
          accept: 'application/vnd.github+json',
          authorization: 'Bearer ' + token,
          'x-github-api-version': '2022-11-28',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          description: title === null ? 'Untitled PuzzleScript Script' : title + ' (PuzzleScript Script)',
          public: true,
          files: {
            'readme.txt': { content: 'Play this game by pasting the script in http://www.puzzlescript.net/editor.html' },
            'script.txt': { content: text },
          },
        }),
      });
    } catch (e) { return refuse('GitHub could not be reached'); }
    if (res.status === 401 || res.status === 403) return refuse("GitHub did not accept the bot's token");
    const body = res.ok ? await res.json().catch(() => null) : null;
    const id = body && typeof body.id === 'string' && /^[0-9a-f]{4,40}$/i.test(body.id) ? body.id.toLowerCase() : null;
    if (id === null) return refuse('GitHub answered with an error (' + res.status + ')');
    shared.push({ uid, at: now() });
    return {
      ok: true, id, title: title === null ? 'Untitled' : title,
      playUrl: 'https://www.puzzlescript.net/play.html?p=' + id,
      editUrl: 'https://www.puzzlescript.net/editor.html?hack=' + id,
    };
  }

  return { share };
}

module.exports = { createSharer, titleOf };
