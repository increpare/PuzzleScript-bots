'use strict';
const { GalleryError } = require('./gallery-entry');

const GAMES_DAT = 'src/games_dat.js';

// The PuzzleScript repository, as far as the gallery needs it: its list of games can be read, and
// a game can be added to it. The token is a fine-grained one for that repository alone, with
// contents write.
function createGalleryRepo({ token, fetchImpl = globalThis.fetch, repo = 'increpare/PuzzleScript', branch = 'master' }) {
  const api = 'https://api.github.com/repos/' + repo + '/';

  async function call(method, path, body, { raw = false } = {}) {
    let res;
    try {
      res = await fetchImpl(api + path, {
        method,
        headers: {
          'user-agent': 'puzzlescript-discord-bot',
          accept: raw ? 'application/vnd.github.raw+json' : 'application/vnd.github+json',
          authorization: 'Bearer ' + token,
          'x-github-api-version': '2022-11-28',
          'content-type': 'application/json',
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (e) { throw new GalleryError('GitHub could not be reached'); }
    if (res.status === 401 || res.status === 403) throw new GalleryError('GitHub did not accept the gallery token');
    if (!res.ok) {
      // what GitHub says is wrong, when it says
      const said = await res.json().then((b) => (b && typeof b.message === 'string' ? b.message : ''), () => '');
      throw Object.assign(new GalleryError('GitHub answered with an error (' + res.status + (said ? ': ' + said : '') + ')'), { status: res.status, said });
    }
    return raw ? res.text() : res.json();
  }

  const shaOf = (answer) => {
    const sha = answer && (answer.object ? answer.object.sha : answer.sha);
    if (typeof sha !== 'string' || !sha) throw new GalleryError('GitHub answered with something unexpected');
    return sha;
  };
  const headOf = async () => shaOf(await call('GET', 'git/ref/heads/' + branch));
  const gamesDatAt = (sha) => call('GET', 'contents/' + GAMES_DAT + '?ref=' + sha, undefined, { raw: true });

  return {
    async readGamesDat() {
      return gamesDatAt(await headOf());
    },

    // One commit on the branch that adds the picture and the edited list. edit(text) is given the
    // list as it is at the head the commit is made on. The branch is never forced: if somebody
    // else commits in the meantime, it is all done once more from where the branch then is.
    async addGame({ gifPath, gif, edit, message }) {
      for (let attempt = 0; ; attempt++) {
        const head = await headOf();
        const commit = await call('GET', 'git/commits/' + head);
        const edited = edit(await gamesDatAt(head));
        const blob = shaOf(await call('POST', 'git/blobs', { content: gif.toString('base64'), encoding: 'base64' }));
        const tree = shaOf(await call('POST', 'git/trees', {
          base_tree: shaOf(commit.tree),
          tree: [
            { path: gifPath, mode: '100644', type: 'blob', sha: blob },
            { path: GAMES_DAT, mode: '100644', type: 'blob', content: edited },
          ],
        }));
        const made = shaOf(await call('POST', 'git/commits', { message, tree, parents: [head] }));
        try {
          await call('PATCH', 'git/refs/heads/' + branch, { sha: made, force: false });
        } catch (e) {
          // The branch is no longer where the commit was made from. (Any other refusal, such as
          // a protected branch, is not something trying again would get past.)
          if (e.status !== 422 || !/fast.forward/i.test(e.said)) throw e;
          if (attempt === 0) continue;
          throw new GalleryError('the repository kept changing; try again');
        }
        return { commitUrl: 'https://github.com/' + repo + '/commit/' + made };
      }
    },
  };
}

module.exports = { createGalleryRepo };
