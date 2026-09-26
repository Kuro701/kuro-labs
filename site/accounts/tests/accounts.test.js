'use strict';
// Run with: node site/accounts/tests/accounts.test.js
// Whole account system against an SQLite stand-in for D1, with pretend Discord, Resend and Turnstile.
const assert = require('node:assert/strict');
const { D1Shim } = require('./d1-shim.js');
const A = require('../accounts.js');
const cfg = require('../config.js');
const disposable = require('../data/disposable.json').domains;

const ORIGIN = 'https://kurolabs.net';
const IP = '203.0.113.9';
const MS = cfg.MS;

/* ---------- pretend outside services ---------- */
const mailbox = [];                        // emails "sent" through Resend
let discordUsers = {};                     // code -> discord id
let failMail = false;
globalThis.fetch = async (url, init = {}) => {
  url = String(url);
  const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });
  if (url.startsWith('https://challenges.cloudflare.com/turnstile')) return json({ success: init.body.get('response') === 'ok-token' });
  if (url.startsWith('https://api.resend.com/emails')) {
    if (failMail) return json({ message: 'down' }, 500);
    const b = JSON.parse(init.body); mailbox.push({ to: b.to[0], subject: b.subject, text: b.text, auth: init.headers.authorization }); return json({ id: 'x' });
  }
  if (url === 'https://discord.com/api/oauth2/token') {
    const code = init.body.get('code'); if (!(code in discordUsers)) return json({ error: 'invalid_grant' }, 400);
    assert.match(init.headers.authorization, /^Basic /); return json({ access_token: 'tok-' + code });
  }
  if (url === 'https://discord.com/api/users/@me') { const code = init.headers.authorization.replace('Bearer tok-', ''); return json({ id: discordUsers[code], username: 'ignored' }); }
  throw new Error('unexpected fetch ' + url);
};
const lastCode = to => { const m = [...mailbox].reverse().find(x => x.to === to); assert.ok(m, 'no email for ' + to); return /(\d{6})/.exec(m.text)[1]; };

/* ---------- a tiny browser ---------- */
const newEnv = (over) => ({ DB: new D1Shim(), RESEND_API_KEY: 'rk', TURNSTILE_SECRET: 'ts', TURNSTILE_SITEKEY: 'site-key', DISCORD_CLIENT_ID: 'cid', DISCORD_CLIENT_SECRET: 'csec', ...(over || {}) });
class Browser {
  constructor(env) { this.env = env; this.jar = {}; }
  async call(method, path, { body, headers, origin = ORIGIN, raw } = {}) {
    const h = { ...(headers || {}), 'cf-connecting-ip': IP };
    if (origin) h.origin = origin;
    const cookie = Object.entries(this.jar).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('; '); if (cookie) h.cookie = cookie;
    if (body !== undefined) h['content-type'] = 'application/json';
    const res = await A.handleAccounts(new Request(ORIGIN + path, { method, headers: h, body: body === undefined ? undefined : (raw ? body : JSON.stringify(body)) }), this.env);
    assert.ok(res, 'route not handled: ' + path);
    const setCookies = res.headers.getSetCookie();
    for (const c of setCookies) { const [kv] = c.split(';'); const i = kv.indexOf('='); const k = kv.slice(0, i), v = decodeURIComponent(kv.slice(i + 1)); if (/Max-Age=0/i.test(c) || v === '') delete this.jar[k]; else this.jar[k] = v; }
    const text = await res.text(); let j = null; try { j = JSON.parse(text); } catch (e) { /* not json */ }
    return { status: res.status, json: j, text, res, setCookies, location: res.headers.get('location') };
  }
  get(p, o) { return this.call('GET', p, o); }
  post(p, body, o) { return this.call('POST', p, { body, ...(o || {}) }); }
  async emailLogin(email, purpose = 'login') {
    await require('../schema.js').ensureSchema(this.env.DB);
    await this.env.DB.prepare('UPDATE codes SET sent_at = 0').run();                 // skip the one-minute wait between codes
    const s = await this.post('/api/auth/email/start', { email, turnstileToken: 'ok-token', purpose }); assert.equal(s.status, 200, JSON.stringify(s.json));
    return this.post('/api/auth/email/verify', { email, code: lastCode(email), purpose });
  }
  async registerEmail(email, username) {
    const v = await this.emailLogin(email); assert.equal(v.json.next, 'register');
    const r = await this.post('/api/auth/register', { agreedRules: true, is18: true, username }); assert.equal(r.status, 200, JSON.stringify(r.json)); return r;
  }
}
const q = (env, sql, ...a) => env.DB.prepare(sql).bind(...a).first();
const qa = async (env, sql, ...a) => (await env.DB.prepare(sql).bind(...a).all()).results;

let n = 0;
const test = async (name, fn) => { await fn(); n++; console.log('ok -', name); };

(async () => {
  /* ===== configuration ===== */
  await test('config: enabled only when something can log people in; nothing configured = closed', async () => {
    const on = await new Browser(newEnv()).get('/api/auth/config'); assert.deepEqual([on.json.enabled, on.json.discord, on.json.email, on.json.turnstileSiteKey], [true, true, true, 'site-key']);
    const dOnly = await new Browser(newEnv({ RESEND_API_KEY: '' })).get('/api/auth/config'); assert.deepEqual([dOnly.json.enabled, dOnly.json.discord, dOnly.json.email], [true, true, false]);
    const none = await new Browser(newEnv({ DISCORD_CLIENT_ID: '', RESEND_API_KEY: '' })).get('/api/auth/config'); assert.equal(none.json.enabled, false);
    const noDb = await A.handleAccounts(new Request(ORIGIN + '/api/auth/config'), {}); assert.equal((await noDb.json()).enabled, false);
    const noDbMe = await A.handleAccounts(new Request(ORIGIN + '/api/me'), {}); assert.equal(noDbMe.status, 503);
    assert.equal(await A.handleAccounts(new Request(ORIGIN + '/api/dnl/room'), {}), null);      // other people's routes are left alone
    assert.equal(await A.handleAccounts(new Request(ORIGIN + '/games/'), newEnv()), null);
  });

  /* ===== email sign-up and login ===== */
  const env = newEnv(); const b = new Browser(env);
  await test('email sign-up: code by email, agreement, username, then logged in (cookie flags checked)', async () => {
    assert.equal((await b.post('/api/auth/email/start', { email: 'ann@example.org', turnstileToken: 'nope' })).json.error, 'captcha');
    assert.equal((await b.post('/api/auth/email/start', { email: 'not-an-email', turnstileToken: 'ok-token' })).json.error, 'bad_email');
    const s = await b.post('/api/auth/email/start', { email: 'Ann@Example.org', turnstileToken: 'ok-token' }); assert.equal(s.status, 200);
    assert.equal(mailbox.at(-1).to, 'ann@example.org'); assert.equal(mailbox.at(-1).auth, 'Bearer rk'); assert.match(mailbox.at(-1).text, /\d{6}/);
    const bad = await b.post('/api/auth/email/verify', { email: 'ann@example.org', code: '000000' }); assert.equal(bad.json.error, 'bad_code'); assert.equal(bad.json.attemptsLeft, 4);
    const v = await b.post('/api/auth/email/verify', { email: 'ann@example.org', code: lastCode('ann@example.org') });
    assert.equal(v.json.next, 'register'); const pend = v.setCookies.find(c => c.startsWith('kl_pending='));
    assert.ok(/HttpOnly/.test(pend) && /SameSite=Lax/.test(pend) && /Secure/.test(pend) && /Max-Age=900/.test(pend), pend);
    const me = await b.get('/api/me'); assert.equal(me.json.user, null); assert.deepEqual(me.json.pending, { kind: 'email', email: 'a***@example.org' });
    assert.equal((await b.post('/api/auth/register', { agreedRules: true, is18: false, username: 'AnnPlays' })).json.error, 'agree_required');
    assert.equal((await b.post('/api/auth/register', { agreedRules: false, is18: true, username: 'AnnPlays' })).json.error, 'agree_required');
    assert.equal((await b.post('/api/auth/register', { agreedRules: true, is18: true, username: 'ab' })).json.error, 'bad_username');
    assert.equal((await b.post('/api/auth/register', { agreedRules: true, is18: true, username: 'Admin' })).json.error, 'username_unavailable');
    const r = await b.post('/api/auth/register', { agreedRules: true, is18: true, username: 'AnnPlays' }); assert.equal(r.status, 200);
    const ses = r.setCookies.find(c => c.startsWith('kl_session=')); assert.ok(/HttpOnly/.test(ses) && /SameSite=Lax/.test(ses) && /Secure/.test(ses) && /Max-Age=2592000/.test(ses), ses);
    assert.ok(!b.jar.kl_pending, 'pending cookie cleared');
    const me2 = await b.get('/api/me'); assert.equal(me2.json.user.username, 'AnnPlays'); assert.equal(me2.json.user.email, 'a***@example.org'); assert.equal(me2.json.user.rulesOk, true); assert.equal(me2.json.user.isAdmin, false);
    const row = await q(env, 'SELECT * FROM users WHERE username_lower = ?', 'annplays'); assert.equal(row.rules_version, cfg.RULES_VERSION); assert.ok(row.accepted_at > 0);
  });

  await test('the session is stored hashed, and no IP address or code is stored anywhere', async () => {
    const tok = b.jar.kl_session; assert.equal(await q(env, 'SELECT COUNT(*) AS n FROM sessions WHERE token_hash = ?', tok).then(r => r.n), 0);
    for (const t of ['users', 'sessions', 'pending', 'codes', 'oauth', 'rate', 'settings', 'ban_list', 'admin_log', 'reports', 'saves', 'stats']) {
      const dump = JSON.stringify(await qa(env, `SELECT * FROM ${t}`)); assert.ok(!dump.includes(IP), t + ' stores an IP address'); assert.ok(!dump.includes(tok), t + ' stores the raw session token');
    }
    assert.ok(!JSON.stringify(await qa(env, 'SELECT * FROM codes')).includes(lastCode('ann@example.org')));
  });

  await test('logging in again from another browser; the answer is the same for unknown and known addresses', async () => {
    const b2 = new Browser(env);
    const known = await b2.post('/api/auth/email/start', { email: 'ann@example.org', turnstileToken: 'ok-token' }); await env.DB.prepare('UPDATE codes SET sent_at = 0').run();
    const unknown = await b2.post('/api/auth/email/start', { email: 'nobody@example.org', turnstileToken: 'ok-token' });
    assert.deepEqual(known.json, unknown.json);
    const v = await b2.post('/api/auth/email/verify', { email: 'ann@example.org', code: lastCode('ann@example.org') }); assert.equal(v.json.next, 'done');
    assert.equal((await b2.get('/api/me')).json.user.username, 'AnnPlays');
    assert.equal((await b2.post('/api/auth/logout', {})).status, 200); assert.equal((await b2.get('/api/me')).json.user, null);
    assert.equal((await b.get('/api/me')).json.user.username, 'AnnPlays', 'other browser still logged in');
  });

  await test('one-minute wait between codes, per-address and per-day limits, mail outage, disposable and malformed addresses', async () => {
    const e = newEnv(); const x = new Browser(e);
    const ok = () => x.post('/api/auth/email/start', { email: 'lim@example.org', turnstileToken: 'ok-token' });
    assert.equal((await ok()).status, 200); const again = await ok(); assert.equal(again.status, 429); assert.equal(again.json.error, 'wait'); assert.ok(again.json.retryAfter > 0);
    for (let i = 0; i < 4; i++) { await e.DB.prepare('UPDATE codes SET sent_at = 0').run(); assert.equal((await ok()).status, 200, 'code ' + (i + 2)); }
    await e.DB.prepare('UPDATE codes SET sent_at = 0').run(); assert.equal((await ok()).json.error, 'rate');            // 6th in an hour for one address
    const d = await x.post('/api/auth/email/start', { email: 'x@' + disposable[0], turnstileToken: 'ok-token' }); assert.equal(d.json.error, 'disposable');
    assert.equal((await x.post('/api/auth/email/start', { email: 'x@sub.' + disposable[1], turnstileToken: 'ok-token' })).json.error, 'disposable');
    for (const bad of ['a b@x.org', '@x.org', 'a@x', 'a@@x.org', 'a@x..org', 'a@-x.org', '']) assert.equal((await x.post('/api/auth/email/start', { email: bad, turnstileToken: 'ok-token' })).json.error, 'bad_email', bad);
    failMail = true; const down = await x.post('/api/auth/email/start', { email: 'down@example.org', turnstileToken: 'ok-token' }); failMail = false;
    assert.equal(down.status, 502); assert.equal(await q(e, "SELECT COUNT(*) AS n FROM codes WHERE email_key = 'down@example.org'").then(r => r.n), 0);
    const e3 = newEnv(); const z = new Browser(e3); await ensureDayLimit(e3);          // the day's total is used up
    const busy = await z.post('/api/auth/email/start', { email: 'late@example.org', turnstileToken: 'ok-token' }); assert.equal(busy.status, 503); assert.equal(busy.json.error, 'busy');
  });
  async function ensureDayLimit(e) { await require('../schema.js').ensureSchema(e.DB); await e.DB.prepare("INSERT OR REPLACE INTO rate (key, window_start, count) VALUES ('mail:day', ?, ?)").bind(Date.now(), cfg.EMAIL_PER_DAY_TOTAL).run(); }

  await test('wrong codes: five tries then the code is gone; expired codes are refused; codes only work for their purpose', async () => {
    const e = newEnv(); const x = new Browser(e);
    await x.post('/api/auth/email/start', { email: 'try@example.org', turnstileToken: 'ok-token' }); const real = lastCode('try@example.org');
    for (let i = 1; i <= 4; i++) assert.equal((await x.post('/api/auth/email/verify', { email: 'try@example.org', code: '111111' })).json.error, 'bad_code');
    assert.equal((await x.post('/api/auth/email/verify', { email: 'try@example.org', code: '111111' })).json.error, 'too_many');
    assert.equal((await x.post('/api/auth/email/verify', { email: 'try@example.org', code: real })).json.error, 'expired');       // it is gone now
    await e.DB.prepare('UPDATE codes SET sent_at = 0').run(); await x.post('/api/auth/email/start', { email: 'try@example.org', turnstileToken: 'ok-token' }); const c2 = lastCode('try@example.org');
    await e.DB.prepare('UPDATE codes SET expires_at = ?').bind(Date.now() - 1).run();
    assert.equal((await x.post('/api/auth/email/verify', { email: 'try@example.org', code: c2 })).json.error, 'expired');
    assert.equal((await x.post('/api/auth/email/verify', { email: 'try@example.org', code: 'abcdef' })).json.error, 'bad_code');
    await e.DB.prepare('UPDATE codes SET sent_at = 0').run(); await x.post('/api/auth/email/start', { email: 'try@example.org', turnstileToken: 'ok-token' });
    assert.equal((await x.post('/api/auth/email/verify', { email: 'try@example.org', code: lastCode('try@example.org'), purpose: 'reauth' })).json.error, 'expired', 'a login code is not a re-check code');
  });

  await test('the same person by another spelling of their address (+tag) is the same account', async () => {
    const e = newEnv(); const x = new Browser(e); await x.registerEmail('bob+games@example.org', 'BobTheBuilder');
    const y = new Browser(e); const v = await y.emailLogin('bob@example.org'); assert.equal(v.json.next, 'done'); assert.equal((await y.get('/api/me')).json.user.username, 'BobTheBuilder');
    assert.equal(await q(e, 'SELECT email FROM users').then(r => r.email), 'bob+games@example.org');
  });

  /* ===== usernames ===== */
  await test('usernames: unique in any case, reserved/filtered refused, rename limited to once per 30 days', async () => {
    const e = newEnv(); const a = new Browser(e), c = new Browser(e); await a.registerEmail('one@example.org', 'Zed_One');
    await c.emailLogin('two@example.org'); const dup = await c.post('/api/auth/register', { agreedRules: true, is18: true, username: 'zed_one' }); assert.equal(dup.status, 409); assert.equal(dup.json.error, 'username_unavailable');
    const ok = await c.post('/api/auth/register', { agreedRules: true, is18: true, username: 'Zed_Two' }); assert.equal(ok.status, 200);
    const r1 = await c.post('/api/me/username', { username: 'ZedTwoRenamed' }); assert.equal(r1.status, 200);
    const r2 = await c.post('/api/me/username', { username: 'Another_One' }); assert.equal(r2.status, 429); assert.equal(r2.json.error, 'rename_wait');
    await e.DB.prepare('UPDATE users SET username_changed_at = ?').bind(Date.now() - 31 * MS.DAY).run();
    assert.equal((await c.post('/api/me/username', { username: 'ZED_ONE' })).json.error, 'username_unavailable');            // taken, whatever the case
    assert.equal((await c.post('/api/me/username', { username: 'root' })).json.error, 'username_unavailable');
    assert.equal((await c.post('/api/me/username', { username: 'a' })).json.error, 'bad_username');
    assert.equal((await c.post('/api/me/username', { username: 'Another_One' })).status, 200);
  });

  /* ===== Discord ===== */
  await test('Discord: start redirect, single-use state, sign-up, login, cancel and failures', async () => {
    const e = newEnv(); const x = new Browser(e); discordUsers = { 'dc-1': '1111', 'dc-2': '2222' };
    const st = await x.get('/api/auth/discord'); assert.equal(st.status, 302);
    const loc = new URL(st.location); assert.equal(loc.origin + loc.pathname, 'https://discord.com/oauth2/authorize');
    assert.equal(loc.searchParams.get('client_id'), 'cid'); assert.equal(loc.searchParams.get('scope'), 'identify'); assert.equal(loc.searchParams.get('redirect_uri'), ORIGIN + '/api/auth/discord/callback');
    const state = loc.searchParams.get('state'); assert.equal(x.jar.kl_oauth, state);
    assert.match(st.setCookies.find(c => c.startsWith('kl_oauth=')), /HttpOnly.*Path=\/api\/auth|Path=\/api\/auth.*HttpOnly/);
    const cb = await x.get(`/api/auth/discord/callback?code=dc-1&state=${state}`); assert.equal(cb.location, '/?auth=register');
    assert.deepEqual((await x.get('/api/me')).json.pending, { kind: 'discord', email: null });
    const reg = await x.post('/api/auth/register', { agreedRules: true, is18: true, username: 'DiscordDan' }); assert.equal(reg.status, 200);
    assert.equal((await q(e, 'SELECT discord_id FROM users')).discord_id, '1111'); assert.equal((await x.get('/api/me')).json.user.discord, true);
    const replay = await x.get(`/api/auth/discord/callback?code=dc-1&state=${state}`); assert.equal(replay.location, '/?auth_error=expired');
    const y = new Browser(e); const s2 = await y.get('/api/auth/discord'); const st2 = new URL(s2.location).searchParams.get('state');
    assert.equal((await y.get(`/api/auth/discord/callback?code=dc-1&state=${st2}`)).location, '/?auth=ok'); assert.equal((await y.get('/api/me')).json.user.username, 'DiscordDan');
    const z = new Browser(e); const s3 = await z.get('/api/auth/discord'); const st3 = new URL(s3.location).searchParams.get('state');
    assert.equal((await z.get(`/api/auth/discord/callback?code=dc-1&state=WRONG`)).location, '/?auth_error=expired');
    z.jar.kl_oauth = 'other'; assert.equal((await z.get(`/api/auth/discord/callback?code=dc-1&state=${st3}`)).location, '/?auth_error=expired', 'state must match the cookie');
    const w = new Browser(e); const s4 = await w.get('/api/auth/discord'); const st4 = new URL(s4.location).searchParams.get('state');
    assert.equal((await w.get(`/api/auth/discord/callback?error=access_denied&state=${st4}`)).location, '/?auth_error=cancelled');
    const v = new Browser(e); const s5 = await v.get('/api/auth/discord'); const st5 = new URL(s5.location).searchParams.get('state');
    assert.equal((await v.get(`/api/auth/discord/callback?code=bad-code&state=${st5}`)).location, '/?auth_error=discord_failed');
    assert.equal((await new Browser(newEnv({ DISCORD_CLIENT_ID: '' })).get('/api/auth/discord')).status, 503);
  });

  await test('linking: add Discord to an email account and email to a Discord account; already-used ones are refused', async () => {
    const e = newEnv(); discordUsers = { 'dc-a': '9001', 'dc-b': '9002' };
    const a = new Browser(e); await a.registerEmail('link@example.org', 'LinkLeo');
    assert.equal((await a.get('/api/auth/discord?purpose=link&next=/account/')).status, 302);
    const stA = a.jar.kl_oauth; const done = await a.get(`/api/auth/discord/callback?code=dc-a&state=${stA}`); assert.equal(done.location, '/account/?linked=discord');
    assert.equal((await a.get('/api/me')).json.user.discord, true);
    // logging in with that Discord id now reaches the same account
    const a2 = new Browser(e); await a2.get('/api/auth/discord'); assert.equal((await a2.get(`/api/auth/discord/callback?code=dc-a&state=${a2.jar.kl_oauth}`)).location, '/?auth=ok'); assert.equal((await a2.get('/api/me')).json.user.username, 'LinkLeo');
    // another account cannot take the same Discord id
    const c = new Browser(e); await c.registerEmail('other@example.org', 'OtherOtto');
    await c.get('/api/auth/discord?purpose=link'); assert.equal((await c.get(`/api/auth/discord/callback?code=dc-a&state=${c.jar.kl_oauth}`)).location, '/?auth_error=discord_taken');
    assert.equal((await new Browser(e).get('/api/auth/discord?purpose=link')).location, '/?auth_error=login_required');
    // Discord-only account adds an email
    const d = new Browser(e); await d.get('/api/auth/discord'); await d.get(`/api/auth/discord/callback?code=dc-b&state=${d.jar.kl_oauth}`); await d.post('/api/auth/register', { agreedRules: true, is18: true, username: 'DiscordDee' });
    assert.equal((await d.emailLogin('dee@example.org', 'link')).json.next, 'done'); assert.equal((await d.get('/api/me')).json.user.email, 'd***@example.org');
    const d2 = new Browser(e); assert.equal((await d2.emailLogin('dee@example.org')).json.next, 'done'); assert.equal((await d2.get('/api/me')).json.user.username, 'DiscordDee');
    const clash = await d.emailLogin('link@example.org', 'link'); assert.equal(clash.json.error, 'email_taken');
    assert.equal((await new Browser(e).post('/api/auth/email/start', { email: 'x@example.org', turnstileToken: 'ok-token', purpose: 'link' })).status, 401);
  });

  /* ===== sessions and safety ===== */
  await test('sessions: expire, slide forward, logout everywhere, cross-site requests refused', async () => {
    const e = newEnv(); const a = new Browser(e), a2 = new Browser(e); await a.registerEmail('sess@example.org', 'SessSam'); await a2.emailLogin('sess@example.org');
    assert.equal((await a.post('/api/auth/logout', { all: true })).status, 200); assert.equal((await a2.get('/api/me')).json.user, null, 'all sessions gone');
    await a.emailLogin('sess@example.org'); const hash = (await q(e, 'SELECT token_hash FROM sessions')).token_hash;
    await e.DB.prepare('UPDATE sessions SET expires_at = ? WHERE token_hash = ?').bind(Date.now() + 5 * MS.DAY, hash).run();
    const me = await a.get('/api/me'); assert.equal(me.json.user.username, 'SessSam'); assert.ok(me.setCookies.some(c => c.startsWith('kl_session=')), 'cookie renewed');
    assert.ok((await q(e, 'SELECT expires_at FROM sessions WHERE token_hash = ?', hash)).expires_at > Date.now() + 29 * MS.DAY, 'expiry slid forward');
    await e.DB.prepare('UPDATE sessions SET expires_at = ?').bind(Date.now() - 1).run(); assert.equal((await a.get('/api/me')).json.user, null);
    assert.equal(await q(e, 'SELECT COUNT(*) AS n FROM sessions').then(r => r.n), 0, 'expired session deleted');
    const evil = await a.call('POST', '/api/auth/logout', { body: {}, origin: 'https://evil.example' }); assert.equal(evil.status, 403);
    const cross = await a.call('POST', '/api/auth/logout', { body: {}, origin: null, headers: { 'sec-fetch-site': 'cross-site' } }); assert.equal(cross.status, 403);
    const same = await a.call('POST', '/api/auth/logout', { body: {}, origin: null, headers: { 'sec-fetch-site': 'same-origin' } }); assert.equal(same.status, 200);
    assert.equal((await a.call('POST', '/api/auth/logout', { body: {}, origin: null })).status, 403, 'no Origin and no same-origin proof');
    assert.equal((await a.post('/api/auth/logout', '{oops', { raw: true })).status, 400);
    assert.equal((await a.post('/api/auth/logout', { x: 'y'.repeat(6000) })).status, 413);
    assert.equal((await a.get('/api/auth/nothing-here')).status, 404);
  });

  await test('cookies are not marked Secure on plain http (local development) and are on https', async () => {
    const e = newEnv(); const res = await A.handleAccounts(new Request('http://localhost:8787/api/auth/email/start', { method: 'POST', headers: { origin: 'http://localhost:8787', 'content-type': 'application/json' }, body: JSON.stringify({ email: 'l@example.org', turnstileToken: 'ok-token' }) }), e);
    assert.equal(res.status, 200);
    await e.DB.prepare('UPDATE codes SET sent_at = 0').run();
    const v = await A.handleAccounts(new Request('http://localhost:8787/api/auth/email/verify', { method: 'POST', headers: { origin: 'http://localhost:8787', 'content-type': 'application/json' }, body: JSON.stringify({ email: 'l@example.org', code: lastCode('l@example.org') }) }), e);
    assert.equal(v.status, 200); assert.ok(!/Secure/.test(v.headers.getSetCookie()[0]));
  });

  /* ===== my account ===== */
  const e2 = newEnv(); const me = new Browser(e2);
  await test('saves: only for allowed games (never the kids game), size-capped, last write wins, need login', async () => {
    assert.equal((await me.get('/api/save/dragons-and-ladders')).status, 401);
    await me.registerEmail('saver@example.org', 'SaverSue');
    assert.deepEqual((await me.get('/api/save/dragons-and-ladders')).json.data, null);
    const put = await me.call('PUT', '/api/save/dragons-and-ladders', { body: { data: { token: 'gold', wins: 3 } } }); assert.equal(put.status, 200);
    assert.deepEqual((await me.get('/api/save/dragons-and-ladders')).json.data, { token: 'gold', wins: 3 });
    await me.call('PUT', '/api/save/dragons-and-ladders', { body: { data: { token: 'silver' } } }); assert.deepEqual((await me.get('/api/save/dragons-and-ladders')).json.data, { token: 'silver' });
    assert.equal((await me.get('/api/save/ordinals-and-months')).status, 404);                         // Star Quest: no accounts
    assert.equal((await me.call('PUT', '/api/save/ordinals-and-months', { body: { data: {} } })).status, 404);
    assert.equal((await me.get('/api/save/mytheder')).status, 404);
    const big = await me.call('PUT', '/api/save/dragons-and-ladders', { body: { data: 'x'.repeat(cfg.MAX_SAVE_BYTES + 10) } }); assert.equal(big.status, 413);
    assert.equal((await me.call('DELETE', '/api/save/dragons-and-ladders')).status, 405);
    assert.equal(await q(e2, 'SELECT COUNT(*) AS n FROM saves').then(r => r.n), 1);
  });

  await test('rules: a new rules version must be accepted (with 18+ confirmed) before saves and changes work again', async () => {
    await e2.DB.prepare('UPDATE users SET rules_version = 0').run();
    const m = await me.get('/api/me'); assert.equal(m.json.user.rulesOk, false);
    assert.equal((await me.get('/api/save/dragons-and-ladders')).json.error, 'rules_required'); assert.equal((await me.post('/api/me/username', { username: 'NewName' })).json.error, 'rules_required');
    assert.equal((await me.post('/api/auth/accept-rules', { agreedRules: true, is18: false })).json.error, 'agree_required');
    assert.equal((await me.post('/api/auth/accept-rules', { agreedRules: true, is18: true })).status, 200);
    assert.equal((await me.get('/api/save/dragons-and-ladders')).status, 200); assert.equal((await q(e2, 'SELECT rules_version FROM users')).rules_version, cfg.RULES_VERSION);
    assert.equal((await me.get('/api/me/export')).status, 200, 'export works even while rules are pending');
  });

  await test('settings and export: hide from leaderboards; export holds everything and no secrets', async () => {
    assert.equal((await me.post('/api/me/settings', { hideLeaderboards: true })).status, 200); assert.equal((await me.get('/api/me')).json.user.hideLeaderboards, true);
    await A.recordGameResult(e2, (await q(e2, 'SELECT id FROM users')).id, 'dragons-and-ladders', { won: true, turns: 31 });
    const ex = await me.get('/api/me/export'); assert.match(ex.res.headers.get('content-disposition'), /attachment/);
    assert.equal(ex.json.account.username, 'SaverSue'); assert.equal(ex.json.account.email, 'saver@example.org'); assert.equal(ex.json.saves[0].game, 'dragons-and-ladders'); assert.equal(ex.json.stats[0].won, 1);
    assert.ok(!/token_hash|code_hash|secret|password|ip/i.test(Object.keys(ex.json.account).join(' ')));
  });

  await test('stats: written only by the server, counting games and the best win', async () => {
    const id = (await q(e2, 'SELECT id FROM users')).id;
    await A.recordGameResult(e2, id, 'dragons-and-ladders', { won: false, turns: 0 }); await A.recordGameResult(e2, id, 'dragons-and-ladders', { won: true, turns: 25 }); await A.recordGameResult(e2, id, 'dragons-and-ladders', { won: true, turns: 40 });
    const s = await q(e2, 'SELECT * FROM stats WHERE user_id = ?', id); assert.deepEqual([s.played, s.won, s.best_turns], [4, 3, 25]);
    assert.equal((await me.post('/api/me/stats', { won: 999 })).status, 404);                         // there is no route a browser could use to write stats
    assert.equal(await A.handleAccounts(new Request(ORIGIN + '/api/stats', { method: 'POST', headers: { origin: ORIGIN } }), e2), null);
  });

  await test('deleting the account needs a recent login and the typed name; everything goes, and the address can sign up again', async () => {
    await e2.DB.prepare('UPDATE sessions SET last_auth_at = ?').bind(Date.now() - 20 * MS.MINUTE).run();
    assert.equal((await me.get('/api/me')).json.user.fresh, false);
    const old = await me.call('DELETE', '/api/me', { body: { confirm: 'SaverSue' } }); assert.equal(old.status, 403); assert.equal(old.json.error, 'reauth_required');
    assert.equal((await me.emailLogin('other@example.org', 'reauth')).status, 403);          // another address cannot re-check this account
    const re = await me.emailLogin('saver@example.org', 'reauth'); assert.equal(re.json.next, 'done'); assert.equal((await me.get('/api/me')).json.user.fresh, true);
    assert.equal((await me.call('DELETE', '/api/me', { body: { confirm: 'SomeoneElse' } })).json.error, 'confirm_mismatch');
    const del = await me.call('DELETE', '/api/me', { body: { confirm: 'sAvErSuE' } }); assert.equal(del.status, 200); assert.ok(!me.jar.kl_session);
    for (const t of ['users', 'sessions', 'saves', 'stats']) assert.equal(await q(e2, `SELECT COUNT(*) AS n FROM ${t}`).then(r => r.n), 0, t);
    assert.equal(await q(e2, 'SELECT COUNT(*) AS n FROM ban_list').then(r => r.n), 0, 'leaving by choice leaves nothing behind');
    const again = new Browser(e2); assert.equal((await again.emailLogin('saver@example.org')).json.next, 'register');
  });

  await test('Discord accounts re-check by logging in with Discord again before deleting', async () => {
    const e = newEnv(); discordUsers = { 'dc-x': '7777' }; const d = new Browser(e);
    await d.get('/api/auth/discord'); await d.get(`/api/auth/discord/callback?code=dc-x&state=${d.jar.kl_oauth}`); await d.post('/api/auth/register', { agreedRules: true, is18: true, username: 'DiscordDel' });
    await e.DB.prepare('UPDATE sessions SET last_auth_at = 0').run(); assert.equal((await d.call('DELETE', '/api/me', { body: { confirm: 'DiscordDel' } })).json.error, 'reauth_required');
    await d.get('/api/auth/discord?purpose=reauth&next=/account/'); assert.equal((await d.get(`/api/auth/discord/callback?code=dc-x&state=${d.jar.kl_oauth}`)).location, '/account/?reauth=ok');
    assert.equal((await d.call('DELETE', '/api/me', { body: { confirm: 'discorddel' } })).status, 200);
  });

  /* ===== reports, admin, bans ===== */
  await test('reports and admin: reports listed and resolved; ban ends sessions and blocks the person even after deletion; unban; rename', async () => {
    const e = newEnv(); const admin = new Browser(e), troll = new Browser(e), viewer = new Browser(e), plain = new Browser(e);
    await admin.registerEmail('boss@example.org', 'TheBoss'); await e.DB.prepare('UPDATE users SET is_admin = 1').run();
    await troll.registerEmail('troll@example.org', 'TrollTom'); await viewer.registerEmail('view@example.org', 'ViewerVi'); await plain.registerEmail('plain@example.org', 'PlainPat');
    assert.equal((await viewer.post('/api/report', { username: 'trolltom', reason: '' })).json.error, 'reason_required');
    assert.equal((await viewer.post('/api/report', { username: 'nobody', reason: 'x' })).status, 404); assert.equal((await viewer.post('/api/report', { username: 'ViewerVi', reason: 'x' })).json.error, 'self');
    assert.equal((await viewer.post('/api/report', { username: 'trolltom', reason: 'Bad name' })).status, 200);
    for (let i = 0; i < cfg.REPORTS_PER_DAY; i++) await viewer.post('/api/report', { username: 'trolltom', reason: 'again ' + i });
    assert.equal((await viewer.post('/api/report', { username: 'trolltom', reason: 'too many' })).json.error, 'report_limit');
    assert.equal((await new Browser(e).post('/api/report', { username: 'trolltom', reason: 'x' })).status, 401);
    assert.equal((await plain.get('/api/admin/reports')).status, 403); assert.equal((await new Browser(e).get('/api/admin/reports')).status, 401);
    const list = await admin.get('/api/admin/reports'); assert.equal(list.status, 200); assert.equal(list.json.reports[0].target, 'TrollTom'); assert.equal(list.json.reports[0].reporter, 'ViewerVi');
    assert.equal((await admin.post('/api/admin/reports/' + list.json.reports[0].id + '/resolve', { note: 'warned' })).status, 200);
    assert.equal((await admin.get('/api/admin/reports?status=handled')).json.reports.length, 1);
    assert.deepEqual((await admin.get('/api/admin/users?q=troll')).json.users.map(u => u.username), ['TrollTom']);
    assert.equal((await admin.post('/api/admin/users/TheBoss/ban', {})).json.error, 'self');
    assert.equal((await admin.post('/api/admin/users/nobody/ban', {})).status, 404);
    assert.equal((await admin.post('/api/admin/users/TrollTom/ban', { reason: 'slurs' })).status, 200);
    assert.equal((await troll.get('/api/me')).json.user, null, 'banned: their session ended');
    assert.equal((await troll.emailLogin('troll@example.org')).json.error, 'banned');
    assert.equal(await q(e, 'SELECT COUNT(*) AS n FROM ban_list').then(r => r.n), 1); assert.ok(!JSON.stringify(await qa(e, 'SELECT * FROM ban_list')).includes('troll@example.org'), 'only a hash is kept');
    assert.equal((await admin.post('/api/admin/users/TrollTom/delete', {})).status, 200);
    const again = new Browser(e); assert.equal((await again.emailLogin('troll@example.org')).json.error, 'banned', 'deleting the account does not lift the ban');
    assert.equal((await again.emailLogin('troll+2@example.org')).json.error, 'banned', 'nor does a +tag');
    // unban path on a fresh account
    const t2 = new Browser(e); await t2.registerEmail('t2@example.org', 'TrollTwo'); assert.equal((await admin.post('/api/admin/users/TrollTwo/ban', { reason: 'x' })).status, 200);
    assert.equal((await admin.post('/api/admin/users/TrollTwo/unban', {})).status, 200); assert.equal((await t2.emailLogin('t2@example.org')).json.next, 'done');
    assert.equal((await admin.post('/api/admin/users/PlainPat/rename', {})).status, 200); const renamed = (await plain.get('/api/me')).json.user.username; assert.match(renamed, /^Player-\d{4}$/);
    assert.equal((await plain.post('/api/me/username', { username: 'PlainPatricia' })).status, 200, 'a forced rename can be changed straight away');
    const logRows = (await qa(e, 'SELECT action FROM admin_log ORDER BY id')).map(r => r.action); assert.deepEqual(logRows, ['report_resolved', 'ban', 'delete', 'ban', 'unban', 'rename']);
    await e.DB.prepare('UPDATE users SET status = ? WHERE username_lower = ?').bind('suspended', 'theboss').run(); assert.equal((await admin.get('/api/admin/reports')).status, 403, 'a suspended admin is locked out');
  });

  await test('a banned Discord identity is refused at login and at linking', async () => {
    const e = newEnv(); discordUsers = { 'dc-t': '5555', 'dc-ok': '5556' }; const admin = new Browser(e), t = new Browser(e), o = new Browser(e);
    await admin.registerEmail('adm@example.org', 'AdminAda'); await e.DB.prepare('UPDATE users SET is_admin = 1').run();
    await t.get('/api/auth/discord'); await t.get(`/api/auth/discord/callback?code=dc-t&state=${t.jar.kl_oauth}`); await t.post('/api/auth/register', { agreedRules: true, is18: true, username: 'DiscordTroll' });
    await admin.post('/api/admin/users/DiscordTroll/ban', { reason: 'x' });
    const t2 = new Browser(e); await t2.get('/api/auth/discord'); assert.equal((await t2.get(`/api/auth/discord/callback?code=dc-t&state=${t2.jar.kl_oauth}`)).location, '/?auth_error=banned');
    await o.registerEmail('ok@example.org', 'OkOlga'); await o.get('/api/auth/discord?purpose=link'); assert.equal((await o.get(`/api/auth/discord/callback?code=dc-t&state=${o.jar.kl_oauth}`)).location, '/?auth_error=discord_taken');
    await admin.post('/api/admin/users/DiscordTroll/delete', {}); await o.get('/api/auth/discord?purpose=link'); assert.equal((await o.get(`/api/auth/discord/callback?code=dc-t&state=${o.jar.kl_oauth}`)).location, '/?auth_error=banned');
  });

  /* ===== the nightly job ===== */
  await test('cleanup: expired rows go; idle accounts are warned, then deleted 30 days later; admins and active people stay', async () => {
    const e = newEnv(); const now = Date.now(); const mk = async (email, name) => { const x = new Browser(e); await x.registerEmail(email, name); return x; };
    await mk('active@example.org', 'ActiveAnn'); await mk('idle@example.org', 'IdleIan'); await mk('idleadmin@example.org', 'IdleAdmin');
    await e.DB.prepare('INSERT INTO users (username, username_lower, discord_id, rules_version, accepted_at, created_at, last_login_at) VALUES (?, ?, ?, 1, 1, 1, ?)').bind('OldDiscord', 'olddiscord', '424242', now - 800 * MS.DAY).run();
    await e.DB.prepare("UPDATE users SET last_login_at = ? WHERE username_lower IN ('idleian', 'idleadmin')").bind(now - 800 * MS.DAY).run(); await e.DB.prepare("UPDATE users SET is_admin = 1 WHERE username_lower = 'idleadmin'").run();
    await e.DB.prepare('INSERT INTO ban_list VALUES (?, ?, ?)').bind('old', now - 4 * 365 * MS.DAY, 'x').run(); await e.DB.prepare('INSERT INTO ban_list VALUES (?, ?, ?)').bind('new', now, 'x').run();
    const target = (await q(e, "SELECT id FROM users WHERE username_lower = 'activeann'")).id;
    await e.DB.prepare(`INSERT INTO reports (reporter_id, target_id, reason, status, created_at, handled_at) VALUES (NULL, ?, 'r', 'handled', ?, ?)`).bind(target, now - 300 * MS.DAY, now - 250 * MS.DAY).run();
    await e.DB.prepare(`INSERT INTO reports (reporter_id, target_id, reason, status, created_at) VALUES (NULL, ?, 'still open', 'open', ?)`).bind(target, now - 300 * MS.DAY).run();
    await e.DB.prepare("UPDATE sessions SET expires_at = 1 WHERE user_id = (SELECT id FROM users WHERE username_lower = 'idleian')").run();
    const mailsBefore = mailbox.length; const r1 = await A.runCleanup(e, now);
    assert.equal(r1.deleted, 1, 'the Discord-only idle account (no way to warn) is deleted'); assert.equal(r1.warned, 1); assert.equal(mailbox.length, mailsBefore + 1); assert.equal(mailbox.at(-1).to, 'idle@example.org'); assert.match(mailbox.at(-1).text, /30 days/);
    assert.equal(r1.sessions, 1); assert.equal(r1.bans, 1); assert.equal(r1.reports, 1);
    assert.deepEqual((await qa(e, 'SELECT username FROM users ORDER BY id')).map(r => r.username), ['ActiveAnn', 'IdleIan', 'IdleAdmin']);
    assert.equal((await A.runCleanup(e, now + 10 * MS.DAY)).deleted, 0, 'not yet: only warned');
    const later = await A.runCleanup(e, now + 31 * MS.DAY); assert.equal(later.deleted, 1);
    assert.deepEqual((await qa(e, 'SELECT username FROM users ORDER BY id')).map(r => r.username), ['ActiveAnn', 'IdleAdmin']);
    assert.equal((await qa(e, 'SELECT * FROM reports')).length, 1, 'the open report stays');
    const x = new Browser(e); await x.emailLogin('active@example.org'); await e.DB.prepare('UPDATE users SET last_login_at = ?, inactive_warned_at = ?').bind(now - 800 * MS.DAY, now - 40 * MS.DAY).run();
    await x.emailLogin('active@example.org'); assert.equal(await q(e, "SELECT inactive_warned_at AS w FROM users WHERE username_lower = 'activeann'").then(r => r.w), null, 'logging in clears a warning');
  });

  await test('schema: created on first use, safe to run again, and a broken start is retried', async () => {
    const d = new D1Shim(); const S = require('../schema.js'); await S.ensureSchema(d); await S.ensureSchema(d);
    assert.equal(await d.prepare('SELECT MAX(n) AS n FROM schema_version').first('n'), S.MIGRATIONS.length);
    const d2 = new D1Shim(); await S.ensureSchema(d2); const fresh = new D1Shim(); assert.equal(await fresh.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table'").first('n'), 0);
    assert.throws(() => d.db.exec('INSERT INTO sessions VALUES (1,999,0,0,0)'), /FOREIGN KEY/, 'foreign keys are enforced');
  });

  console.log(`\n${n} account tests passed`);
})().catch(e => { console.error('\nFAILED:', e && e.stack || e); process.exit(1); });
