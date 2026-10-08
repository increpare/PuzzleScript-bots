'use strict';
// Adapt the editor's sound, download and console-link controls to the Activity's frame.
window.WorkshopControls = {
  install({ say, api, inDiscord }) {
    // The line numbers in the console (a rule in the debug output, the line of an error) reach the
    // code through parent.form1, which is the editor's own page only when nothing frames it. Inside
    // Discord the parent is Discord, which the page may not look into, so the links did nothing.
    window.jumpToLine = (line) => editor.revealLine(line - 1, { cursor: 0, y: 'center' });


    window.newSound = (instrument) => {
      const seed = instrument + 100 * Math.floor(Math.random() * 1000000);
      // Print first: even if audio is unavailable, the seed is still useful in the game.
      say(generatorNames[instrument] + ' : <span class="cm-SOUND" onclick="playSound(' + seed + ',true)">' + seed + '</span>');
      try { playSound(seed, true); }
      catch (e) { say('Workshop: the sound seed was generated, but audio could not be played.'); }
    };

    const browserSaveAs = window.saveAs;
    let exporting = false;
    window.saveAs = async (text, type, filename) => {
      if (!inDiscord() || !/^text\/html\b/i.test(type)) return browserSaveAs(text, type, filename);
      if (exporting) return;
      exporting = true;
      say('Workshop: preparing download links…');
      try {
        const r = await api('POST', 'workshop/export', { html: text, source: editor.getValue(), filename });
        if (r.status !== 200 || !r.body || !r.body.ok) throw new Error((r.body && r.body.error) || 'the bot did not answer');
        const anchor = (url, label) => {
          const a = document.createElement('a');
          a.className = 'ws-download';
          a.href = url;
          a.target = '_blank';
          a.textContent = label;
          return a.outerHTML;
        };
        say('Workshop: ' + anchor(r.body.htmlUrl, 'Download the standalone HTML game') + '<br>'
          + anchor(r.body.sourceUrl, 'Download the source (.txt)') + '<br>These links expire in 15 minutes.');
      } catch (e) {
        // Errors may contain user text: turn it into text before putting it in the console.
        const message = document.createElement('span');
        message.textContent = 'Workshop: export failed (' + e.message + ').';
        say(message.innerHTML);
      } finally { exporting = false; }
    };
  },
};
