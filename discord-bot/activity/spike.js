'use strict';
// Throwaway page for the spike. It finds out what works inside Discord's Activity frame and posts
// what it finds to the bot, which writes it to its log. The editor replaces it.
(function () {
  const logEl = document.getElementById('log');
  const pad = document.getElementById('pad');
  const report = {
    at: new Date().toISOString(),
    ua: navigator.userAgent,
    host: location.hostname,
    inDiscord: /\.discordsays\.com$/.test(location.hostname),
    viewport: [],
    steps: [],
    input: {},
    layout: [],
    csp: [],
  };
  let dirty = true;
  let apiBase = null;

  function log(line) {
    logEl.textContent += line + '\n';
    logEl.scrollTop = logEl.scrollHeight;
  }
  function step(name, ok, detail) {
    report.steps.push({ name, ok, detail: detail === undefined ? null : String(detail).slice(0, 300) });
    log((ok ? 'ok    ' : 'FAIL  ') + name + (detail === undefined ? '' : ': ' + detail));
    dirty = true;
  }

  // The engine compiles every game's rules with new Function. If the frame's content security
  // policy forbids that, the engine cannot run here at all.
  try { step('new Function', new Function('return 6 * 7')() === 42); } catch (e) { step('new Function', false, e.message); }
  document.addEventListener('securitypolicyviolation', (e) => {
    report.csp.push(e.violatedDirective + ' ' + e.blockedURI);
    log('csp   ' + e.violatedDirective + ' ' + e.blockedURI);
    dirty = true;
  });

  function size() {
    const s = innerWidth + 'x' + innerHeight + ' @' + devicePixelRatio;
    if (report.viewport[report.viewport.length - 1] !== s) { report.viewport.push(s); log('size  ' + s); dirty = true; }
  }
  size();
  addEventListener('resize', size);

  // The same events the engine's editor listens for, on the document as it does.
  function count(type, describe) {
    document.addEventListener(type, (e) => {
      const first = !report.input[type];
      report.input[type] = (report.input[type] || 0) + 1;
      if (first) { log('input ' + type + ' ' + describe(e)); dirty = true; }
    }, { passive: true });
  }
  const at = (e) => { const p = e.touches && e.touches[0] ? e.touches[0] : e; return Math.round(p.clientX) + ',' + Math.round(p.clientY); };
  count('mousedown', (e) => 'button ' + e.button + ' at ' + at(e));
  count('mousemove', at);
  count('mouseup', at);
  count('touchstart', at);
  count('touchmove', at);
  count('touchend', () => '');
  count('pointerdown', (e) => e.pointerType + ' at ' + at(e));
  count('keydown', (e) => e.key);
  count('wheel', () => '');
  pad.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    if (!report.input.contextmenu) log('input contextmenu (right-click reached the page)');
    report.input.contextmenu = (report.input.contextmenu || 0) + 1;
    dirty = true;
  });

  // Inside Discord every request goes through the Activity's proxy. Which of these two forms
  // reaches the bot is one of the things being found out.
  async function findApi() {
    for (const base of ['api/', '/.proxy/api/']) {
      try {
        const r = await fetch(base + 'ping');
        const j = r.ok ? await r.json() : null;
        step('fetch ' + base + 'ping', !!(j && j.ok), r.status + (j ? ', the bot saw ' + j.path : ''));
        if (j && j.ok && apiBase === null) apiBase = base;
      } catch (e) { step('fetch ' + base + 'ping', false, e.message); }
    }
  }
  async function post(name, body) {
    const r = await fetch(apiBase + name, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { status: r.status, body: await r.json().catch(() => null) };
  }

  async function discord() {
    const lib = window.DiscordEmbeddedAppSDK;
    if (!lib) return step('sdk loaded', false, 'vendor/embedded-app-sdk.js did not run');
    step('sdk loaded', true);
    // Inside Discord the page is served from <application id>.discordsays.com.
    const clientId = location.hostname.split('.')[0];
    let sdk;
    try { sdk = new lib.DiscordSDK(clientId); } catch (e) { return step('sdk constructed', false, e.message); }
    step('sdk constructed', true);
    await sdk.ready();
    step('sdk ready', true, 'platform ' + sdk.platform + ', guild ' + sdk.guildId + ', channel ' + sdk.channelId);
    try {
      sdk.subscribe(lib.Events.ACTIVITY_LAYOUT_MODE_UPDATE, (e) => {
        report.layout.push(e.layout_mode);
        log('layout mode ' + e.layout_mode + ' (0 focused, 1 picture-in-picture, 2 grid)');
        dirty = true;
      });
      step('layout events subscribed', true);
    } catch (e) { step('layout events subscribed', false, e.message); }
    const { code } = await sdk.commands.authorize({ client_id: clientId, response_type: 'code', state: '', prompt: 'none', scope: ['identify'] });
    step('authorize', true);
    if (apiBase === null) return step('token', false, 'no way to reach the bot');
    const t = await post('token', { code });
    if (t.status !== 200) return step('token', false, t.status + ' ' + JSON.stringify(t.body));
    step('token', true);
    const auth = await sdk.commands.authenticate({ access_token: t.body.access_token });
    step('authenticate', !!(auth && auth.user), auth && auth.user ? 'signed in' : 'no user');
  }

  setInterval(() => {
    if (!dirty || apiBase === null) return;
    dirty = false;
    post('spike-report', report).catch(() => { dirty = true; });
  }, 3000);

  findApi().then(discord).catch((e) => step('discord', false, e && e.message ? e.message : String(e)));
})();
