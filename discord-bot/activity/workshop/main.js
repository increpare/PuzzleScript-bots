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
  const { EditorView, StateEffect, StateField, Transaction, Decoration } = window.PuzzleScriptCM6Runtime;
  const { collab, getSyncedVersion, receiveUpdates, sendableUpdates, ChangeSet, Compartment, WidgetType } = window.PuzzleScriptWorkshopCollab;
  let session = null; // the bot's signed word for who is signed in; sent with every request
  // This editor's own name in the room: one for each open page, so a person with two windows is two editors.
  const editorId = Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => b.toString(16).padStart(2, '0')).join('');
  let discord = null; // Discord's SDK, once the page has found itself inside Discord

  function say(text) {
    try { consolePrint(text, true); } catch (e) { /* the editor's console is not up */ }
  }
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  // Paths are relative: inside Discord the page is served through the Activity's proxy, and
  // outside it from wherever the bot's server is mounted.
  async function api(method, name, body, signal) {
    const headers = { authorization: 'Bearer ' + session };
    if (body) headers['content-type'] = 'application/json';
    const r = await fetch('api/' + name, { method, headers, body: body ? JSON.stringify(body) : undefined, signal });
    return { status: r.status, body: await r.json().catch(() => null) };
  }

  WorkshopControls.install({ say, api, inDiscord: () => discord !== null });

  // Inside Discord's frame a link that leaves the page goes nowhere by itself: Discord has to be
  // asked to open it. This covers the links the workshop prints and the editor's own, and sends the
  // editor's links to its documentation, which is not part of the workshop, to the real pages.
  document.addEventListener('click', (e) => {
    const a = discord && e.target.closest ? e.target.closest('a[href]') : null;
    if (!a) return;
    const href = a.getAttribute('href');
    if (/^(javascript:|#)/i.test(href)) return;
    let url = new URL(href, location.href);
    if (!/^https?:$/.test(url.protocol)) return;
    if (url.origin === location.origin && !a.classList.contains('ws-download')) url = new URL(url.pathname + url.search + url.hash, 'https://www.puzzlescript.net');
    e.preventDefault();
    discord.commands.openExternalLink({ url: url.href });
  }, true);
  const link = (url) => '<a target="_blank" href="' + url + '">' + url + '</a>';

  // The editor's own Share signs in to GitHub with a pop-up, which Discord's frame does not allow.
  // It is hidden until the bot says it can share for the room (offerShare).
  const shareLink = document.getElementById('shareClickLink');
  if (shareLink) shareLink.style.display = 'none';

  // Share, done by the bot: the room's game becomes a gist under the bot's own GitHub account, and
  // the bot posts the link in the channel.
  function offerShare() {
    if (!shareLink) return;
    // a copy of the link without the editor's own handler
    const link = shareLink.cloneNode(true);
    link.style.display = '';
    shareLink.replaceWith(link);
    let busy = false;
    link.addEventListener('click', async (e) => {
      e.preventDefault();
      if (busy) return;
      busy = true;
      say('Workshop: sharing the game…');
      try {
        const r = await api('POST', 'workshop/share', {});
        if (r.status === 200 && r.body && r.body.ok) {
          say('Workshop: shared.' + (r.body.where ? ' A game of it has been started in ' + r.body.where + '.' : '')
            + '<br>It can be played at ' + link(r.body.playUrl) + '<br>Source: ' + link(r.body.editUrl));
        }
        else say('Workshop: not shared (' + ((r.body && r.body.error) || 'the bot did not answer') + ').');
      } catch (err) {
        say('Workshop: not shared (the bot could not be reached).');
      }
      busy = false;
    });
  }
  // The title links to the PuzzleScript front page, which is not part of the workshop.
  const home = document.querySelector('#uppertoolbar a[href="index.html"]');
  if (home) home.removeAttribute('href');

  // ---- the others in the room: their cursors in the code, and a list of who is here ----
  const style = document.createElement('style');
  style.textContent = [
    '.ws-peer-caret { position: relative; display: inline-block; width: 0; height: 1.2em; margin: 0 -1px; border-left: 2px solid; vertical-align: text-bottom; pointer-events: none; }',
    '.ws-overlays { position: absolute; inset: 0; z-index: 10; pointer-events: none; overflow: hidden; }',
    '.ws-peer-name, .ws-signal, .ws-signal-arrow { position: absolute; padding: 1px 4px; border: 0; border-radius: 3px; font: 11px/15px sans-serif; color: #fff; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }',
    '.ws-peer-name { animation: ws-peer-name 3s forwards; }',
    '@keyframes ws-peer-name { 0%, 70% { opacity: 0.92; } 100% { opacity: 0; } }',
    '.ws-signal { box-shadow: 0 0 0 4px #ffffff60; animation: ws-pulse 0.7s ease-in-out infinite alternate; }',
    '.ws-signal-arrow { pointer-events: auto; cursor: pointer; box-shadow: 0 0 0 2px #ffffff80; }',
    '@keyframes ws-pulse { from { box-shadow: 0 0 0 3px #ffffff80; } to { box-shadow: 0 0 0 9px #ffffff10; } }',
    '@media (prefers-reduced-motion: reduce) { .ws-signal { animation: none; } }',
    '#workshopRoster { position: absolute; right: 14px; bottom: 8px; z-index: 20; display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 2px 10px; max-width: 70%; padding: 4px 8px; border-radius: 6px; background: rgba(0, 0, 0, 0.6); color: #fff; font: 12px/16px sans-serif; }',
    '#workshopRoster:empty { display: none; }',
    '#workshopRoster i { display: inline-block; width: 8px; height: 8px; margin-right: 4px; border-radius: 50%; }',
    '#workshopRoster button { border: 0; padding: 0; background: transparent; color: inherit; font: inherit; cursor: pointer; }',
    '#workshopRoster button:hover { text-decoration: underline; }',
    '#workshopRoster button:disabled { opacity: 0.65; cursor: default; text-decoration: none; }',
    '#workshopRoster button:focus-visible, .ws-signal-arrow:focus-visible { outline: 2px solid #fff; outline-offset: 2px; }',
  ].join('\n');
  document.head.appendChild(style);
  const roster = document.createElement('div');
  roster.id = 'workshopRoster';
  (document.getElementById('leftpanel') || document.body).appendChild(roster);

  // Another person's cursor is a thin bar in their colour. navigation.js positions its name
  // inside the viewport; moved records when that name should appear and fade.
  class PeerCaret extends WidgetType {
    constructor(name, color, moved) { super(); this.name = name; this.color = color; this.moved = moved; }
    eq(other) { return other.name === this.name && other.color === this.color && other.moved === this.moved; }
    toDOM() {
      const caret = document.createElement('span');
      caret.className = 'ws-peer-caret';
      caret.style.borderLeftColor = this.color;
      return caret;
    }
    ignoreEvent() { return true; }
  }
  function peerDecorations(peers, length) {
    const ranges = [];
    for (const p of peers) {
      if (p.head === null) continue;
      const head = Math.min(p.head, length);
      const anchor = Math.min(p.anchor, length);
      // what they have selected, as a wash of their colour
      if (anchor !== head) ranges.push(Decoration.mark({ attributes: { style: 'background-color: ' + p.color + '40' } }).range(Math.min(anchor, head), Math.max(anchor, head)));
      ranges.push(Decoration.widget({ widget: new PeerCaret(p.name, p.color, p.moved), side: 1 }).range(head));
    }
    return Decoration.set(ranges, true);
  }
  const setPeers = StateEffect.define();
  const peersField = StateField.define({
    create: () => ({ peers: [], decorations: Decoration.none }),
    update(value, tr) {
      let peers = value.peers;
      for (const e of tr.effects) if (e.is(setPeers)) peers = e.value;
      // Text typed or removed carries the others' cursors with it, until they next say where they are.
      if (peers === value.peers && tr.docChanged) {
        peers = peers.map((p) => (p.head === null ? p : Object.assign({}, p, { anchor: tr.changes.mapPos(p.anchor, 1), head: tr.changes.mapPos(p.head, 1) })));
      }
      return peers === value.peers ? value : { peers, decorations: peerDecorations(peers, tr.newDoc.length) };
    },
    provide: (field) => EditorView.decorations.from(field, (value) => value.decorations),
  });

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
    discord = sdk;
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
      collab({ startVersion: version, clientID: editorId }),
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
        if (Array.isArray(r.body.presence)) showPeers(r.body.presence);
        if (Array.isArray(r.body.signals)) navigation.showSignals(r.body.signals);
      }
    }

    // Where this editor's cursor is, for the others. It is said when it changes, at most a few times
    // a second, and every few seconds regardless, which is how the bot knows this editor is still open.
    let saidAt = null;
    let sayTimer = null;
    function sayWhere(evenIfUnchanged) {
      const main = view.state.selection.main;
      const at = main.anchor + ':' + main.head;
      if (!evenIfUnchanged && at === saidAt) return;
      saidAt = at;
      api('POST', 'workshop/presence', { id: editorId, anchor: main.anchor, head: main.head }).catch(() => {});
    }
    let shownPeers = '';
    const lastSaid = new Map(); // editor id -> where it last said its cursor was, and when that changed
    function showPeers(everyone) {
      navigation.showRoster(everyone);
      const pending = sendableUpdates(view.state);
      const others = everyone.filter((p) => p.id !== editorId).map((p) => {
        const at = p.anchor + ':' + p.head;
        let last = lastSaid.get(p.id);
        if (!last || last.at !== at) { last = { at, moved: Date.now() }; lastSaid.set(p.id, last); }
        let anchor = p.anchor;
        let head = p.head;
        if (head !== null) {
          // Incoming positions precede this editor's unsent changes. Bring them into the same
          // document as the local cursor before replacing the already-mapped decorations.
          const length = pending.length ? pending[0].changes.length : view.state.doc.length;
          anchor = Math.min(anchor, length);
          head = Math.min(head, length);
          for (const update of pending) {
            anchor = update.changes.mapPos(anchor, 1);
            head = update.changes.mapPos(head, 1);
          }
        }
        return Object.assign({ moved: last.moved }, p, { anchor, head });
      });
      for (const id of lastSaid.keys()) if (!others.some((p) => p.id === id)) lastSaid.delete(id);
      const key = JSON.stringify(others);
      if (key === shownPeers) return;
      shownPeers = key;
      view.dispatch({ effects: setPeers.of(others) });
    }
    view.dispatch({ effects: StateEffect.appendConfig.of([
      peersField,
      EditorView.updateListener.of((update) => {
        if ((update.selectionSet || update.docChanged) && sayTimer === null) sayTimer = setTimeout(() => { sayTimer = null; sayWhere(false); }, 150);
      }),
    ]) });
    const navigation = WorkshopNavigation.create({
      view, roster, editorId, api, say,
      peers: () => view.state.field(peersField).peers,
      version: () => getSyncedVersion(view.state),
      pending: () => sendableUpdates(view.state).map((u) => u.changes),
    });
    setInterval(() => { if (!stopped) sayWhere(true); }, 5000);
    // On the way out, say so, so that the others do not see a cursor with nobody behind it.
    // (If this does not get through, the bot notices the silence a few seconds later.)
    addEventListener('pagehide', () => {
      fetch('api/workshop/leave', { method: 'POST', keepalive: true, headers: { authorization: 'Bearer ' + session, 'content-type': 'application/json' }, body: JSON.stringify({ id: editorId }) }).catch(() => {});
    });

    // What the editor opened with (its example game) becomes the room's first document, if the
    // room has never had one.
    const opening = view.state.doc.toString();
    view.dispatch(replaceAll(first.doc));
    view.dispatch({ effects: StateEffect.appendConfig.of(sharing.of(sharedAt(first.version))) });
    if (first.version === 0 && first.doc === '' && opening) view.dispatch({ changes: { from: 0, insert: opening } });
    sayWhere(true);
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
    if (first.body.canShare) offerShare();
    say('Workshop: you are editing the shared document. Everyone here sees your changes as you type, and SAVE saves for the whole room.');
  }

  start().catch((e) => say('Workshop: could not start sharing (' + (e && e.message ? e.message : e) + ').'));
})();
