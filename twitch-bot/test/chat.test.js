'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('node:events');
const { parseLine, createChat } = require('../chat');

function harness() {
  const sockets = [], timers = [], messages = [];
  const connect = (onReady) => {
    const s = new EventEmitter();
    s.written = [];
    s.write = (d) => { s.written.push(d); };
    s.setEncoding = () => {};
    s.setTimeout = (ms, fn) => { s.silenceMs = ms; s.onSilence = fn; };
    s.destroy = () => { if (!s.destroyed) { s.destroyed = true; s.emit('close'); } };
    s.ready = onReady;
    sockets.push(s);
    return s;
  };
  const chat = createChat({
    channel: 'somechannel', onMessage: (m) => messages.push(m), connect,
    setTimer: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    clearTimer: (id) => { timers[id - 1].cleared = true; },
    random: () => 0.5, log: () => {},
  });
  return { chat, sockets, timers, messages };
}

test('parseLine recognises the lines we care about', () => {
  assert.deepEqual(parseLine('PING :tmi.twitch.tv'), { type: 'ping', payload: ':tmi.twitch.tv' });
  assert.deepEqual(parseLine(':Pip!pip@pip.tmi.twitch.tv PRIVMSG #somechannel :Up'), { type: 'message', user: 'pip', text: 'Up' });
  assert.deepEqual(parseLine('@badges=;color=#fff :pip!pip@pip.tmi.twitch.tv PRIVMSG #c :a: b :c'), { type: 'message', user: 'pip', text: 'a: b :c' });
  assert.deepEqual(parseLine(':tmi.twitch.tv RECONNECT'), { type: 'reconnect' });
  assert.deepEqual(parseLine(':tmi.twitch.tv 001 justinfan1 :Welcome, GLHF!'), { type: 'other' });
});

test('logs in anonymously and joins the channel once connected', () => {
  const h = harness();
  h.chat.start();
  assert.equal(h.sockets.length, 1);
  assert.deepEqual(h.sockets[0].written, []);
  h.sockets[0].ready();
  assert.equal(h.sockets[0].written.join(''), 'PASS SCHMOOPIIE\r\nNICK justinfan50000\r\nJOIN #somechannel\r\n');
});

test('answers PING and reports chat messages, even split across chunks', () => {
  const h = harness();
  h.chat.start();
  const s = h.sockets[0];
  s.ready();
  s.written.length = 0;
  s.emit('data', 'PING :tmi.twitch.tv\r\n:pip!pip@pip.tmi.twitch.tv PRIVMSG #somecha');
  assert.deepEqual(s.written, ['PONG :tmi.twitch.tv\r\n']);
  assert.deepEqual(h.messages, []);
  s.emit('data', 'nnel :left\r\n');
  assert.deepEqual(h.messages, [{ user: 'pip', text: 'left' }]);
});

test('a handler that throws does not break the connection', () => {
  const sockets = [];
  const chat = createChat({
    channel: 'c', onMessage: () => { throw new Error('boom'); }, log: () => {},
    connect: (onReady) => { const s = new EventEmitter(); s.write = () => {}; s.setEncoding = () => {}; s.setTimeout = () => {}; s.destroy = () => {}; s.ready = onReady; sockets.push(s); return s; },
  });
  chat.start();
  assert.doesNotThrow(() => sockets[0].emit('data', ':a!a@a PRIVMSG #c :up\r\n'));
});

test('reconnects with a doubling delay that resets once data arrives', () => {
  const h = harness();
  h.chat.start();
  h.sockets[0].destroy();
  assert.equal(h.timers[0].ms, 1000);
  h.timers[0].fn();
  h.sockets[1].destroy();
  assert.equal(h.timers[1].ms, 2000);
  h.timers[1].fn();
  h.sockets[2].emit('data', ':tmi.twitch.tv 001 x :Welcome\r\n');
  h.sockets[2].destroy();
  assert.equal(h.timers[2].ms, 1000);
});

test('the delay never exceeds 30 seconds', () => {
  const h = harness();
  h.chat.start();
  for (let i = 0; i < 8; i++) { h.sockets[i].destroy(); h.timers[i].fn(); }
  assert.equal(h.timers[7].ms, 30000);
});

test('a server RECONNECT and a long silence both drop the connection', () => {
  const h = harness();
  h.chat.start();
  h.sockets[0].emit('data', ':tmi.twitch.tv RECONNECT\r\n');
  assert.equal(h.sockets[0].destroyed, true);
  h.timers[0].fn();
  assert.equal(h.sockets[1].silenceMs, 600000);
  h.sockets[1].onSilence();
  assert.equal(h.sockets[1].destroyed, true);
});

test('close stops reconnecting', () => {
  const h = harness();
  h.chat.start();
  h.chat.close();
  assert.equal(h.sockets[0].destroyed, true);
  assert.equal(h.timers.length, 0);
});
