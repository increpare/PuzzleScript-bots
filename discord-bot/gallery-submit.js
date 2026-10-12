'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { GalleryError, hasGist, checkSubmission, galleryRecord, appendRecord } = require('./gallery-entry');
const { GistError } = require('./gists');

const GALLERY_URL = 'https://www.puzzlescript.net/Gallery/index.html';

// A file is written beside itself and moved into place, so that it is never seen half-written.
function writeWhole(file, data) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

// Adds a game to the gallery, which is kept in three places: the PuzzleScript repository, the
// live site (on the machine the bot runs on), and the copy of the list the bot suggests games from.
// repo: the repository (see gallery-github.js).
// siteDir: the live site's directory, with games_dat.js and Gallery/gifs/ in it.
// botGamesDat: the bot's own copy of games_dat.js.
// onAdded(record): called once a game is in, so that the bot can read its list again.
function createGallerySubmitter({ repo, getSource, siteDir, botGamesDat, onAdded = () => {}, log = console.error }) {
  let queue = Promise.resolve();

  // Each copy of the list is edited from its own text, so one that differs from the repository's
  // keeps its differences.
  const addToList = (file, record) => writeWhole(file, appendRecord(fs.readFileSync(file, 'utf8'), record));

  // null when done, else what went wrong, for the page to show.
  function attempt(what, fn) {
    try { fn(); return null; } catch (e) {
      log('gallery: ' + what + ' failed:', e && e.message);
      return (e && e.message) || 'failed';
    }
  }

  async function add(gistId, body) {
    let record, gif, made;
    try {
      const checked = checkSubmission(body);
      gif = checked.gif;
      record = galleryRecord({ gistId, title: checked.title, author: checked.author, homepage: checked.homepage });
      made = await repo.addGame({
        gifPath: 'src/Gallery/gifs/' + record.thumb,
        gif,
        // refuses a game that the list already has
        edit: (text) => appendRecord(text, record),
        message: 'gallery: add ' + record.title + ' by ' + record.author,
      });
    } catch (e) {
      if (e.name !== 'GalleryError') throw e;
      return { ok: false, error: e.message };
    }
    // The commit stands whatever happens from here: what could not be done is said, and the next
    // upload of the site, or deploy of the bot, puts it right.
    const site = attempt('the live site', () => {
      // the picture first, so that the list never names one that is not there
      writeWhole(path.join(siteDir, 'Gallery', 'gifs', record.thumb), gif);
      addToList(path.join(siteDir, 'games_dat.js'), record);
    });
    const botCopy = attempt("the bot's own list", () => addToList(botGamesDat, record));
    attempt('reloading the list', () => onAdded(record));
    return { ok: true, commitUrl: made.commitUrl, galleryUrl: GALLERY_URL, site, botCopy };
  }

  return {
    // What the submission page starts from.
    async game(gistId) {
      let source;
      try { source = await getSource(gistId); } catch (e) {
        if (e instanceof GistError) throw new GalleryError('the game could not be fetched: ' + e.message);
        throw e;
      }
      return { gistId, source, inGallery: hasGist(await repo.readGamesDat(), gistId) };
    },

    // One at a time: each edits the lists the one before it left.
    submit(gistId, body) {
      const done = queue.then(() => add(gistId, body));
      queue = done.catch(() => {});
      return done;
    },
  };
}

module.exports = { createGallerySubmitter };
