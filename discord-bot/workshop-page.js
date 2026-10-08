'use strict';
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const OWN_STORAGE = '<script src="js/storagewrapper.js"></script>';
const OWN_RUNTIME = '<script src="js/codemirror6/runtime/dist/codemirror6-runtime.js"></script>';
const CLIENT_FILES = ['workshop/storage.js', 'workshop/codemirror6-runtime.js', 'vendor/embedded-app-sdk.js', 'workshop/controls.js', 'workshop/navigation.js', 'workshop/loading.js', 'workshop/main.js'];

function readClientSources() {
  return Object.fromEntries(CLIENT_FILES.map((file) => [file, fs.readFileSync(path.join(__dirname, 'activity', file))]));
}

// The workshop's page is the labs editor's own page with three changes:
// - its storage script is swapped for the workshop's, so that the save list is the room's and not
//   each browser's;
// - its CodeMirror runtime is swapped for the workshop's build of the same runtime, which has the
//   collaboration package in it (see scripts/build-workshop-runtime.sh);
// - the workshop's scripts are added at the end, after everything of the editor's has loaded.
// Being made from the editor's page each time the bot starts, it never drifts from it.
function workshopPage(editorHtml, { assetSources } = {}) {
  const once = (part) => editorHtml.split(part).length === 2;
  if (!once(OWN_STORAGE) || !once(OWN_RUNTIME) || !once('</body>')) {
    throw new Error('the labs editor page is not laid out as expected');
  }
  const hash = crypto.createHash('sha256').update(editorHtml);
  for (const [file, source] of Object.entries(assetSources || readClientSources()).sort(([a], [b]) => a.localeCompare(b))) hash.update('\0' + file + '\0').update(source);
  const build = hash.digest('hex').slice(0, 16);
  const script = (file) => '<script' + (file === 'workshop/main.js' ? ' data-workshop-build="' + build + '"' : '') + ' src="' + file + '?v=' + build + '"></script>';
  return editorHtml
    .replace(OWN_STORAGE, script('workshop/storage.js'))
    .replace(OWN_RUNTIME, script('workshop/codemirror6-runtime.js'))
    .replace('</body>', CLIENT_FILES.slice(2).map(script).join('\n') + '\n</body>');
}

module.exports = { workshopPage };
