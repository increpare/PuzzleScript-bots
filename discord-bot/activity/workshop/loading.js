'use strict';
// Native confirm() is blocked inside Discord's frame. Loading replaces the room's document, so
// use an in-page choice and wait for a durable room save before making that shared edit.
(function () {
  function install({ api, say, onSaved }) {
    const examples = document.getElementById('exampleDropdown');
    const saves = document.getElementById('loadDropDown');
    let busy = false;
    const escape = (value) => String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

    const style = document.createElement('style');
    style.textContent = '#ws-load-dialog{box-sizing:border-box;max-width:min(440px,calc(100vw - 24px));padding:22px;border:1px solid #888;border-radius:6px;background:#202020;color:#eee;font:15px/1.5 sans-serif}#ws-load-dialog::backdrop{background:#0009}#ws-load-dialog h2{font-size:19px;margin:0 0 12px}#ws-load-dialog p{margin:0 0 18px}#ws-load-dialog .ws-load-actions{display:flex;flex-wrap:wrap;gap:10px;justify-content:flex-end}#ws-load-dialog button{font:inherit;padding:7px 12px;border:1px solid #999;border-radius:4px;background:#333;color:#fff;cursor:pointer}#ws-load-dialog button:focus-visible{outline:3px solid #9bd;outline-offset:2px}';
    document.head.appendChild(style);
    const dialog = document.createElement('dialog');
    dialog.id = 'ws-load-dialog';
    dialog.setAttribute('aria-labelledby', 'ws-load-title');
    dialog.setAttribute('aria-describedby', 'ws-load-description');
    dialog.innerHTML = '<h2 id="ws-load-title"></h2><p id="ws-load-description">Loading replaces the shared game for everyone. Save the current game to the room’s Load list before continuing.</p><div class="ws-load-actions"><button type="button" value="cancel" autofocus>Cancel</button><button type="button" value="load">Save current game &amp; load</button></div>';
    document.body.appendChild(dialog);
    // Even method="dialog" form submissions can be blocked by the iframe's allow-forms policy.
    for (const button of dialog.querySelectorAll('button')) {
      button.addEventListener('click', () => dialog.close(button.value));
    }
    dialog.addEventListener('keydown', (event) => {
      event.stopPropagation();
      if (event.key === 'Escape') {
        event.preventDefault();
        dialog.close('cancel');
      }
    });

    function confirmLoad(label) {
      dialog.querySelector('h2').textContent = 'Load ' + label + '?';
      dialog.returnValue = 'cancel';
      return new Promise((resolve) => {
        dialog.addEventListener('close', () => resolve(dialog.returnValue === 'load'), { once: true });
        dialog.showModal();
        dialog.querySelector('[value="cancel"]').focus();
      });
    }

    async function load(target) {
      if (busy) return;
      busy = true;
      const disabled = [examples.disabled, saves.disabled];
      examples.disabled = saves.disabled = true;
      try {
        if (!await confirmLoad(target.label)) return;
        say('Workshop: preparing to load ' + escape(target.label) + '…');
        let next = target.text;
        if (target.example) {
          const response = await fetch('demo/' + encodeURIComponent(target.example) + '.txt');
          if (!response.ok) throw new Error('the example could not be fetched (HTTP ' + response.status + ')');
          next = await response.text();
          if (!next.trim()) throw new Error('the example is empty');
        }
        // Snapshot at approval time, after fetching the example. Edits received while the dialog
        // was open are included, and edits during the save will prevent replacement below.
        const current = editor.getValue();
        const title = current.match(/^\s*title[ \t]+([^\r\n]+)/im);
        say('Workshop: saving the current game before loading…');
        const result = await api('POST', 'workshop/saves', { group: 'saves', entry: { title: title ? title[1].trim() : 'Untitled', text: current } });
        if (result.status !== 200 || !result.body) throw new Error('the current game could not be saved (' + (result.body?.error || 'HTTP ' + result.status) + ')');
        onSaved(result.body);
        if (editor.getValue() !== current) {
          say('Workshop: the shared game changed while it was being saved. The latest edits are still here; try again to save them and load.');
          return;
        }
        editor.replaceDocument(next);
        clearConsole();
        setEditorClean();
        unloadGame();
        compile(['restart']);
        say('Workshop: saved the previous game to the room’s Load list and loaded ' + escape(target.label) + ' for everyone.');
      } catch (error) {
        say('Workshop: the game was not loaded (' + escape(error?.message || 'the bot could not be reached') + ').');
      } finally {
        examples.disabled = disabled[0];
        saves.disabled = disabled[1];
        busy = false;
      }
    }

    examples.removeEventListener('change', window.dropdownChange);
    saves.removeEventListener('change', window.loadDropDownChange);
    examples.addEventListener('change', () => {
      const option = examples.selectedOptions[0];
      const target = option && { label: option.textContent, example: option.value };
      examples.selectedIndex = 0;
      if (target?.example) load(target);
    });
    saves.addEventListener('change', () => {
      const option = saves.selectedOptions[0];
      saves.selectedIndex = 0;
      if (!option || option.parentNode.tagName !== 'OPTGROUP' || busy) return;
      try {
        const group = option.parentNode.id === 'loadDropdown_autosaves' ? 'autosaves' : 'saves';
        const list = JSON.parse(storage_get(group) || '[]');
        // The toolbar lists newest first. Labels only have minute precision, so identify the
        // selected entry by its position rather than its possibly duplicated title/date label.
        const index = Array.from(option.parentNode.children).indexOf(option);
        const saved = list[list.length - 1 - index];
        if (!saved || typeof saved.text !== 'string') throw new Error('that save is no longer in the room’s list');
        // Capture the selected game now: saving the current one refreshes this dropdown and may
        // trim the old selection out of the room's bounded save list.
        load({ label: saved.title, text: saved.text });
      } catch (error) {
        say('Workshop: the game was not loaded (' + escape(error.message) + ').');
      }
    });
  }
  window.WorkshopLoading = { install };
})();
