'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { parseSound, suggestSounds, renderSound, lowpass } = require('../sfx');

test('a number is taken as that seed, and its kind is the one the engine reads from it', () => {
  // "Crate move 36772507" in the sokoban example: the last two digits pick the generator, and 7 is the push
  assert.deepEqual(parseSound('36772507'), { ok: true, seed: 36772507, kind: 'pushSound' });
  assert.deepEqual(parseSound(' 9675111 '), { ok: true, seed: 9675111, kind: 'laserShoot' });
});

test('a kind, in any case, makes a new seed of that kind the way the editor\'s sound buttons do', () => {
  // the editor: kind + 100 * ((random * 1000000) | 1), and explosion is kind 2
  assert.deepEqual(parseSound('Explosion', () => 0.5), { ok: true, seed: 50000102, kind: 'explosion' });
  assert.deepEqual(parseSound('birdSound', () => 0.25), { ok: true, seed: 25000109, kind: 'birdSound' });
});

test('nothing at all makes a sound of a kind picked at random', () => {
  const rolls = [0.5, 0.123456];
  // the first roll picks kind 5 of the ten, which is jump
  assert.deepEqual(parseSound(undefined, () => rolls.shift()), { ok: true, seed: 12345705, kind: 'jump' });
  assert.equal(parseSound('', () => 0.99).kind, 'birdSound');
});

test('anything else is refused, and the refusal names the kinds', () => {
  const r = parseSound('kaboom');
  assert.equal(r.ok, false);
  assert.match(r.error, /explosion/);
  assert.equal(parseSound('-5').ok, false);
  assert.equal(parseSound('1234567890123').ok, false, 'longer than any seed the editor makes');
});

test('kinds are suggested by any part of their name', () => {
  assert.deepEqual(suggestSounds('ex'), [{ name: 'explosion', value: 'explosion' }]);
  assert.deepEqual(suggestSounds('SOUND').map((c) => c.value), ['pushSound', 'birdSound']);
  assert.equal(suggestSounds('').length, 10);
  assert.deepEqual(suggestSounds('12345'), []);
});

test('a sound is a WAV file: mono, 16 bit, at the rate the editor plays it', () => {
  const { wav, seconds } = renderSound(36772507);
  assert.equal(wav.toString('latin1', 0, 4), 'RIFF');
  assert.equal(wav.readUInt32LE(4), wav.length - 8);
  assert.equal(wav.toString('latin1', 8, 16), 'WAVEfmt ');
  assert.deepEqual([wav.readUInt16LE(20), wav.readUInt16LE(22), wav.readUInt32LE(24), wav.readUInt16LE(34)], [1, 1, 22050, 16], 'PCM, one channel, 22050 Hz, 16 bit');
  assert.equal(wav.toString('latin1', 36, 40), 'data');
  assert.equal(wav.readUInt32LE(40), wav.length - 44);
  assert.equal(seconds, (wav.length - 44) / 2 / 22050);
  assert.ok(seconds > 0.005 && seconds < 10, 'it lasts a moment (this one is a short thud): ' + seconds);
  let loudest = 0;
  for (let i = 44; i < wav.length; i += 2) loudest = Math.max(loudest, Math.abs(wav.readInt16LE(i)));
  assert.ok(loudest > 1000, 'it is not silence');
});

test('a seed makes its own sound: the same one each time, and another seed another', () => {
  // (Only the noise in a sound differs from one playing to the next, here as in the editor: the
  // engine does not seed it. This seed, a laser the engine's source is fond of, has none.)
  assert.ok(renderSound(9675111).wav.equals(renderSound(9675111).wav));
  assert.ok(!renderSound(9675111).wav.equals(renderSound(9675211).wav));
});

// The editor plays every sound through three of the browser's lowpass filters at 1600 Hz, each with
// the browser's default resonance of 1 dB. A tone's loudness after them follows from that alone.
function throughFilter(hz) {
  const rate = 22050, n = 22050;
  const tone = new Float32Array(n);
  for (let i = 0; i < n; i++) tone[i] = Math.sin(2 * Math.PI * hz * i / rate);
  const out = lowpass(tone, rate);
  let peak = 0;
  for (let i = n / 2; i < n; i++) peak = Math.max(peak, Math.abs(out[i])); // once it has settled
  return peak;
}

test('sounds are filtered as the editor filters them', () => {
  assert.ok(Math.abs(throughFilter(100) - 1) < 0.02, 'low tones pass as they are: ' + throughFilter(100));
  // 1 dB of resonance at the cutoff, three times over: 3 dB, a factor of 1.41
  assert.ok(Math.abs(throughFilter(1600) - 1.4125) < 0.03, 'the cutoff is where the resonance is: ' + throughFilter(1600));
  // 12 dB an octave each, 36 together: two octaves up is some 70 dB down
  assert.ok(throughFilter(6400) < 0.001, 'high tones are all but gone: ' + throughFilter(6400));
});
