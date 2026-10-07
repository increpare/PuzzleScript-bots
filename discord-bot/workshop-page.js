'use strict';

const OWN_STORAGE = '<script src="js/storagewrapper.js"></script>';

// The workshop's page is the labs editor's own page with two changes. Its storage script is
// swapped for the workshop's, so that the save list is the room's and not each browser's; and the
// workshop's scripts are added at the end, after everything of the editor's has loaded.
// Being made from the editor's page each time the bot starts, it never drifts from it.
function workshopPage(editorHtml) {
  if (editorHtml.split(OWN_STORAGE).length !== 2 || editorHtml.split('</body>').length !== 2) {
    throw new Error('the labs editor page is not laid out as expected');
  }
  return editorHtml
    .replace(OWN_STORAGE, '<script src="workshop/storage.js"></script>')
    .replace('</body>', '<script src="vendor/embedded-app-sdk.js"></script>\n<script src="workshop/main.js"></script>\n</body>');
}

module.exports = { workshopPage };
