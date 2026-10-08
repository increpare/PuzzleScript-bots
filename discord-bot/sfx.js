'use strict';
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { SRC_DIR } = require('./engine-src');

// The kinds of sound the engine can make, in its own order and under its own names: the last two
// digits of a seed pick one of them (see generateFromSeed in the engine's sfxr.js).
const KINDS = ['pickupCoin', 'laserShoot', 'explosion', 'powerUp', 'hitHurt', 'jump', 'blipSelect', 'pushSound', 'random', 'birdSound'];
// The editor's own seeds are at most eight digits long.
const MAX_SEED_DIGITS = 12;

const refuse = (error) => ({ ok: false, error });
const kindOf = (seed) => KINDS[(seed % 100) % KINDS.length];

// What /sfx was asked for: a seed, a kind of sound (which gets a new seed, made as the editor's
// sound buttons make one), or nothing, which is a kind picked at random.
function parseSound(text, random = Math.random) {
  const t = String(text === undefined || text === null ? '' : text).trim();
  if (/^\d+$/.test(t)) {
    if (t.length > MAX_SEED_DIGITS) return refuse('that is too long to be a sound seed');
    const seed = Number(t);
    return { ok: true, seed, kind: kindOf(seed) };
  }
  let index = KINDS.findIndex((k) => k.toLowerCase() === t.toLowerCase());
  if (t === '') index = Math.min(KINDS.length - 1, Math.floor(random() * KINDS.length));
  if (index === -1) return refuse('give a sound seed (a number), or one of: ' + KINDS.join(', '));
  const seed = index + 100 * ((random() * 1000000) | 1);
  return { ok: true, seed, kind: KINDS[index] };
}

// The kinds whose name has the typed text in it, as choices for the command's autocomplete.
function suggestSounds(query) {
  const q = String(query || '').trim().toLowerCase();
  return KINDS.filter((k) => k.toLowerCase().includes(q)).map((k) => ({ name: k, value: k }));
}

// The engine's sound generator, run as the editor runs it. It is given a stand-in for the browser's
// AudioContext that only holds the samples, which is all the generator asks of it.
let generate = null;
function getGenerator() {
  if (generate === null) {
    class AudioContext {
      createBuffer(channels, length, sampleRate) {
        const data = new Float32Array(length);
        return { length, sampleRate, getChannelData: () => data };
      }
    }
    const sandbox = { AudioContext, console: { log() {} } };
    sandbox.window = sandbox;
    const ctx = vm.createContext(sandbox);
    for (const file of ['rng.js', 'sfxr.js']) {
      vm.runInContext(fs.readFileSync(path.join(SRC_DIR, 'js', file), 'utf8'), ctx, { filename: file });
    }
    // as cacheSeed does in the engine
    generate = vm.runInContext(`(function (seed) {
      const params = generateFromSeed(seed);
      params.sound_vol = SOUND_VOL;
      params.sample_rate = SAMPLE_RATE;
      params.bit_depth = BIT_DEPTH;
      const sound = SoundEffect.generate(params);
      return { rate: sound._buffer.sampleRate, samples: sound.getBuffer() };
    })`, ctx);
  }
  return generate;
}

// The editor plays a sound through three of the browser's lowpass filters in a row, each at 1600 Hz
// and with the browser's default resonance of 1 dB (SoundEffect.prototype.play). This is that filter,
// from the formula in the Web Audio specification, so that a sound here is the sound heard there.
const FILTER_HZ = 1600, FILTER_Q_DB = 1, FILTER_STAGES = 3;
function lowpass(samples, rate) {
  const w0 = 2 * Math.PI * FILTER_HZ / rate;
  const cos = Math.cos(w0);
  const alpha = Math.sin(w0) / (2 * Math.pow(10, FILTER_Q_DB / 20));
  const a0 = 1 + alpha;
  const b0 = (1 - cos) / 2 / a0, b1 = (1 - cos) / a0, b2 = b0, a1 = -2 * cos / a0, a2 = (1 - alpha) / a0;
  let out = Float64Array.from(samples);
  for (let stage = 0; stage < FILTER_STAGES; stage++) {
    const next = new Float64Array(out.length);
    let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
    for (let i = 0; i < out.length; i++) {
      const x = out[i];
      const y = b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
      x2 = x1; x1 = x; y2 = y1; y1 = y;
      next[i] = y;
    }
    out = next;
  }
  return out;
}

// The sound of a seed as a WAV file: one channel, 16 bit.
function renderSound(seed) {
  const { rate, samples } = getGenerator()(seed);
  const filtered = lowpass(samples, rate);
  const wav = Buffer.alloc(44 + filtered.length * 2);
  wav.write('RIFF', 0, 'latin1');
  wav.writeUInt32LE(wav.length - 8, 4);
  wav.write('WAVEfmt ', 8, 'latin1');
  wav.writeUInt32LE(16, 16);        // size of the format block
  wav.writeUInt16LE(1, 20);         // PCM
  wav.writeUInt16LE(1, 22);         // one channel
  wav.writeUInt32LE(rate, 24);
  wav.writeUInt32LE(rate * 2, 28);  // bytes a second
  wav.writeUInt16LE(2, 32);         // bytes a sample
  wav.writeUInt16LE(16, 34);        // bits a sample
  wav.write('data', 36, 'latin1');
  wav.writeUInt32LE(filtered.length * 2, 40);
  for (let i = 0; i < filtered.length; i++) {
    // louder than full volume is cut off, as the browser cuts it off
    wav.writeInt16LE(Math.round(Math.max(-1, Math.min(1, filtered[i])) * 32767), 44 + i * 2);
  }
  return { wav, seconds: filtered.length / rate };
}

module.exports = { parseSound, suggestSounds, renderSound, lowpass, KINDS };
