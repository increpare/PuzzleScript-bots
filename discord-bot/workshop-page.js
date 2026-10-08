'use strict';

const OWN_STORAGE = '<script src="js/storagewrapper.js"></script>';
const OWN_RUNTIME = '<script src="js/codemirror6/runtime/dist/codemirror6-runtime.js"></script>';

// The workshop's page is the labs editor's own page with three changes:
// - its storage script is swapped for the workshop's, so that the save list is the room's and not
//   each browser's;
// - its CodeMirror runtime is swapped for the workshop's build of the same runtime, which has the
//   collaboration package in it (see scripts/build-workshop-runtime.sh);
// - the workshop's scripts are added at the end, after everything of the editor's has loaded.
// Being made from the editor's page each time the bot starts, it never drifts from it.
function workshopPage(editorHtml) {
  const once = (part) => editorHtml.split(part).length === 2;
  if (!once(OWN_STORAGE) || !once(OWN_RUNTIME) || !once('</body>')) {
    throw new Error('the labs editor page is not laid out as expected');
  }
  return editorHtml
    .replace(OWN_STORAGE, '<script src="workshop/storage.js"></script>')
    .replace(OWN_RUNTIME, '<script src="workshop/codemirror6-runtime.js"></script>')
    .replace('</body>', '<script src="vendor/embedded-app-sdk.js"></script>\n<script src="workshop/controls.js"></script>\n<script src="workshop/navigation.js"></script>\n<script src="workshop/loading.js"></script>\n<script src="workshop/main.js"></script>\n</body>');
}

module.exports = { workshopPage };
