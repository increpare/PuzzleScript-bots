'use strict';
// Names and signals belong to the editor viewport, rather than to clipped inline cursor widgets.
window.WorkshopNavigation = {
  create({ view, roster, editorId, peers, api, say, version, pending }) {
    const { EditorView, StateEffect, StateField } = window.PuzzleScriptCM6Runtime;
    const setSignals = StateEffect.define();
    const signalsField = StateField.define({
      create: () => [],
      update(signals, tr) {
        for (const effect of tr.effects) if (effect.is(setSignals)) return effect.value;
        return tr.docChanged ? signals.map((s) => Object.assign({}, s, { pos: tr.changes.mapPos(s.pos, 1) })) : signals;
      },
    });
    const overlay = document.createElement('div');
    overlay.className = 'ws-overlays';
    view.dom.appendChild(overlay);
    const labels = new Map();
    const buttons = new Map();
    let expiryTimer = null;
    let previousClick = null;
    let self = { name: 'You', color: '#777777' };
    const ownRequests = new Map(); // request id -> delivery confirmed, retained beyond marker expiry
    const loggedBroadcasts = new Set();
    let latestRequest = null;

    const escapeMessage = (text) => { const span = document.createElement('span'); span.textContent = text; return span.innerHTML; };
    const diagnostic = (message) => {
      const text = 'Workshop signals [diag-1]: ' + message;
      console.info(text);
      say(escapeMessage(text));
    };
    const jump = (pos) => view.dispatch({ effects: EditorView.scrollIntoView(Math.max(0, Math.min(pos, view.state.doc.length)), { y: 'center' }) });

    function measure() {
      view.requestMeasure({
        key: overlay,
        read() {
          const outer = view.dom.getBoundingClientRect();
          const rect = view.scrollDOM.getBoundingClientRect();
          // Exclude the scrollbars; an edge arrow remains inside the usable editor.
          const bounds = { left: rect.left + 3, top: rect.top + 3, right: rect.left + view.scrollDOM.clientWidth - 3, bottom: rect.top + view.scrollDOM.clientHeight - 3 };
          const entries = peers().filter((p) => p.head !== null).map((p) => ({ key: 'peer:' + p.id + ':' + p.moved, kind: 'peer', name: p.name, color: p.color, pos: p.head, moved: p.moved }));
          for (const s of view.state.field(signalsField)) if (s.until > Date.now()) entries.push(Object.assign({ key: 'signal:' + s.id, kind: 'signal' }, s));
          return { outer, bounds, entries: entries.map((e) => Object.assign({}, e, { coords: view.coordsAtPos(Math.min(e.pos, view.state.doc.length)) })) };
        },
        write({ outer, bounds, entries }) {
          const kept = new Set();
          for (const e of entries) {
            const c = e.coords;
            const visible = c && c.bottom > bounds.top && c.top < bounds.bottom && c.left >= bounds.left && c.left <= bounds.right;
            if (e.kind === 'peer' && !visible) continue;
            const arrow = e.kind === 'signal' && !visible;
            const key = e.key + (arrow ? ':arrow' : ':label');
            kept.add(key);
            let label = labels.get(key);
            if (!label) {
              label = document.createElement(arrow ? 'button' : 'span');
              label.className = e.kind === 'peer' ? 'ws-peer-name' : arrow ? 'ws-signal-arrow' : 'ws-signal';
              if (e.kind === 'peer') label.style.animationDelay = -Math.min(3000, Date.now() - e.moved) + 'ms';
              if (arrow) { label.type = 'button'; label.addEventListener('click', () => jump(label.wsPosition)); }
              labels.set(key, label);
              overlay.appendChild(label);
            }
            label.wsPosition = e.pos;
            label.dataset.pending = String(!!e.pending);
            label.style.backgroundColor = e.color;
            label.style.maxWidth = Math.max(20, bounds.right - bounds.left - 8) + 'px';
            let x;
            let y;
            if (arrow) {
              // coordsAtPos can be null for virtualised lines. Their document order still tells
              // us which vertical edge points towards them.
              const above = c ? c.bottom <= bounds.top : e.pos < view.viewport.from;
              const below = c ? c.top >= bounds.bottom : !above;
              const left = c && c.left < bounds.left;
              const direction = above ? '↑' : below ? '↓' : left ? '←' : '→';
              label.textContent = direction + ' ' + e.name + (e.message || '');
              label.title = 'Jump to ' + e.name + "'s signal";
              x = c ? c.left : (bounds.left + bounds.right) / 2;
              y = above ? bounds.top : below ? bounds.bottom - 22 : c.top;
              if (left) x = bounds.left;
              else if (!above && !below) x = bounds.right - label.offsetWidth;
            } else {
              label.textContent = e.name + (e.message || '');
              x = c.left;
              y = c.top - 18 >= bounds.top ? c.top - 18 : c.bottom;
            }
            x = Math.max(bounds.left, Math.min(x, bounds.right - label.offsetWidth));
            y = Math.max(bounds.top, Math.min(y, bounds.bottom - label.offsetHeight));
            label.style.left = (x - outer.left) + 'px';
            label.style.top = (y - outer.top) + 'px';
          }
          for (const [key, label] of labels) if (!kept.has(key)) { label.remove(); labels.delete(key); }
        },
      });
    }

    function showSignals(incoming) {
      for (const s of incoming) if (ownRequests.has(s.clientId)) {
        if (!loggedBroadcasts.has(s.clientId)) {
          diagnostic('broadcast received for your signal');
          loggedBroadcasts.add(s.clientId);
        }
        ownRequests.set(s.clientId, true);
      }
      const previous = new Map(view.state.field(signalsField).map((s) => [s.id, s]));
      const changes = pending();
      const signals = incoming.filter((s) => !ownRequests.has(s.clientId) || s.clientId === latestRequest).map((s) => {
        let pos = s.pos;
        for (const change of changes) pos = change.mapPos(pos, 1);
        // Keep each signal's original local deadline when later polls report it again.
        const until = previous.get(s.id)?.until || Date.now() + Math.max(0, Math.min(5000, s.remainingMs));
        return Object.assign({}, s, { pos: Math.min(pos, view.state.doc.length), until });
      }).filter((s) => s.until > Date.now());
      // A poll already in flight can omit a newly sent signal. Keep the sender's preview
      // until this exact request is broadcast, rather than erasing it with that older poll.
      for (const s of previous.values()) if (s.local && s.until > Date.now() && !signals.some((remote) => remote.id === s.id || remote.clientId === s.clientId)) signals.push(s);
      view.dispatch({ effects: setSignals.of(signals) });
      showSignalsDeadline();
    }
    function showSignalsDeadline() {
      clearTimeout(expiryTimer);
      const signals = view.state.field(signalsField);
      if (signals.length) expiryTimer = setTimeout(() => {
        view.dispatch({ effects: setSignals.of(view.state.field(signalsField).filter((s) => s.until > Date.now())) });
        showSignalsDeadline();
      }, Math.max(1, Math.min(...signals.map((s) => s.until)) - Date.now() + 1));
    }

    function showRoster(everyone) {
      const active = new Set();
      for (const p of everyone) {
        if (p.id === editorId) self = p;
        active.add(p.id);
        let button = buttons.get(p.id);
        if (!button) {
          button = document.createElement('button');
          button.type = 'button';
          button.appendChild(document.createElement('i'));
          button.appendChild(document.createElement('span'));
          button.addEventListener('click', () => {
            const current = p.id === editorId ? view.state.selection.main : peers().find((peer) => peer.id === p.id);
            if (current && current.head !== null) jump(current.head);
          });
          buttons.set(p.id, button);
          roster.appendChild(button);
        }
        button.disabled = p.head === null;
        button.title = p.head === null ? p.name + ' has no code cursor' : 'Jump to ' + p.name + "'s cursor";
        button.firstChild.style.backgroundColor = p.color;
        button.lastChild.textContent = p.name + (p.id === editorId ? ' (you)' : '');
      }
      for (const [id, button] of buttons) if (!active.has(id)) { button.remove(); buttons.delete(id); }
    }

    function replaceLocal(clientId, update) {
      view.dispatch({ effects: setSignals.of(view.state.field(signalsField).map((s) => s.clientId === clientId ? Object.assign({}, s, update) : s)) });
      showSignalsDeadline();
    }

    function signal(pos) {
      diagnostic('gesture accepted; placing local marker at position=' + pos);
      const clientId = crypto.randomUUID();
      ownRequests.set(clientId, false);
      latestRequest = clientId;
      if (ownRequests.size > 64) {
        const oldest = ownRequests.keys().next().value;
        ownRequests.delete(oldest);
        loggedBroadcasts.delete(oldest);
      }
      const syncDeadline = Date.now() + 5000;
      // A pending request is feedback, not yet a five-second broadcast. Allow time for sync
      // and a bounded POST; acceptance starts the actual signal's lifetime.
      const preview = { id: clientId, clientId, name: self.name, color: self.color, pos, until: syncDeadline + 11000, pending: true, local: true, message: ' · sending…' };
      view.dispatch({ effects: setSignals.of([...view.state.field(signalsField).filter((s) => !ownRequests.has(s.clientId)), preview]) });
      showSignalsDeadline();
      function fail(reason) {
        const current = view.state.field(signalsField).find((s) => s.clientId === clientId);
        // A delivered broadcast can win the race against a lost POST response.
        if (clientId !== latestRequest || ownRequests.get(clientId) || (current && !current.local)) return;
        diagnostic('delivery failed: ' + reason);
        replaceLocal(clientId, { pending: false, message: ' · not sent', until: Date.now() + 5000 });
        say(escapeMessage('Workshop: the signal was not sent (' + reason + ').'));
      }
      let waitingLogged = false;
      function send() {
        const current = view.state.field(signalsField).find((s) => s.clientId === clientId);
        if (!current) return;
        if (pending().length) {
          if (!waitingLogged) { diagnostic('waiting for local edits to sync'); waitingLogged = true; }
          if (Date.now() >= syncDeadline) return fail('your edits are still syncing; try again');
          setTimeout(send, 50);
          return;
        }
        const controller = new AbortController();
        diagnostic('POST signal position=' + current.pos + ' version=' + version());
        const timeout = setTimeout(() => controller.abort(), 10000);
        api('POST', 'workshop/signal', { pos: current.pos, version: version(), clientId }, controller.signal).then((r) => {
          diagnostic('POST response HTTP ' + r.status);
          if (r.status !== 200 || !r.body?.ok) return fail(r.body?.error || 'the bot did not answer');
          if (ownRequests.has(clientId)) ownRequests.set(clientId, true);
          // Keep the locally mapped position: edits may have arrived while the POST was in flight.
          const current = view.state.field(signalsField).find((s) => s.clientId === clientId);
          const until = current?.local ? Date.now() + Math.max(0, Math.min(5000, r.body.signal?.remainingMs ?? 5000)) : current?.until;
          replaceLocal(clientId, { id: r.body.signal?.id || clientId, pending: false, message: '', until });
        }).catch(() => fail(controller.signal.aborted ? 'the request timed out' : 'the bot could not be reached')).finally(() => clearTimeout(timeout));
      }
      send();
    }

    // Diagnose the whole Activity frame, including events outside the listener's editor region.
    // No document text, user identity or credentials are logged.
    for (const type of ['pointerdown', 'mousedown', 'contextmenu']) window.addEventListener(type, (event) => {
      if (event.button !== 2 && !(event.button === 0 && event.ctrlKey) && type !== 'contextmenu') return;
      const region = view.scrollDOM.contains(event.target) ? 'code' : view.dom.contains(event.target) ? 'editor-controls' : 'outside-code';
      diagnostic(type + ' button=' + event.button + ' ctrl=' + !!event.ctrlKey + ' shift=' + !!event.shiftKey + ' region=' + region + ' x=' + Math.round(event.clientX) + ' y=' + Math.round(event.clientY));
    }, true);

    // Native/Discord context menus can swallow the second contextmenu event. Detect
    // presses instead and reserve unmodified right-clicks; Shift-right-click opens the menu.
    view.scrollDOM.addEventListener('contextmenu', (event) => {
      if (!event.shiftKey) event.preventDefault();
    }, true);
    view.scrollDOM.addEventListener('pointerdown', (event) => {
      if (event.button !== 2) return;
      if (event.shiftKey) { previousClick = null; diagnostic('gesture ignored: Shift opens the context menu'); return; }
      const now = performance.now();
      const elapsed = previousClick ? now - previousClick.at : null;
      const distance = previousClick ? Math.hypot(event.clientX - previousClick.x, event.clientY - previousClick.y) : null;
      const second = previousClick && elapsed <= 400 && distance <= 6;
      if (previousClick && !second) diagnostic('gesture rejected: gap=' + Math.round(elapsed) + 'ms limit=400ms movement=' + distance.toFixed(1) + 'px limit=6px');
      previousClick = { at: now, x: event.clientX, y: event.clientY };
      if (!second) { diagnostic('first right-click received; waiting for second'); return; }
      previousClick = null;
      event.preventDefault();
      try { signal(view.posAtCoords({ x: event.clientX, y: event.clientY }, false)); }
      catch (error) { diagnostic('signal handler threw ' + error.name + ': ' + error.message); }
    }, true);
    view.dispatch({ effects: StateEffect.appendConfig.of([
      signalsField,
      EditorView.updateListener.of(measure),
    ]) });
    view.scrollDOM.addEventListener('scroll', measure);
    addEventListener('resize', measure);
    measure();
    diagnostic('ready; right-click twice in the code editor (400ms, 6px); PointerEvent=' + (typeof PointerEvent) + ' randomUUID=' + (typeof crypto.randomUUID));
    return { showRoster, showSignals };
  },
};
