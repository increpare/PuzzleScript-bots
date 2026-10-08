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

    const escapeMessage = (text) => { const span = document.createElement('span'); span.textContent = text; return span.innerHTML; };
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
              label.textContent = direction + ' ' + e.name;
              label.title = 'Jump to ' + e.name + "'s signal";
              x = c ? c.left : (bounds.left + bounds.right) / 2;
              y = above ? bounds.top : below ? bounds.bottom - 22 : c.top;
              if (left) x = bounds.left;
              else if (!above && !below) x = bounds.right - label.offsetWidth;
            } else {
              label.textContent = e.name;
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
      const previous = new Map(view.state.field(signalsField).map((s) => [s.id, s]));
      const changes = pending();
      const signals = incoming.map((s) => {
        let pos = s.pos;
        for (const change of changes) pos = change.mapPos(pos, 1);
        // Keep each signal's original local deadline when later polls report it again.
        const until = previous.get(s.id)?.until || Date.now() + Math.max(0, Math.min(5000, s.remainingMs));
        return Object.assign({}, s, { pos: Math.min(pos, view.state.doc.length), until });
      }).filter((s) => s.until > Date.now());
      view.dispatch({ effects: setSignals.of(signals) });
      clearTimeout(expiryTimer);
      if (signals.length) expiryTimer = setTimeout(() => {
        view.dispatch({ effects: setSignals.of(view.state.field(signalsField).filter((s) => s.until > Date.now())) });
        showSignalsDeadline();
      }, Math.max(1, Math.min(...signals.map((s) => s.until)) - Date.now() + 1));
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

    // Browsers do not consistently issue dblclick for the right button. Track contextmenu events
    // ourselves, while keeping an ordinary first right-click available for its context menu.
    view.contentDOM.addEventListener('contextmenu', (event) => {
      const now = performance.now();
      const second = previousClick && now - previousClick.at <= 400 && Math.hypot(event.clientX - previousClick.x, event.clientY - previousClick.y) <= 6;
      previousClick = { at: now, x: event.clientX, y: event.clientY };
      if (!second) return;
      previousClick = null;
      event.preventDefault();
      const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
      if (pos === null) return;
      if (pending().length) return say('Workshop: wait for your edits to sync, then signal again.');
      api('POST', 'workshop/signal', { pos, version: version() }).then((r) => {
        if (r.status !== 200 || !r.body || !r.body.ok) say(escapeMessage('Workshop: the signal was not sent (' + ((r.body && r.body.error) || 'the bot did not answer') + ').'));
      }).catch(() => say('Workshop: the signal was not sent (the bot could not be reached).'));
    });
    view.dispatch({ effects: StateEffect.appendConfig.of([
      signalsField,
      EditorView.updateListener.of(measure),
    ]) });
    view.scrollDOM.addEventListener('scroll', measure);
    addEventListener('resize', measure);
    measure();
    return { showRoster, showSignals };
  },
};
