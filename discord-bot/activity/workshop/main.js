'use strict';
// The workshop: the labs editor running as a Discord Activity, with its document shared between
// everyone who has it open. This is loaded after all of the editor's own scripts.
//
// Sharing is @codemirror/collab with the bot as the authority (see workshop-doc.js in the bot).
// Every change made here is sent to the bot with the version it was made against. The bot applies
// it if that is the version it is at, and otherwise turns it away; a request that is always open
// brings everyone else's changes, the editor rebases its own unsent ones over them, and they are
// sent again. Loading a game or an example replaces the text, which is a change like any other.
(function () {
  const { EditorView, StateEffect, Transaction } = window.PuzzleScriptCM6Runtime;
  const { collab, getSyncedVersion, receiveUpdates, sendableUpdates, ChangeSet, Compartment } = window.PuzzleScriptWorkshopCollab;
  let session = null; // the bot's signed word for who is signed in; sent with every request

  function say(text) {
    try { consolePrint(text, true); } catch (e) { /* the editor's console is not up */ }
  }
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  // Paths are relative: inside Discord the page is served through the Activity's proxy, and
  // outside it from wherever the bot's server is mounted.
  async function api(method, name, body) {
    const headers = { authorization: 'Bearer ' + session };
    if (body) headers['content-type'] = 'application/json';
    const r = await fetch('api/' + name, { method, headers, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json().catch(() => null) };
  }

  // Sharing to GitHub needs a pop-up and requests that Discord's frame does not allow.
  const shareLink = document.getElementById('shareClickLink');
  if (shareLink) shareLink.style.display = 'none';
  // The title links to the PuzzleScript front page, which is not part of the workshop.
  const home = document.querySelector('#uppertoolbar a[href="index.html"]');
  if (home) home.removeAttribute('href');

  // ---- the room's save list: what the editor's SAVE button and Load dropdown show ----
  let savesRev = -1;
  function showSaves(lists) {
    savesRev = lists.rev;
    workshopStorage.setRoomSaves(lists);
    try { repopulateSaveDropdown(); } catch (e) { /* the editor's toolbar is not up */ }
  }
  async function fetchSaves() {
    const r = await api('GET', 'workshop/saves').catch(() => null);
    if (r && r.status === 200 && r.body) showSaves(r.body);
  }
  function shareSaves(first) {
    workshopStorage.shareSaves(first, (group, json) => {
      // The editor has just written its whole list with one new save at the end. Only that save is
      // sent: the bot adds it to the room's list, which may hold saves this editor has not seen yet.
      let list;
      try { list = JSON.parse(json); } catch (e) { return; }
      const made = list[list.length - 1];
      if (!made) return;
      api('POST', 'workshop/saves', { group, entry: { title: String(made.title), text: String(made.text) } }).then((r) => {
        if (r.status === 200 && r.body) showSaves(r.body);
        else say('Workshop: that save was not kept (' + ((r.body && r.body.error) || 'the bot did not answer') + ').');
      }).catch(() => say('Workshop: that save was not kept (the bot could not be reached).'));
    });
    showSaves(first);
  }

  async function signIn() {
    let sdk;
    try {
      // Inside Discord the page is served from <application id>.discordsays.com.
      sdk = new window.DiscordEmbeddedAppSDK.DiscordSDK(location.hostname.split('.')[0]);
    } catch (e) {
      // Not inside Discord. A bot run for working on this page hands out a session all the same.
      const dev = await fetch('api/dev-session').then((r) => (r.ok ? r.json() : null)).catch(() => null);
      return dev ? dev.session : null;
    }
    const clientId = location.hostname.split('.')[0];
    await sdk.ready();
    // The Activity is switched off for phones in the developer portal, so Discord should never open
    // it on one. If it does, say so and share nothing: the editor needs a keyboard and a big screen.
    if (sdk.platform === 'mobile') {
      const notice = document.createElement('div');
      notice.textContent = 'The PuzzleScript workshop is a desktop editor. Open it from Discord on a computer.';
      notice.style.cssText = 'position:fixed;inset:0;z-index:99999;display:flex;align-items:center;justify-content:center;padding:2em;text-align:center;background:#16161a;color:#eee;font:18px/1.5 sans-serif;';
      document.body.appendChild(notice);
      return null;
    }
    const auth = await sdk.commands.authorize({ client_id: clientId, response_type: 'code', state: '', prompt: 'none', scope: ['identify'] });
    const r = await fetch('api/token', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: auth.code }) });
    const body = await r.json().catch(() => null);
    if (r.status !== 200 || !body) throw new Error((body && body.error) || 'the bot did not answer');
    await sdk.commands.authenticate({ access_token: body.access_token });
    return body.session;
  }

  function share(view, first) {
    const sharing = new Compartment();
    // Raised each time the document is taken afresh from the bot. An answer to a request made
    // before that belongs to a version that no longer means anything here, and is dropped.
    let epoch = 0;
    let pushing = false;
    let stopped = false;

    const sharedAt = (version) => [
      collab({ startVersion: version }),
      EditorView.updateListener.of((update) => { if (update.docChanged) push(); }),
    ];
    const replaceAll = (text) => ({ changes: { from: 0, to: view.state.doc.length, insert: text }, annotations: Transaction.addToHistory.of(false) });

    // The editor forgets its undo history by building itself a fresh state, which would also forget
    // that the document is shared. In the workshop the history is kept instead.
    // (Were it ever asked for a different document, that is made as a change, which is shared.)
    view.setState = (state) => {
      if (!state.doc.eq(view.state.doc)) view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: state.doc } });
    };

    function stop(why) {
      stopped = true;
      say('Workshop: ' + why);
    }

    // Take the document as the bot has it, dropping the old version and anything unsent.
    function adopt(state) {
      epoch++;
      view.dispatch({ effects: sharing.reconfigure([]) });
      view.dispatch(replaceAll(state.doc));
      view.dispatch({ effects: sharing.reconfigure(sharedAt(state.version)) });
    }

    async function resync() {
      for (let tries = 1; !stopped; tries++) {
        const r = await api('GET', 'workshop').catch(() => null);
        if (r && r.status === 200 && r.body) {
          adopt(r.body);
          say('Workshop: the document was reloaded from the bot.');
          return;
        }
        if (r && r.status === 401) return stop('your sign-in has run out. Close the workshop and open it again.');
        await wait(Math.min(10000, 1000 * tries));
      }
    }

    async function push() {
      if (pushing || stopped) return;
      const updates = sendableUpdates(view.state);
      if (!updates.length) return;
      pushing = true;
      const at = epoch;
      let r = null;
      try {
        r = await api('POST', 'workshop/push', {
          version: getSyncedVersion(view.state),
          updates: updates.map((u) => ({ clientID: u.clientID, changes: u.changes.toJSON() })),
        });
      } catch (e) { /* the bot could not be reached: tried again below */ }
      pushing = false;
      if (stopped || at !== epoch) return;
      if (r && r.status === 401) return stop('your sign-in has run out. Close the workshop and open it again.');
      // The bot will not take these changes at all (they do not fit its document, or are too big).
      // The only way back to agreement is the bot's document.
      if (r && (r.status === 400 || r.status === 413)) return resync();
      // Sent changes stay "unsent" until they come back through pull, and changes turned away are
      // rebased by what pull brings. Either way, whatever is left is tried again shortly.
      if (sendableUpdates(view.state).length) setTimeout(push, 250);
    }

    async function pullForever() {
      let failures = 0;
      while (!stopped) {
        const at = epoch;
        const r = await api('GET', 'workshop/pull?version=' + getSyncedVersion(view.state)).catch(() => null);
        if (stopped) return;
        if (at !== epoch) continue;
        if (!r || r.status !== 200 || !r.body) {
          if (r && r.status === 401) return stop('your sign-in has run out. Close the workshop and open it again.');
          failures++;
          await wait(Math.min(10000, 500 * failures));
          continue;
        }
        failures = 0;
        // The bot no longer has the changes between this editor's version and its own (it was
        // restarted, or this editor fell a long way behind).
        if (r.body.reset) { await resync(); continue; }
        // someone has saved: fetch the list afresh
        if (typeof r.body.savesRev === 'number' && r.body.savesRev !== savesRev) fetchSaves();
        if (r.body.updates.length) {
          view.dispatch(receiveUpdates(view.state, r.body.updates.map((u) => ({ clientID: u.clientID, changes: ChangeSet.fromJSON(u.changes) }))));
        }
      }
    }

    // What the editor opened with (its example game) becomes the room's first document, if the
    // room has never had one.
    const opening = view.state.doc.toString();
    view.dispatch(replaceAll(first.doc));
    view.dispatch({ effects: StateEffect.appendConfig.of(sharing.of(sharedAt(first.version))) });
    if (first.version === 0 && first.doc === '' && opening) view.dispatch({ changes: { from: 0, insert: opening } });
    pullForever();
  }

  async function start() {
    session = await signIn();
    if (session === null) return say('Workshop: nothing here is shared (this page is not inside Discord on a computer).');
    const first = await api('GET', 'workshop');
    if (first.status !== 200 || !first.body) throw new Error('the shared document could not be fetched');
    const view = EditorView.findFromDOM(document.querySelector('.cm-editor'));
    if (!view) throw new Error('the editor is not there');
    const saves = await api('GET', 'workshop/saves');
    if (saves.status !== 200 || !saves.body) throw new Error('the save list could not be fetched');
    shareSaves(saves.body);
    share(view, first.body);
    say('Workshop: you are editing the shared document. Everyone here sees your changes as you type, and SAVE saves for the whole room.');
  }

  start().catch((e) => say('Workshop: could not start sharing (' + (e && e.message ? e.message : e) + ').'));
})();
