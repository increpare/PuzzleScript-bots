'use strict';
const crypto = require('node:crypto');

const b64 = (buf) => Buffer.from(buf).toString('base64url');

// Signed, expiring tokens. The level editor page is handed two of them and hands them back: a
// session (who is signed in) and a ticket (what they are editing). Nothing about either is kept
// by the bot, so a restart signs nobody out, and neither can be made up or altered by the page.
function createSigner(key, { now = Date.now } = {}) {
  const mac = (body) => crypto.createHmac('sha256', key).update(body).digest();

  return {
    sign(payload, ttlMs) {
      const body = b64(JSON.stringify({ p: payload, e: now() + ttlMs }));
      return body + '.' + b64(mac(body));
    },
    // The payload, or null for anything that was not signed here, has been altered, or has expired.
    verify(token) {
      if (typeof token !== 'string') return null;
      const parts = token.split('.');
      if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
      const given = Buffer.from(parts[1], 'base64url');
      const wanted = mac(parts[0]);
      // re-encoding catches a signature with stray characters that base64 decoding would ignore
      if (given.length !== wanted.length || b64(given) !== parts[1] || !crypto.timingSafeEqual(given, wanted)) return null;
      let data;
      try { data = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8')); } catch (e) { return null; }
      if (!data || typeof data.e !== 'number' || now() >= data.e) return null;
      return data.p;
    },
  };
}

// The key is derived from the bot token, so there is no further secret to configure, and the
// token itself is never used to sign anything.
function signingKey(discordToken) {
  return crypto.createHmac('sha256', String(discordToken)).update('psbot-tweak-v1').digest();
}

module.exports = { createSigner, signingKey };
