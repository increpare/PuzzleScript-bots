'use strict';
// The workshop: the labs editor running as a Discord Activity. This is loaded after all of the
// editor's own scripts. So far it signs in and tidies away what cannot work inside Discord;
// sharing the document and the save list come next.
(function () {
  function say(text) {
    try { consolePrint(text, true); } catch (e) { /* the editor's console is not up */ }
  }

  // Sharing to GitHub needs a pop-up and requests that Discord's frame does not allow.
  var share = document.getElementById('shareClickLink');
  if (share) share.style.display = 'none';
  // The title links to the PuzzleScript front page, which is not part of the workshop.
  var home = document.querySelector('#uppertoolbar a[href="index.html"]');
  if (home) home.removeAttribute('href');

  var sdk;
  try {
    // Inside Discord the page is served from <application id>.discordsays.com.
    sdk = new window.DiscordEmbeddedAppSDK.DiscordSDK(location.hostname.split('.')[0]);
  } catch (e) {
    say('Workshop: this page is not inside Discord, so nothing here is shared.');
    return;
  }

  async function signIn() {
    var clientId = location.hostname.split('.')[0];
    await sdk.ready();
    var auth = await sdk.commands.authorize({ client_id: clientId, response_type: 'code', state: '', prompt: 'none', scope: ['identify'] });
    var r = await fetch('api/token', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: auth.code }) });
    var body = await r.json().catch(function () { return null; });
    if (r.status !== 200 || !body) throw new Error((body && body.error) || 'the bot did not answer');
    await sdk.commands.authenticate({ access_token: body.access_token });
    return body.session;
  }

  signIn().then(function () {
    say('Workshop: signed in. The document is not shared yet.');
  }).catch(function (e) {
    say('Workshop: signing in failed (' + (e && e.message ? e.message : e) + ').');
  });
})();
