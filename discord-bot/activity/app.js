'use strict';
// The level editor page, first version: the level as text in a box. It signs in through the
// Discord client, asks the bot what this user pressed the pencil on, and sends the edited level
// back. The engine's own editor replaces the box; everything else here stays.
(function () {
  const $ = (id) => document.getElementById(id);
  const levelBox = $('level');
  let sdk = null;
  let session = null; // the bot's signed word for who is signed in; sent with every request
  let ticket = null;  // the bot's signed word for what is being edited; sent back with the level
  let original = '';

  function setStatus(text) { $('status').textContent = text; }
  function setResult(text, isError) {
    $('result').textContent = text;
    $('result').classList.toggle('error', !!isError);
  }

  // Paths are relative: inside Discord the page is served through the Activity's proxy, and
  // outside it from wherever the bot's server is mounted.
  async function api(method, name, body) {
    const headers = {};
    if (session) headers.authorization = 'Bearer ' + session;
    if (body) headers['content-type'] = 'application/json';
    const r = await fetch('api/' + name, { method, headers, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json().catch(() => null) };
  }

  async function signIn() {
    // Inside Discord the page is served from <application id>.discordsays.com.
    const clientId = location.hostname.split('.')[0];
    await sdk.ready();
    const { code } = await sdk.commands.authorize({ client_id: clientId, response_type: 'code', state: '', prompt: 'none', scope: ['identify'] });
    const t = await api('POST', 'token', { code });
    if (t.status !== 200) throw new Error((t.body && t.body.error) || 'the bot did not answer');
    session = t.body.session;
    await sdk.commands.authenticate({ access_token: t.body.access_token });
  }

  async function loadLevel() {
    const t = await api('GET', 'tweak');
    if (t.status === 404) return setStatus('Nothing to edit. Close this and press the pencil under a game.');
    if (t.status !== 200) return setStatus('The level could not be loaded. Close this and press the pencil again.');
    ticket = t.body.ticket;
    original = t.body.levelText;
    $('title').textContent = t.body.title;
    levelBox.value = original;
    levelBox.hidden = false;
    $('actions').hidden = false;
    setStatus('Edit the level, one row per line, then send it. It is posted as a new level; the game you came from is not changed.');
    levelBox.focus();
  }

  async function send() {
    $('send').disabled = true;
    setResult('Sending…');
    try {
      const r = await api('POST', 'levels', { ticket, text: levelBox.value });
      if (r.status === 401) setResult('Your sign-in has run out. Close this and press the pencil again.', true);
      else if (r.status !== 200 || !r.body) setResult('The bot did not answer. Try again in a moment.', true);
      else if (!r.body.ok) setResult(r.body.error, true);
      else {
        setResult('Sent. Close this to find it in the game’s levels thread.');
        $('close').hidden = false;
      }
    } catch (e) {
      setResult('The bot could not be reached. Try again in a moment.', true);
    }
    $('send').disabled = false;
  }

  $('send').addEventListener('click', send);
  $('reset').addEventListener('click', () => { levelBox.value = original; setResult(''); levelBox.focus(); });
  $('close').addEventListener('click', () => { if (sdk) sdk.close(1000, 'level sent'); });

  const lib = window.DiscordEmbeddedAppSDK;
  try {
    sdk = new lib.DiscordSDK(location.hostname.split('.')[0]);
  } catch (e) {
    // the SDK refuses to start without the frame Discord puts an Activity in
    setStatus('This page only works inside Discord: press the pencil under a game there.');
    return;
  }
  signIn().then(loadLevel).catch((e) => setStatus('Signing in failed (' + (e && e.message ? e.message : e) + '). Close this and press the pencil again.'));
})();
