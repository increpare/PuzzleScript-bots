'use strict';

class OAuthError extends Error {}

// The sign-in step of a Discord Activity. The page gets a one-time code from the Discord client and
// posts it here; only the bot holds the client secret that turns the code into an access token.
// Discord is then asked whose token it is, so the bot never takes the page's word for who is using it.
function createOAuth({ clientId, clientSecret, fetchImpl = globalThis.fetch }) {
  async function ask(url, opts) {
    try { return await fetchImpl(url, opts); }
    catch (e) { throw new OAuthError('could not reach Discord'); }
  }

  async function exchange(code) {
    if (typeof code !== 'string' || !code || code.length > 200) throw new OAuthError('bad code');
    const res = await ask('https://discord.com/api/oauth2/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, grant_type: 'authorization_code', code }).toString(),
    });
    if (!res.ok) throw new OAuthError('Discord refused the code (' + res.status + ')');
    const accessToken = (await res.json()).access_token;
    if (typeof accessToken !== 'string' || !accessToken) throw new OAuthError('Discord sent no token');
    const who = await ask('https://discord.com/api/users/@me', { headers: { authorization: 'Bearer ' + accessToken } });
    if (!who.ok) throw new OAuthError('Discord refused the token (' + who.status + ')');
    const u = await who.json();
    return { accessToken, user: { id: String(u.id), name: String(u.global_name || u.username || '') } };
  }

  return { exchange };
}

module.exports = { createOAuth, OAuthError };
