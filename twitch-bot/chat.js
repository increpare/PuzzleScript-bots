'use strict';
const tls = require('node:tls');

const HOST = 'irc.chat.twitch.tv';
const FIRST_DELAY = 1000, MAX_DELAY = 30000, SILENCE_MS = 10 * 60 * 1000;

function parseLine(line) {
  let s = String(line);
  if (s.startsWith('PING')) return { type: 'ping', payload: s.slice(4).trim() };
  if (s.startsWith('@')) s = s.slice(s.indexOf(' ') + 1); // IRCv3 tags, should the server send them
  const m = /^:([^!\s]+)!\S+ PRIVMSG #\S+ :(.*)$/.exec(s);
  if (m) return { type: 'message', user: m[1].toLowerCase(), text: m[2] };
  if (/^:\S+ RECONNECT\b/.test(s)) return { type: 'reconnect' };
  return { type: 'other' };
}

function defaultConnect(onReady) {
  return tls.connect({ host: HOST, port: 6697, servername: HOST }, onReady);
}

// Read-only chat: an anonymous login needs no Twitch account or token.
function createChat({ channel, onMessage, connect = defaultConnect, setTimer = setTimeout, clearTimer = clearTimeout, random = Math.random, log = console.log }) {
  let socket = null, timer = null, delay = FIRST_DELAY, closed = false;

  function open() {
    timer = null;
    if (closed) return;
    let buffer = '';
    const sock = connect(() => {
      sock.write('PASS SCHMOOPIIE\r\nNICK justinfan' + (10000 + Math.floor(random() * 80000)) + '\r\nJOIN #' + channel + '\r\n');
    });
    socket = sock;
    sock.setEncoding('utf8');
    // Twitch pings every few minutes, so a long silence means the connection is dead.
    sock.setTimeout(SILENCE_MS, () => sock.destroy());
    sock.on('data', (chunk) => {
      delay = FIRST_DELAY;
      buffer += chunk;
      const lines = buffer.split('\r\n');
      buffer = lines.pop();
      for (const line of lines) {
        const msg = parseLine(line);
        if (msg.type === 'ping') sock.write('PONG ' + msg.payload + '\r\n');
        else if (msg.type === 'reconnect') sock.destroy();
        else if (msg.type === 'message') {
          try { onMessage({ user: msg.user, text: msg.text }); } catch (e) { log('chat handler failed', e); }
        }
      }
    });
    sock.on('error', (e) => log('chat error', e && e.message));
    sock.on('close', () => {
      if (socket !== sock) return;
      socket = null;
      if (closed) return;
      log('chat closed, reconnecting in ' + delay + ' ms');
      timer = setTimer(open, delay);
      delay = Math.min(delay * 2, MAX_DELAY);
    });
  }

  return {
    start() { if (!closed && socket === null && timer === null) open(); },
    close() {
      closed = true;
      if (timer !== null) { clearTimer(timer); timer = null; }
      if (socket) socket.destroy();
    },
  };
}

module.exports = { parseLine, createChat };
