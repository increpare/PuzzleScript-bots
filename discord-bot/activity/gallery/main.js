'use strict';
// The gallery submission page. The game is played here in the PuzzleScript engine as play.html
// runs it; what is pressed on one level (the take) is replayed into a GIF, as the editor's
// recorder does it, and the GIF is sent to the bot with the game's title, author and homepage.
// The page is opened by a link from /admin_gallery, whose token is in the address after the #.
(function () {
  const $ = (id) => document.getElementById(id);
  const MAX_GIF_BYTES = 2 * 1024 * 1024;
  // How long the level is shown before the first input, as in the editor's recorder.
  const FIRST_MS = 200;
  // Browsers play a frame shorter than this at a tenth of a second instead.
  const MIN_DELAY_MS = 20;
  // A chain of again turns that has not ended by now never will.
  const MAX_AGAIN = 500;

  const token = new URLSearchParams(location.hash.slice(1)).get('t');
  let source = null;
  let inGallery = false;
  // { level, seed, inputs, closed }: closed is null while inputs are still being added, or why
  // they no longer are: 'won', 'left' (play went elsewhere) or 'gif' (a GIF was made of it).
  let take = null;
  let gif = null; // { base64, bytes, width, height, frames }
  let replaying = false;
  let sending = false;
  let submitted = false;

  const say = (text) => { $('status').textContent = text; };

  async function call(path, body) {
    const res = await fetch('../api/gallery/' + path, {
      method: body ? 'POST' : 'GET',
      headers: Object.assign({ authorization: 'Bearer ' + token }, body ? { 'content-type': 'application/json' } : {}),
      body: body ? JSON.stringify(body) : undefined,
    });
    const answer = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(answer.error || 'the server answered ' + res.status);
    return answer;
  }

  function show() {
    const n = take ? take.inputs.length : 0;
    const el = $('take');
    el.dataset.inputs = JSON.stringify(take ? take.inputs : []);
    el.dataset.closed = (take && take.closed) || '';
    const ends = { won: ': the level is won, and the take is complete.', left: ': play has left the level, and the take is closed.', gif: ': a GIF was made of it. Start again for another take.' };
    el.textContent = take ? n + (n === 1 ? ' input' : ' inputs') + (take.closed ? ends[take.closed] : ' so far.') : '';
    $('again').disabled = !take || replaying;
    $('make').disabled = !take || n === 0 || replaying;
    $('submit').disabled = !gif || gif.bytes > MAX_GIF_BYTES || inGallery || sending || submitted;
    if (gif) {
      $('preview').src = 'data:image/gif;base64,' + gif.base64;
      $('gifinfo').textContent = gif.width + ' × ' + gif.height + ', ' + gif.frames + (gif.frames === 1 ? ' frame, ' : ' frames, ') + Math.ceil(gif.bytes / 1024) + ' KB'
        + (gif.bytes > MAX_GIF_BYTES ? '. That is over the 2 MB the gallery takes: make a shorter take.' : '');
    } else {
      $('preview').removeAttribute('src');
      $('gifinfo').textContent = '';
    }
  }

  // Has play gone on from the level the take is of?
  const left = () => winning || titleScreen || curlevel !== take.level;

  function close(why) {
    take.closed = why;
    show();
  }

  // The engine tells its recorder of every input: a direction, 'undo', 'restart', or 'tick' for a
  // turn that a realtime game took by itself. play.html's recorder does nothing; this one keeps them.
  pushInput = function (input) {
    if (replaying || take === null || take.closed) return;
    if (left()) return close(winning ? 'won' : 'left');
    take.inputs.push(input);
    show();
  };
  // The winning input is the take's last. The engine says nothing when a level is won, so it is watched for.
  setInterval(() => {
    if (take && !take.closed && !replaying && left()) close(winning ? 'won' : 'left');
  }, 50);

  function load(index) {
    // The seed is kept so that the replay takes the same random turns.
    const seed = String(Date.now()) + Math.random();
    take = null;
    compile(['loadLevel', index], source, seed);
    take = { level: index, seed, inputs: [], closed: null };
    gif = null;
    show();
  }

  const same = (a, b) => {
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  };

  // The take, played again from the start into a looping GIF of the level alone.
  function makeGif() {
    if (!take.closed) take.closed = 'gif';
    replaying = true;
    // the engine's own switch for replays: no sounds, and no stopping on messages
    unitTesting = true;
    let encoder, width, height, frames = 0;
    try {
      compile(['loadLevel', take.level], source, take.seed);
      canvasResize();
      width = screenwidth * cellwidth;
      height = screenheight * cellheight;
      const shot = document.createElement('canvas');
      shot.width = width;
      shot.height = height;
      const ctx = shot.getContext('2d', { willReadFrequently: true });
      encoder = new GIFEncoder();
      encoder.setRepeat(0); // for ever
      encoder.start();
      encoder.setSize(width, height);
      // The frame not yet written: it stays back so that it can be shown for longer if the next
      // picture is the same. A realtime game ticks many times with nothing moving.
      let held = null;
      const write = () => {
        encoder.setDelay(Math.max(MIN_DELAY_MS, held.ms));
        encoder.addFrame(held.data, true);
        frames++;
      };
      const frame = (ms) => {
        redraw();
        ctx.drawImage(canvas, -xoffset, -yoffset);
        const data = ctx.getImageData(0, 0, width, height).data;
        if (held && same(held.data, data)) { held.ms += ms; return; }
        if (held) write();
        held = { data, ms };
      };
      frame(FIRST_MS);
      for (const input of take.inputs) {
        // Wins are not acted on (the second argument), so a take that ends in one rests on the
        // solved level and does not go on to the next.
        if (input === 'undo') DoUndo(false, true);
        else if (input === 'restart') DoRestart();
        else if (input === 'tick') processInput(-1, true);
        else processInput(input, true);
        frame(input === 'tick' ? autotickinterval : repeatinterval);
        for (let n = 0; againing && n < MAX_AGAIN; n++) {
          processInput(-1, true);
          frame(againinterval);
        }
        againing = false;
      }
      write();
      encoder.finish();
    } finally {
      unitTesting = false;
      replaying = false;
    }
    const binary = encoder.stream().getData();
    gif = { base64: btoa(binary), bytes: binary.length, width, height, frames };
    show();
  }

  function link(href, text) {
    const a = document.createElement('a');
    a.href = href;
    a.target = '_blank';
    a.rel = 'noopener';
    a.textContent = text;
    return a;
  }
  function tell(...parts) {
    const p = document.createElement('p');
    p.append(...parts);
    $('outcome').append(p);
  }

  async function submit() {
    sending = true;
    show();
    $('outcome').textContent = 'Submitting…';
    try {
      const out = await call('submit', { gif: gif.base64, title: $('title').value, author: $('author').value, homepage: $('homepage').value });
      $('outcome').textContent = '';
      if (!out.ok) tell('It was not added: ' + out.error + '.');
      else {
        submitted = true;
        tell('Added: ', link(out.commitUrl, 'the commit'), ' and ', link(out.galleryUrl, 'the gallery'), '.');
        if (out.site) tell('The live site was not updated (' + out.site + '). The next upload of the site puts the game on it.');
        if (out.botCopy) tell('The bot\'s own list was not updated (' + out.botCopy + '). /play will suggest the game after the next deploy.');
      }
    } catch (e) {
      $('outcome').textContent = 'It was not added: ' + e.message + '.';
    } finally {
      sending = false;
      show();
    }
  }

  // The engine takes keys from the whole page, and stops arrows and space doing anything else.
  // In a field they are typing, so the engine does not get to hear of them.
  for (const id of ['title', 'author', 'homepage']) {
    for (const type of ['keydown', 'keyup']) $(id).addEventListener(type, (e) => e.stopPropagation());
  }
  // A control that keeps the focus would take the next keys of the game, so it gives it up.
  $('level').addEventListener('change', () => { load(Number($('level').value)); $('level').blur(); });
  $('again').addEventListener('click', () => { load(take.level); $('again').blur(); });
  // A long take is a while in the making, and nothing is drawn meanwhile: say so first.
  $('make').addEventListener('click', () => {
    $('make').blur();
    $('make').disabled = true;
    $('gifinfo').textContent = 'Making the GIF…';
    setTimeout(makeGif, 30);
  });
  $('submit').addEventListener('click', () => { $('submit').blur(); submit(); });

  async function start() {
    if (!token) return say('This page is opened from Discord: run /admin_gallery there for a link.');
    let game;
    try { game = await call('game'); } catch (e) { return say(e.message.charAt(0).toUpperCase() + e.message.slice(1) + '.'); }
    source = game.source;
    inGallery = game.inGallery;
    compile(['restart'], source);
    if (!hasLoadedGame()) return say('The game could not be compiled.');
    // message screens are levels to the engine, and are not for playing
    const levels = [];
    state.levels.forEach((level, index) => { if (level.message === undefined) levels.push(index); });
    if (levels.length === 0) return say('The game has no level to play.');
    levels.forEach((index, n) => {
      const option = document.createElement('option');
      option.value = String(index);
      option.textContent = 'Level ' + (n + 1);
      $('level').append(option);
    });
    $('title').value = state.metadata.title || '';
    $('author').value = state.metadata.author || '';
    $('homepage').value = state.metadata.homepage || '';
    document.title = (state.metadata.title || 'A game') + ' - add to the gallery';
    say(inGallery ? 'This game is already in the gallery. It can be played here, but not submitted.' : 'Pick a level, play it, make a GIF of the take, and submit.');
    load(levels[0]);
  }
  start();
})();
