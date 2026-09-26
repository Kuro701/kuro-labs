'use strict';
/* kurolabs.net accounts: every /api/auth, /api/me, /api/save, /api/report and /api/admin route, plus the nightly cleanup.
 *
 *   handleAccounts(request, env)  -> a Response, or null when the path is not ours
 *   runCleanup(env, now)          -> what the nightly job did
 *   recordGameResult(env, userId, game, {won, turns})   for the game servers to call (stats only the server may write)
 *
 * Needs (Cloudflare bindings / secrets; see site/accounts/README.md):
 *   DB                       a D1 database (tables are created automatically)
 *   DISCORD_CLIENT_ID, DISCORD_CLIENT_SECRET      Discord login (optional)
 *   RESEND_API_KEY, TURNSTILE_SECRET, TURNSTILE_SITEKEY   email login (optional; all three needed)
 *   MAIL_FROM (optional)     default "Kuro Labs <login@kurolabs.net>"
 *   APP_SECRET (optional)    otherwise one is generated and kept in the database
 * Nothing here logs personal data, and nothing here stores passwords, birth dates or IP addresses.
 */
const cfg = require('./config.js');
const { ensureSchema } = require('./schema.js');
const C = require('./crypto.js');
const U = require('./usernames.js');
const DISPOSABLE = new Set(require('./data/disposable.json').domains);
const MS = cfg.MS;

class HttpError extends Error {
  constructor(status, code, message, extra) { super(message || code); this.status = status; this.code = code; this.extra = extra || {}; }
}
const fail = (status, code, message, extra) => new HttpError(status, code, message, extra);

/* ---------- responses and cookies ---------- */
function makeResponse(ctx, body, status, extraHeaders) {
  const h = new Headers({ 'cache-control': 'no-store', ...(extraHeaders || {}) });
  for (const c of ctx.setCookies) h.append('set-cookie', c);
  return new Response(body, { status, headers: h });
}
const reply = (ctx, obj, status = 200, extraHeaders) => makeResponse(ctx, JSON.stringify(obj), status, { 'content-type': 'application/json; charset=utf-8', ...(extraHeaders || {}) });
function redirect(ctx, location) { return makeResponse(ctx, null, 302, { location }); }

function parseCookies(request) {
  const out = {}, raw = request.headers.get('cookie') || '';
  for (const part of raw.split(';')) { const i = part.indexOf('='); if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim()); }
  return out;
}
function setCookie(ctx, name, value, maxAgeSeconds, path) {
  ctx.setCookies.push(`${name}=${encodeURIComponent(value)}; Path=${path || '/'}; Max-Age=${maxAgeSeconds}; HttpOnly; SameSite=Lax${ctx.secure ? '; Secure' : ''}`);
}
const clearCookie = (ctx, name, path) => setCookie(ctx, name, '', 0, path);

async function readJson(request, maxBytes = 4096) {
  const text = await request.text();
  if (text.length > maxBytes) throw fail(413, 'too_big', 'That is too much data.');
  if (!text.trim()) return {};
  try { const v = JSON.parse(text); return v && typeof v === 'object' ? v : {}; } catch (e) { throw fail(400, 'bad_json', 'Could not read that.'); }
}

/* ---------- request context ---------- */
const secretCache = new WeakMap();
async function getSecret(env) {
  if (env.APP_SECRET && String(env.APP_SECRET).length >= 16) return String(env.APP_SECRET);
  if (secretCache.has(env.DB)) return secretCache.get(env.DB);
  const p = (async () => {
    await env.DB.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)').bind('app_secret', C.randomToken(32)).run();
    return env.DB.prepare('SELECT value FROM settings WHERE key = ?').bind('app_secret').first('value');
  })();
  secretCache.set(env.DB, p); p.catch(() => secretCache.delete(env.DB));
  return p;
}
async function makeCtx(request, env) {
  await ensureSchema(env.DB);
  const url = new URL(request.url);
  return { request, env, db: env.DB, url, now: Date.now(), secure: url.protocol === 'https:', cookies: parseCookies(request), setCookies: [],
    secret: await getSecret(env), ip: request.headers.get('cf-connecting-ip') || '' };
}

// Only pages from this same site may change anything (SameSite cookies are the first defence, this is the second).
function requireSameOrigin(ctx) {
  const m = ctx.request.method;
  if (m === 'GET' || m === 'HEAD') return;
  const origin = ctx.request.headers.get('origin');
  if (origin) { let ok = false; try { ok = new URL(origin).origin === ctx.url.origin; } catch (e) { ok = false; } if (!ok) throw fail(403, 'forbidden', 'Not allowed.'); return; }
  const site = ctx.request.headers.get('sec-fetch-site');
  if (site !== 'same-origin' && site !== 'none') throw fail(403, 'forbidden', 'Not allowed.');
}

/* ---------- small helpers ---------- */
const hashIdent = (ctx, label, value) => C.hmacHex(ctx.secret, label + ':' + value);
const sha = C.sha256Hex;

function normalizeEmail(raw) {
  const e = String(raw == null ? '' : raw).trim().toLowerCase();
  if (!e || e.length > 254 || /\s/.test(e)) return null;
  const m = /^([^@]+)@([^@]+)$/.exec(e); if (!m) return null;
  const local = m[1], domain = m[2];
  if (local.length > 64 || !/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+$/.test(local)) return null;
  if (!/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?\.[a-z]{2,}$/.test(domain) || domain.indexOf('..') >= 0) return null;
  const base = local.split('+')[0]; if (!base) return null;
  return { email: e, key: base + '@' + domain, domain };
}
function isDisposable(domain) {
  const parts = domain.split('.');
  for (let i = 0; i < parts.length - 1; i++) if (DISPOSABLE.has(parts.slice(i).join('.'))) return true;
  return false;
}
const maskEmail = e => { const [l, d] = String(e).split('@'); return (l[0] || '') + '***@' + d; };

async function rateHit(ctx, key, limit, windowMs) {
  const start = ctx.now;
  const row = await ctx.db.prepare(
    `INSERT INTO rate (key, window_start, count) VALUES (?, ?, 1)
     ON CONFLICT(key) DO UPDATE SET count = CASE WHEN window_start < ? THEN 1 ELSE count + 1 END, window_start = CASE WHEN window_start < ? THEN ? ELSE window_start END
     RETURNING count`).bind(key, start, start - windowMs, start - windowMs, start).first();
  return row.count <= limit;
}

function accountsConfig(env) {
  const discord = !!(env.DISCORD_CLIENT_ID && env.DISCORD_CLIENT_SECRET);
  const email = !!(env.RESEND_API_KEY && env.TURNSTILE_SECRET && env.TURNSTILE_SITEKEY);
  return { enabled: !!env.DB && (discord || email), discord, email, turnstileSiteKey: email ? String(env.TURNSTILE_SITEKEY) : null, rulesVersion: cfg.RULES_VERSION };
}

/* ---------- sessions ---------- */
async function createSession(ctx, userId) {
  const token = C.randomToken(32), hash = await sha(token);
  await ctx.db.batch([
    ctx.db.prepare('INSERT INTO sessions (token_hash, user_id, created_at, expires_at, last_auth_at) VALUES (?, ?, ?, ?, ?)').bind(hash, userId, ctx.now, ctx.now + cfg.SESSION_DAYS * MS.DAY, ctx.now),
    ctx.db.prepare('UPDATE users SET last_login_at = ?, inactive_warned_at = NULL WHERE id = ?').bind(ctx.now, userId)
  ]);
  setCookie(ctx, 'kl_session', token, cfg.SESSION_DAYS * 86400);
}

async function getSession(ctx) {
  if (ctx.session !== undefined) return ctx.session;
  ctx.session = null;
  const token = ctx.cookies.kl_session; if (!token) return null;
  const hash = await sha(token);
  const row = await ctx.db.prepare(
    `SELECT s.token_hash, s.expires_at AS s_expires, s.last_auth_at, u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?`).bind(hash).first();
  if (!row) return null;
  if (row.s_expires < ctx.now) { await ctx.db.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(hash).run(); return null; }
  if (row.status === 'banned') { await ctx.db.prepare('DELETE FROM sessions WHERE user_id = ?').bind(row.id).run(); return null; }
  if (row.s_expires - ctx.now < (cfg.SESSION_DAYS - 1) * MS.DAY) {           // slide the expiry forward at most once a day
    await ctx.db.prepare('UPDATE sessions SET expires_at = ? WHERE token_hash = ?').bind(ctx.now + cfg.SESSION_DAYS * MS.DAY, hash).run();
    setCookie(ctx, 'kl_session', token, cfg.SESSION_DAYS * 86400);
  }
  ctx.session = { hash, lastAuthAt: row.last_auth_at, user: row };
  return ctx.session;
}
async function requireUser(ctx, { rules = true } = {}) {
  const s = await getSession(ctx);
  if (!s) throw fail(401, 'not_logged_in', 'Please log in.');
  if (rules && s.user.rules_version !== cfg.RULES_VERSION) throw fail(403, 'rules_required', 'Please read and accept the current rules first.');
  return s;
}
async function requireAdmin(ctx) {
  const s = await requireUser(ctx);
  if (!s.user.is_admin || s.user.status !== 'active') throw fail(403, 'forbidden', 'Not allowed.');
  return s;
}

function publicUser(ctx, s) {
  const u = s.user;
  return { username: u.username, discord: !!u.discord_id, email: u.email ? maskEmail(u.email) : null, isAdmin: !!u.is_admin, hideLeaderboards: !!u.hide_lb,
    status: u.status, rulesOk: u.rules_version === cfg.RULES_VERSION, createdAt: u.created_at,
    renameAt: u.username_changed_at + cfg.USERNAME_RENAME_DAYS * MS.DAY, fresh: ctx.now - s.lastAuthAt < cfg.FRESH_LOGIN_MINUTES * MS.MINUTE };
}

/* ---------- pending sign-ups (proved who they are, not yet registered) ---------- */
async function createPending(ctx, kind, ident) {
  const token = C.randomToken(32), hash = await sha(token);
  await ctx.db.prepare('INSERT INTO pending (id_hash, kind, discord_id, email, email_key, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind(hash, kind, ident.discord_id || null, ident.email || null, ident.email_key || null, ctx.now, ctx.now + cfg.PENDING_MINUTES * MS.MINUTE).run();
  setCookie(ctx, 'kl_pending', token, cfg.PENDING_MINUTES * 60);
}
async function getPending(ctx) {
  const token = ctx.cookies.kl_pending; if (!token) return null;
  const hash = await sha(token);
  const row = await ctx.db.prepare('SELECT * FROM pending WHERE id_hash = ?').bind(hash).first();
  if (!row || row.expires_at < ctx.now) return null;
  return row;
}

/* ---------- bans ---------- */
async function identHashes(ctx, ident) {
  const out = [];
  if (ident.discord_id) out.push(await hashIdent(ctx, 'ban:discord', ident.discord_id));
  if (ident.email_key) out.push(await hashIdent(ctx, 'ban:email', ident.email_key));
  return out;
}
async function isBannedIdentity(ctx, ident) {
  for (const h of await identHashes(ctx, ident)) if (await ctx.db.prepare('SELECT 1 AS x FROM ban_list WHERE identifier_hash = ?').bind(h).first()) return true;
  return false;
}
const BANNED = () => fail(403, 'banned', "This account can't be used. If you think that is a mistake, contact " + cfg.CONTACT_EMAIL + '.');

/* Someone proved who they are (Discord or email code). Log them in, or start their registration. */
async function completeLogin(ctx, ident) {
  const col = ident.discord_id ? 'discord_id' : 'email_key', val = ident.discord_id || ident.email_key;
  const user = await ctx.db.prepare(`SELECT * FROM users WHERE ${col} = ?`).bind(val).first();
  if (user) {
    if (user.status === 'banned') throw BANNED();
    await createSession(ctx, user.id);
    return 'done';
  }
  if (await isBannedIdentity(ctx, ident)) throw BANNED();
  await createPending(ctx, ident.discord_id ? 'discord' : 'email', ident);
  return 'register';
}

/* ---------- outside services ---------- */
async function verifyTurnstile(ctx, token) {
  if (!token || typeof token !== 'string' || token.length > 4096) return false;
  const body = new URLSearchParams({ secret: ctx.env.TURNSTILE_SECRET, response: token }); if (ctx.ip) body.set('remoteip', ctx.ip);
  try { const r = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', body }); const j = await r.json(); return !!(j && j.success); } catch (e) { return false; }
}
async function sendMail(env, { to, subject, text, html }) {
  const r = await fetch('https://api.resend.com/emails', { method: 'POST',
    headers: { authorization: 'Bearer ' + env.RESEND_API_KEY, 'content-type': 'application/json' },
    body: JSON.stringify({ from: env.MAIL_FROM || 'Kuro Labs <login@kurolabs.net>', to: [to], subject, text, html }) });
  if (!r.ok) throw new Error('mail ' + r.status);
}
const codeMail = code => ({
  subject: 'Your Kuro Labs login code',
  text: `Your Kuro Labs login code is ${code}\n\nIt works for ${cfg.CODE_MINUTES} minutes. If you did not ask for it, you can ignore this email.`,
  html: `<p>Your Kuro Labs login code is</p><p style="font-size:28px;letter-spacing:6px;font-family:monospace"><b>${code}</b></p><p>It works for ${cfg.CODE_MINUTES} minutes. If you did not ask for it, you can ignore this email.</p>`
});

/* ---------- routes: public ---------- */
async function routeConfig(ctx) { return reply(ctx, { ok: true, ...accountsConfig(ctx.env) }); }

async function routeMe(ctx) {
  const s = await getSession(ctx);
  if (s) return reply(ctx, { ok: true, user: publicUser(ctx, s), pending: null });
  const p = await getPending(ctx);
  return reply(ctx, { ok: true, user: null, pending: p ? { kind: p.kind, email: p.email ? maskEmail(p.email) : null } : null });
}

/* ---- email code: start ---- */
async function routeEmailStart(ctx) {
  const c = accountsConfig(ctx.env); if (!c.email) throw fail(503, 'unavailable', 'Email login is not available right now.');
  const body = await readJson(ctx.request);
  const purpose = ['login', 'reauth', 'link'].includes(body.purpose) ? body.purpose : 'login';
  const em = normalizeEmail(body.email);
  if (!em) throw fail(400, 'bad_email', "That email address doesn't look right.");
  if (isDisposable(em.domain)) throw fail(400, 'disposable', "Please use a different email address (temporary email services aren't accepted).");
  let userId = null;
  if (purpose !== 'login') { const s = await requireUser(ctx, { rules: false }); userId = s.user.id; }
  if (!(await verifyTurnstile(ctx, body.turnstileToken))) throw fail(400, 'captcha', 'Please complete the check and try again.');

  const prev = await ctx.db.prepare('SELECT sent_at FROM codes WHERE email_key = ? AND purpose = ?').bind(em.key, purpose).first();
  if (prev && ctx.now - prev.sent_at < cfg.CODE_RESEND_SECONDS * 1000)          // asking again too soon does not count against the hourly limits
    throw fail(429, 'wait', 'Please wait a minute before asking for another code.', { retryAfter: Math.ceil((cfg.CODE_RESEND_SECONDS * 1000 - (ctx.now - prev.sent_at)) / 1000) });
  const ipKey = await hashIdent(ctx, 'ip', ctx.ip || 'unknown');
  if (!(await rateHit(ctx, 'mail:day', cfg.EMAIL_PER_DAY_TOTAL, MS.DAY))) throw fail(503, 'busy', 'Email login is busy today. Please use Discord, or try again tomorrow.');
  if (!(await rateHit(ctx, 'mail:ip:' + ipKey, cfg.EMAIL_PER_IP_PER_HOUR, MS.HOUR)) || !(await rateHit(ctx, 'mail:addr:' + await hashIdent(ctx, 'mail', em.key), cfg.EMAIL_PER_ADDRESS_PER_HOUR, MS.HOUR)))
    throw fail(429, 'rate', 'Too many codes asked for. Please try again in a while.');

  const code = C.randomDigits(6), codeHash = await hashIdent(ctx, 'code', em.key + ':' + purpose + ':' + code);
  await ctx.db.prepare(`INSERT INTO codes (email_key, purpose, email, code_hash, user_id, expires_at, attempts, sent_at) VALUES (?, ?, ?, ?, ?, ?, 0, ?)
    ON CONFLICT(email_key, purpose) DO UPDATE SET email = excluded.email, code_hash = excluded.code_hash, user_id = excluded.user_id, expires_at = excluded.expires_at, attempts = 0, sent_at = excluded.sent_at`)
    .bind(em.key, purpose, em.email, codeHash, userId, ctx.now + cfg.CODE_MINUTES * MS.MINUTE, ctx.now).run();
  try { await sendMail(ctx.env, { to: em.email, ...codeMail(code) }); }
  catch (e) { await ctx.db.prepare('DELETE FROM codes WHERE email_key = ? AND purpose = ?').bind(em.key, purpose).run(); throw fail(502, 'mail_failed', "We couldn't send the email. Please try again in a moment."); }
  return reply(ctx, { ok: true, expiresInMinutes: cfg.CODE_MINUTES });   // the same answer whether or not an account exists
}

/* ---- email code: verify ---- */
async function routeEmailVerify(ctx) {
  const body = await readJson(ctx.request);
  const purpose = ['login', 'reauth', 'link'].includes(body.purpose) ? body.purpose : 'login';
  const em = normalizeEmail(body.email), code = String(body.code || '').replace(/\s+/g, '');
  if (!em || !/^\d{6}$/.test(code)) throw fail(400, 'bad_code', "That code isn't right.");
  const row = await ctx.db.prepare('SELECT * FROM codes WHERE email_key = ? AND purpose = ?').bind(em.key, purpose).first();
  if (!row) throw fail(400, 'expired', 'That code has expired. Ask for a new one.');
  if (row.expires_at < ctx.now) { await ctx.db.prepare('DELETE FROM codes WHERE email_key = ? AND purpose = ?').bind(em.key, purpose).run(); throw fail(400, 'expired', 'That code has expired. Ask for a new one.'); }
  const attempts = (await ctx.db.prepare('UPDATE codes SET attempts = attempts + 1 WHERE email_key = ? AND purpose = ? RETURNING attempts').bind(em.key, purpose).first()).attempts;
  const good = C.safeEqual(row.code_hash, await hashIdent(ctx, 'code', em.key + ':' + purpose + ':' + code));
  if (!good) {
    if (attempts >= cfg.CODE_ATTEMPTS) { await ctx.db.prepare('DELETE FROM codes WHERE email_key = ? AND purpose = ?').bind(em.key, purpose).run(); throw fail(400, 'too_many', 'Too many wrong tries. Ask for a new code.'); }
    throw fail(400, 'bad_code', "That code isn't right.", { attemptsLeft: cfg.CODE_ATTEMPTS - attempts });
  }
  await ctx.db.prepare('DELETE FROM codes WHERE email_key = ? AND purpose = ?').bind(em.key, purpose).run();

  if (purpose === 'login') {
    const next = await completeLogin(ctx, { email: em.email, email_key: em.key });
    return reply(ctx, { ok: true, next });
  }
  const s = await requireUser(ctx, { rules: false });
  if (row.user_id !== s.user.id) throw fail(403, 'wrong_account', 'That code was asked for by a different account.');
  if (purpose === 'reauth') {
    if (s.user.email_key !== em.key) throw fail(403, 'wrong_account', "That isn't the email address of this account.");
    await ctx.db.prepare('UPDATE sessions SET last_auth_at = ? WHERE token_hash = ?').bind(ctx.now, s.hash).run();
    return reply(ctx, { ok: true, next: 'done' });
  }
  // link: add this email to the account
  const other = await ctx.db.prepare('SELECT id FROM users WHERE email_key = ? AND id != ?').bind(em.key, s.user.id).first();
  if (other) throw fail(409, 'email_taken', 'That email address already belongs to another account.');
  if (await isBannedIdentity(ctx, { email_key: em.key })) throw BANNED();
  await ctx.db.prepare('UPDATE users SET email = ?, email_key = ? WHERE id = ?').bind(em.email, em.key, s.user.id).run();
  return reply(ctx, { ok: true, next: 'done' });
}

/* ---- Discord ---- */
const RETURN_TO = ['/', '/account/'];
async function routeDiscordStart(ctx) {
  const c = accountsConfig(ctx.env); if (!c.discord) throw fail(503, 'unavailable', 'Discord login is not available right now.');
  const purpose = ['login', 'link', 'reauth'].includes(ctx.url.searchParams.get('purpose')) ? ctx.url.searchParams.get('purpose') : 'login';
  const returnTo = RETURN_TO.includes(ctx.url.searchParams.get('next')) ? ctx.url.searchParams.get('next') : '/';
  let userId = null;
  if (purpose !== 'login') { const s = await getSession(ctx); if (!s) return redirect(ctx, returnTo + '?auth_error=login_required'); userId = s.user.id; }
  if (!(await rateHit(ctx, 'discord:ip:' + await hashIdent(ctx, 'ip', ctx.ip || 'unknown'), 60, MS.HOUR))) return redirect(ctx, returnTo + '?auth_error=rate');
  const state = C.randomToken(32);
  await ctx.db.prepare('INSERT INTO oauth (state_hash, purpose, user_id, return_to, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(await sha(state), purpose, userId, returnTo, ctx.now, ctx.now + 10 * MS.MINUTE).run();
  setCookie(ctx, 'kl_oauth', state, 600, '/api/auth');
  const q = new URLSearchParams({ response_type: 'code', client_id: ctx.env.DISCORD_CLIENT_ID, scope: 'identify', state, redirect_uri: ctx.url.origin + '/api/auth/discord/callback' });
  return redirect(ctx, 'https://discord.com/oauth2/authorize?' + q.toString());
}

async function routeDiscordCallback(ctx) {
  const c = accountsConfig(ctx.env); if (!c.discord) throw fail(503, 'unavailable', 'Discord login is not available right now.');
  const state = ctx.url.searchParams.get('state') || '', code = ctx.url.searchParams.get('code') || '';
  let row = null;
  if (state && ctx.cookies.kl_oauth && C.safeEqual(state, ctx.cookies.kl_oauth)) {
    const hash = await sha(state);
    row = await ctx.db.prepare('SELECT * FROM oauth WHERE state_hash = ?').bind(hash).first();
    await ctx.db.prepare('DELETE FROM oauth WHERE state_hash = ?').bind(hash).run();        // single use
  }
  clearCookie(ctx, 'kl_oauth', '/api/auth');
  if (!row || row.expires_at < ctx.now) return redirect(ctx, '/?auth_error=expired');
  const back = (k, v) => redirect(ctx, row.return_to + '?' + k + '=' + v);
  if (ctx.url.searchParams.get('error') || !code) return back('auth_error', 'cancelled');

  let discordId;
  try {
    const tr = await fetch('https://discord.com/api/oauth2/token', { method: 'POST',
      headers: { authorization: 'Basic ' + btoa(ctx.env.DISCORD_CLIENT_ID + ':' + ctx.env.DISCORD_CLIENT_SECRET), 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: ctx.url.origin + '/api/auth/discord/callback' }) });
    const t = await tr.json(); if (!tr.ok || !t.access_token) throw new Error('token');
    const ur = await fetch('https://discord.com/api/users/@me', { headers: { authorization: 'Bearer ' + t.access_token } });
    const du = await ur.json(); if (!ur.ok || !du.id) throw new Error('user');
    discordId = String(du.id);
  } catch (e) { return back('auth_error', 'discord_failed'); }

  if (row.purpose === 'login') {
    try { const next = await completeLogin(ctx, { discord_id: discordId }); return back('auth', next === 'register' ? 'register' : 'ok'); }
    catch (e) { if (e instanceof HttpError && e.code === 'banned') return back('auth_error', 'banned'); throw e; }
  }
  const s = await getSession(ctx);
  if (!s || s.user.id !== row.user_id) return back('auth_error', 'login_required');
  if (row.purpose === 'reauth') {
    if (s.user.discord_id !== discordId) return back('auth_error', 'wrong_account');
    await ctx.db.prepare('UPDATE sessions SET last_auth_at = ? WHERE token_hash = ?').bind(ctx.now, s.hash).run();
    return back('reauth', 'ok');
  }
  // link
  const other = await ctx.db.prepare('SELECT id FROM users WHERE discord_id = ? AND id != ?').bind(discordId, s.user.id).first();
  if (other) return back('auth_error', 'discord_taken');
  if (await isBannedIdentity(ctx, { discord_id: discordId })) return back('auth_error', 'banned');
  await ctx.db.prepare('UPDATE users SET discord_id = ? WHERE id = ?').bind(discordId, s.user.id).run();
  return back('linked', 'discord');
}

/* ---- register / accept rules / logout ---- */
async function routeRegister(ctx) {
  const body = await readJson(ctx.request);
  const p = await getPending(ctx); if (!p) throw fail(400, 'no_pending', 'Your sign-up has expired. Please log in again.');
  if (body.agreedRules !== true || body.is18 !== true) throw fail(400, 'agree_required', 'Please agree to the rules and confirm that you are 18 or older.');
  const v = U.validate(body.username);
  if (!v.ok) throw fail(400, v.code === 'format' ? 'bad_username' : 'username_unavailable', v.message);
  if (await isBannedIdentity(ctx, { discord_id: p.discord_id, email_key: p.email_key })) throw BANNED();
  try {
    await ctx.db.prepare(`INSERT INTO users (username, username_lower, discord_id, email, email_key, rules_version, accepted_at, created_at, last_login_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(v.name, v.name.toLowerCase(), p.discord_id, p.email, p.email_key, cfg.RULES_VERSION, ctx.now, ctx.now, ctx.now).run();
  } catch (e) {
    const m = String(e && e.message || e);
    if (/username_lower/.test(m)) throw fail(409, 'username_unavailable', "That name isn't available.");
    if (/discord_id|email_key/.test(m)) throw fail(409, 'account_exists', 'That account already exists. Please log in instead.');
    throw e;
  }
  await ctx.db.prepare('DELETE FROM pending WHERE id_hash = ?').bind(p.id_hash).run(); clearCookie(ctx, 'kl_pending');
  const user = await ctx.db.prepare('SELECT * FROM users WHERE username_lower = ?').bind(v.name.toLowerCase()).first();
  await createSession(ctx, user.id);
  return reply(ctx, { ok: true, username: user.username });
}

async function routeAcceptRules(ctx) {
  const s = await requireUser(ctx, { rules: false }); const body = await readJson(ctx.request);
  if (body.agreedRules !== true || body.is18 !== true) throw fail(400, 'agree_required', 'Please agree to the rules and confirm that you are 18 or older.');
  await ctx.db.prepare('UPDATE users SET rules_version = ?, accepted_at = ? WHERE id = ?').bind(cfg.RULES_VERSION, ctx.now, s.user.id).run();
  return reply(ctx, { ok: true });
}

async function routeLogout(ctx) {
  const body = await readJson(ctx.request); const s = await getSession(ctx);
  if (s) await ctx.db.prepare(body.all === true ? 'DELETE FROM sessions WHERE user_id = ?' : 'DELETE FROM sessions WHERE token_hash = ?').bind(body.all === true ? s.user.id : s.hash).run();
  clearCookie(ctx, 'kl_session'); return reply(ctx, { ok: true });
}

/* ---- my account ---- */
async function routeSetUsername(ctx) {
  const s = await requireUser(ctx); const body = await readJson(ctx.request); const u = s.user;
  const next = u.username_changed_at + cfg.USERNAME_RENAME_DAYS * MS.DAY;
  if (ctx.now < next) throw fail(429, 'rename_wait', 'You can change your name again on ' + new Date(next).toISOString().slice(0, 10) + '.', { at: next });
  const v = U.validate(body.username);
  if (!v.ok) throw fail(400, v.code === 'format' ? 'bad_username' : 'username_unavailable', v.message);
  try { await ctx.db.prepare('UPDATE users SET username = ?, username_lower = ?, username_changed_at = ? WHERE id = ?').bind(v.name, v.name.toLowerCase(), ctx.now, u.id).run(); }
  catch (e) { if (/username_lower/.test(String(e && e.message))) throw fail(409, 'username_unavailable', "That name isn't available."); throw e; }
  return reply(ctx, { ok: true, username: v.name });
}
async function routeSettings(ctx) {
  const s = await requireUser(ctx); const body = await readJson(ctx.request);
  if (typeof body.hideLeaderboards === 'boolean') await ctx.db.prepare('UPDATE users SET hide_lb = ? WHERE id = ?').bind(body.hideLeaderboards ? 1 : 0, s.user.id).run();
  return reply(ctx, { ok: true });
}
async function routeExport(ctx) {
  const s = await requireUser(ctx, { rules: false }); const u = s.user;
  const saves = (await ctx.db.prepare('SELECT game, data, updated_at FROM saves WHERE user_id = ?').bind(u.id).all()).results.map(r => ({ game: r.game, updatedAt: r.updated_at, data: JSON.parse(r.data) }));
  const stats = (await ctx.db.prepare('SELECT game, played, won, best_turns, updated_at FROM stats WHERE user_id = ?').bind(u.id).all()).results;
  const filed = await ctx.db.prepare('SELECT COUNT(*) AS n FROM reports WHERE reporter_id = ?').bind(u.id).first('n');
  const data = { exportedAt: new Date(ctx.now).toISOString(), note: 'Everything Kuro Labs holds about this account.',
    account: { username: u.username, discordId: u.discord_id, email: u.email, status: u.status, createdAt: new Date(u.created_at).toISOString(), lastLoginAt: new Date(u.last_login_at).toISOString(),
      acceptedRulesVersion: u.rules_version, acceptedRulesAt: new Date(u.accepted_at).toISOString(), hideFromLeaderboards: !!u.hide_lb }, saves, stats, reportsYouFiled: filed };
  return reply(ctx, data, 200, { 'content-disposition': 'attachment; filename="kurolabs-my-data.json"' });
}
async function routeDeleteAccount(ctx) {
  const s = await requireUser(ctx, { rules: false }); const body = await readJson(ctx.request);
  if (ctx.now - s.lastAuthAt > cfg.FRESH_LOGIN_MINUTES * MS.MINUTE) throw fail(403, 'reauth_required', 'Please confirm it is you: log in again first.');
  if (String(body.confirm || '').trim().toLowerCase() !== s.user.username_lower) throw fail(400, 'confirm_mismatch', 'Type your username exactly to confirm.');
  await ctx.db.prepare('DELETE FROM users WHERE id = ?').bind(s.user.id).run();            // sessions, saves, stats, reports about them go with it
  clearCookie(ctx, 'kl_session'); return reply(ctx, { ok: true });
}

/* ---- saves ---- */
async function routeSave(ctx, game) {
  if (!cfg.SAVE_GAMES.includes(game)) throw fail(404, 'bad_game', 'No such game.');
  const s = await requireUser(ctx);
  if (ctx.request.method === 'GET') {
    const row = await ctx.db.prepare('SELECT data, updated_at FROM saves WHERE user_id = ? AND game = ?').bind(s.user.id, game).first();
    return reply(ctx, { ok: true, data: row ? JSON.parse(row.data) : null, updatedAt: row ? row.updated_at : null });
  }
  if (ctx.request.method !== 'PUT') throw fail(405, 'method_not_allowed', 'Not allowed.');
  const body = await readJson(ctx.request, cfg.MAX_SAVE_BYTES + 512);
  const text = JSON.stringify(body.data === undefined ? null : body.data);
  if (new TextEncoder().encode(text).length > cfg.MAX_SAVE_BYTES) throw fail(413, 'save_too_big', 'That save is too big.');
  await ctx.db.prepare('INSERT INTO saves (user_id, game, data, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(user_id, game) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at').bind(s.user.id, game, text, ctx.now).run();
  return reply(ctx, { ok: true, updatedAt: ctx.now });
}

/* ---- reports ---- */
async function routeReport(ctx) {
  const s = await requireUser(ctx); const body = await readJson(ctx.request);
  const name = String(body.username || '').trim().toLowerCase(), reason = String(body.reason || '').trim().slice(0, 500);
  if (!reason) throw fail(400, 'reason_required', 'Please say what is wrong.');
  if (!(await rateHit(ctx, 'report:' + s.user.id, cfg.REPORTS_PER_DAY, MS.DAY))) throw fail(429, 'report_limit', 'You have sent a lot of reports today. Please try again tomorrow.');
  const target = await ctx.db.prepare('SELECT id FROM users WHERE username_lower = ?').bind(name).first();
  if (!target) throw fail(404, 'not_found', "There's no player with that name.");
  if (target.id === s.user.id) throw fail(400, 'self', "You can't report yourself.");
  await ctx.db.prepare('INSERT INTO reports (reporter_id, target_id, reason, created_at) VALUES (?, ?, ?, ?)').bind(s.user.id, target.id, reason, ctx.now).run();
  return reply(ctx, { ok: true });
}

/* ---- admin ---- */
async function adminLog(ctx, admin, action, target, detail) {
  await ctx.db.prepare('INSERT INTO admin_log (admin_id, action, target, detail, created_at) VALUES (?, ?, ?, ?, ?)').bind(admin.user.id, action, target || null, detail ? String(detail).slice(0, 300) : null, ctx.now).run();
}
async function findUserByName(ctx, name) {
  const u = await ctx.db.prepare('SELECT * FROM users WHERE username_lower = ?').bind(String(name || '').toLowerCase()).first();
  if (!u) throw fail(404, 'not_found', 'No such user.'); return u;
}
async function routeAdmin(ctx, parts) {
  const admin = await requireAdmin(ctx), m = ctx.request.method;
  if (parts[0] === 'reports' && parts.length === 1 && m === 'GET') {
    const status = ctx.url.searchParams.get('status') === 'handled' ? 'handled' : 'open';
    const rows = (await ctx.db.prepare(`SELECT r.id, r.reason, r.created_at, r.status, r.note, t.username AS target, t.status AS target_status, f.username AS reporter
      FROM reports r JOIN users t ON t.id = r.target_id LEFT JOIN users f ON f.id = r.reporter_id WHERE r.status = ? ORDER BY r.created_at DESC LIMIT 100`).bind(status).all()).results;
    return reply(ctx, { ok: true, reports: rows });
  }
  if (parts[0] === 'reports' && parts.length === 3 && parts[2] === 'resolve' && m === 'POST') {
    const body = await readJson(ctx.request);
    await ctx.db.prepare(`UPDATE reports SET status = 'handled', handled_at = ?, handled_by = ?, note = ? WHERE id = ?`).bind(ctx.now, admin.user.id, String(body.note || '').slice(0, 300), Number(parts[1]) || 0).run();
    await adminLog(ctx, admin, 'report_resolved', '#' + parts[1], body.note); return reply(ctx, { ok: true });
  }
  if (parts[0] === 'users' && parts.length === 1 && m === 'GET') {
    const q = String(ctx.url.searchParams.get('q') || '').toLowerCase().replace(/[%_]/g, '');
    const rows = (await ctx.db.prepare(`SELECT username, status, is_admin, created_at, last_login_at, (discord_id IS NOT NULL) AS discord, (email IS NOT NULL) AS email FROM users WHERE username_lower LIKE ? ORDER BY username_lower LIMIT 30`).bind(q + '%').all()).results;
    return reply(ctx, { ok: true, users: rows });
  }
  if (parts[0] === 'users' && parts.length === 3 && m === 'POST') {
    const body = await readJson(ctx.request), u = await findUserByName(ctx, parts[1]), action = parts[2];
    if (u.id === admin.user.id && action !== 'rename') throw fail(400, 'self', "You can't do that to yourself.");
    if (action === 'ban') {
      const hashes = await identHashes(ctx, u), reason = String(body.reason || '').slice(0, 200);
      await ctx.db.batch([ctx.db.prepare(`UPDATE users SET status = 'banned' WHERE id = ?`).bind(u.id), ctx.db.prepare('DELETE FROM sessions WHERE user_id = ?').bind(u.id)]
        .concat(hashes.map(h => ctx.db.prepare('INSERT OR REPLACE INTO ban_list (identifier_hash, created_at, reason) VALUES (?, ?, ?)').bind(h, ctx.now, reason))));
      await adminLog(ctx, admin, 'ban', u.username, reason);
    } else if (action === 'unban') {
      const hashes = await identHashes(ctx, u);
      await ctx.db.batch([ctx.db.prepare(`UPDATE users SET status = 'active' WHERE id = ?`).bind(u.id)].concat(hashes.map(h => ctx.db.prepare('DELETE FROM ban_list WHERE identifier_hash = ?').bind(h))));
      await adminLog(ctx, admin, 'unban', u.username);
    } else if (action === 'rename') {
      let name = U.neutralName(); for (let i = 0; i < 5 && (await ctx.db.prepare('SELECT 1 AS x FROM users WHERE username_lower = ?').bind(name.toLowerCase()).first()); i++) name = U.neutralName();
      await ctx.db.prepare('UPDATE users SET username = ?, username_lower = ?, username_changed_at = 0 WHERE id = ?').bind(name, name.toLowerCase(), u.id).run();   // they may pick a new name straight away
      await adminLog(ctx, admin, 'rename', u.username, '-> ' + name);
    } else if (action === 'delete') {
      await ctx.db.prepare('DELETE FROM users WHERE id = ?').bind(u.id).run(); await adminLog(ctx, admin, 'delete', u.username);
    } else throw fail(404, 'not_found', 'Unknown action.');
    return reply(ctx, { ok: true });
  }
  throw fail(404, 'not_found', 'Not found.');
}

/* ---------- entry point ---------- */
async function handleAccounts(request, env) {
  const url = new URL(request.url), path = url.pathname;
  const mine = path.startsWith('/api/auth/') || path === '/api/me' || path.startsWith('/api/me/') || path.startsWith('/api/save/') || path === '/api/report' || path.startsWith('/api/admin/');
  if (!mine) return null;
  if (!env.DB) {
    if (path === '/api/auth/config') return new Response(JSON.stringify({ ok: true, enabled: false }), { headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
    return new Response(JSON.stringify({ ok: false, error: 'unavailable', message: 'Accounts are not open yet.' }), { status: 503, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
  }
  let ctx;
  try {
    ctx = await makeCtx(request, env);
    requireSameOrigin(ctx);
    const m = request.method, parts = path.split('/').filter(Boolean).slice(1);         // drop "api"
    if (path === '/api/auth/config' && m === 'GET') return await routeConfig(ctx);
    if (path === '/api/me' && m === 'GET') return await routeMe(ctx);
    if (path === '/api/auth/email/start' && m === 'POST') return await routeEmailStart(ctx);
    if (path === '/api/auth/email/verify' && m === 'POST') return await routeEmailVerify(ctx);
    if (path === '/api/auth/discord' && m === 'GET') return await routeDiscordStart(ctx);
    if (path === '/api/auth/discord/callback' && m === 'GET') return await routeDiscordCallback(ctx);
    if (path === '/api/auth/register' && m === 'POST') return await routeRegister(ctx);
    if (path === '/api/auth/accept-rules' && m === 'POST') return await routeAcceptRules(ctx);
    if (path === '/api/auth/logout' && m === 'POST') return await routeLogout(ctx);
    if (path === '/api/me/username' && m === 'POST') return await routeSetUsername(ctx);
    if (path === '/api/me/settings' && m === 'POST') return await routeSettings(ctx);
    if (path === '/api/me/export' && m === 'GET') return await routeExport(ctx);
    if (path === '/api/me' && m === 'DELETE') return await routeDeleteAccount(ctx);
    if (parts[0] === 'save' && parts.length === 2) return await routeSave(ctx, parts[1]);
    if (path === '/api/report' && m === 'POST') return await routeReport(ctx);
    if (parts[0] === 'admin') return await routeAdmin(ctx, parts.slice(1));
    throw fail(404, 'not_found', 'Not found.');
  } catch (e) {
    const c = ctx || { setCookies: [] };
    if (e instanceof HttpError) return makeResponse(c, JSON.stringify({ ok: false, error: e.code, message: e.message, ...e.extra }), e.status, { 'content-type': 'application/json; charset=utf-8' });
    return makeResponse(c, JSON.stringify({ ok: false, error: 'server', message: 'Something went wrong. Please try again.' }), 500, { 'content-type': 'application/json; charset=utf-8' });
  }
}

/* ---------- stats (called by game servers, never by browsers) ---------- */
async function recordGameResult(env, userId, game, { won, turns }) {
  await ensureSchema(env.DB);
  await env.DB.prepare(`INSERT INTO stats (user_id, game, played, won, best_turns, updated_at) VALUES (?, ?, 1, ?, ?, ?)
    ON CONFLICT(user_id, game) DO UPDATE SET played = played + 1, won = won + excluded.won,
    best_turns = CASE WHEN excluded.best_turns IS NULL THEN best_turns WHEN best_turns IS NULL THEN excluded.best_turns ELSE MIN(best_turns, excluded.best_turns) END, updated_at = excluded.updated_at`)
    .bind(userId, game, won ? 1 : 0, won ? turns : null, Date.now()).run();
}

/* ---------- the nightly job ---------- */
async function runCleanup(env, now) {
  if (!env.DB) return { skipped: 'no database yet' };
  now = now || Date.now(); const db = env.DB; await ensureSchema(db);
  const R = cfg.RETENTION, out = {};
  const del = async (name, sql, ...args) => { out[name] = (await db.prepare(sql).bind(...args).run()).meta.changes; };
  await del('sessions', 'DELETE FROM sessions WHERE expires_at < ?', now);
  await del('pending', 'DELETE FROM pending WHERE expires_at < ?', now);
  await del('codes', 'DELETE FROM codes WHERE expires_at < ?', now);
  await del('oauth', 'DELETE FROM oauth WHERE expires_at < ?', now);
  await del('rate', 'DELETE FROM rate WHERE window_start < ?', now - 2 * MS.DAY);
  await del('reports', `DELETE FROM reports WHERE status = 'handled' AND handled_at < ?`, now - R.HANDLED_REPORT_MONTHS * 30 * MS.DAY);
  await del('bans', 'DELETE FROM ban_list WHERE created_at < ?', now - R.BAN_HASH_YEARS * 365 * MS.DAY);
  await del('adminLog', 'DELETE FROM admin_log WHERE created_at < ?', now - R.ADMIN_LOG_MONTHS * 30 * MS.DAY);

  // Unused accounts: a warning email 30 days ahead where we have an email address, then deletion. Admins are never touched.
  const idle = now - R.INACTIVE_ACCOUNT_MONTHS * 30 * MS.DAY, warnAfter = now - R.INACTIVE_WARNING_DAYS * MS.DAY;
  out.deleted = (await db.prepare('DELETE FROM users WHERE is_admin = 0 AND last_login_at < ? AND ((email IS NULL) OR (inactive_warned_at IS NOT NULL AND inactive_warned_at < ?))').bind(idle, warnAfter).run()).meta.changes;
  out.warned = 0;
  if (env.RESEND_API_KEY) {
    const due = (await db.prepare('SELECT id, username, email FROM users WHERE is_admin = 0 AND email IS NOT NULL AND inactive_warned_at IS NULL AND last_login_at < ? LIMIT 20').bind(idle).all()).results;
    for (const u of due) {
      try {
        await sendMail(env, { to: u.email, subject: 'Your Kuro Labs account will be deleted if you do not log in',
          text: `Hello ${u.username},\n\nYour Kuro Labs account has not been used for almost two years. It will be deleted in ${R.INACTIVE_WARNING_DAYS} days unless you log in at https://kurolabs.net before then.\n\nIf you do not want to keep it, you do not need to do anything.`,
          html: `<p>Hello ${u.username.replace(/[<>&]/g, '')},</p><p>Your Kuro Labs account has not been used for almost two years. It will be deleted in ${R.INACTIVE_WARNING_DAYS} days unless you log in at <a href="https://kurolabs.net">kurolabs.net</a> before then.</p><p>If you do not want to keep it, you do not need to do anything.</p>` });
        await db.prepare('UPDATE users SET inactive_warned_at = ? WHERE id = ?').bind(now, u.id).run(); out.warned++;
      } catch (e) { /* try again tomorrow */ }
    }
  }
  return out;
}

module.exports = { handleAccounts, runCleanup, recordGameResult, accountsConfig, normalizeEmail, isDisposable, HttpError };
