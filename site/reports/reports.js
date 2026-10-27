'use strict';
/* Roblox game bug reports.
 *
 *   handle(request, env)   -> a Response, or null when the path is not ours
 *   runCleanup(env, now)   -> what the nightly retention job deleted (called from the Worker's cron handler)
 *
 * Two completely separate doors:
 *   POST /api/roblox-reports      the game server. Authenticated with a per-game submission key (header X-JetBreak-Report-Key or X-Report-Key).
 *                                 A key can only submit reports for its own game. It can never read or change anything.
 *   /api/owner/...                the owner dashboard. Needs a browser login whose *Discord user id* equals the OWNER_DISCORD_ID variable,
 *                                 checked on every request, plus a session-bound CSRF token on every change.
 * The contract, bindings and setup are in site/reports/README.md. Nothing here logs report text, keys or addresses.
 */
const cfg = require('../accounts/config.js');
const A = require('../accounts/accounts.js');
const { ensureSchema } = require('../accounts/schema.js');
const C = require('../accounts/crypto.js');
const K = A.internals, R = cfg.ROBLOX_REPORTS, MS = cfg.MS;
const fail = K.fail;

const STATUSES = ['new', 'investigating', 'fixed', 'closed'];
const LIMITS = { description: [10, 2000], steps: [0, 2000], expected: [0, 1000], actual: [0, 1000], notes: [0, 5000] };
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const GAME_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
const KEY_RE = /^rbxk_[A-Za-z0-9_-]{43}$/;
const REPORT_ID_RE = /^rpt_[A-Za-z0-9_-]{22}$/;
const MAX_SAFE = Number.MAX_SAFE_INTEGER;
const keyHash = key => C.sha256Hex('roblox-report-key:' + key);

/* ---------- small helpers ---------- */
const jsonHeaders = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' };
const send = (obj, status = 200, extra) => new Response(JSON.stringify(obj), { status, headers: { ...jsonHeaders, ...(extra || {}) } });

// Player text: tidy line endings, drop control characters and broken surrogates; never trusted as markup (the dashboard only ever shows it as plain text).
function cleanText(s) {
  s = String(s).replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u2028\u2029\uFFFE\uFFFF]/g, '');
  return typeof s.isWellFormed === 'function' && !s.isWellFormed() ? s.toWellFormed() : s;
}
const chars = s => { let n = 0; for (const _ of s) n++; return n; };      // code points, so one emoji counts as one
const isPrintableAscii = s => /^[\x20-\x7E]+$/.test(s);

async function readBody(request, maxBytes, timeoutMs) {
  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) throw fail(413, 'payload_too_large', 'That request is too large.');
  if (!request.body) return '';
  const reader = request.body.getReader(), chunks = []; let total = 0, timer;
  const deadline = new Promise((_, rej) => { timer = setTimeout(() => rej(fail(408, 'request_timeout', 'The request took too long.')), timeoutMs); });
  try {
    for (;;) {
      const { done, value } = await Promise.race([reader.read(), deadline]);
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) { reader.cancel().catch(() => {}); throw fail(413, 'payload_too_large', 'That request is too large.'); }
      chunks.push(value);
    }
  } catch (e) { if (e && e.status === 408) reader.cancel().catch(() => {}); throw e; }
  finally { clearTimeout(timer); }
  const all = new Uint8Array(total); let o = 0; for (const c of chunks) { all.set(c, o); o += c.byteLength; }
  try { return new TextDecoder('utf-8', { fatal: true }).decode(all); } catch (e) { throw fail(400, 'invalid_json', 'The request body is not valid UTF-8 JSON.'); }
}
async function readJsonObject(request, maxBytes) {
  const type = String(request.headers.get('content-type') || '').toLowerCase();
  if (!/^application\/json(\s*;|$)/.test(type)) throw fail(415, 'unsupported_media_type', 'Send the body as application/json.');
  const text = await readBody(request, maxBytes, R.BODY_TIMEOUT_MS);
  let v; try { v = JSON.parse(text); } catch (e) { throw fail(400, 'invalid_json', 'The request body is not valid JSON.'); }
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw fail(400, 'invalid_json', 'The request body must be a JSON object.');
  return v;
}

/* ---------- validation of a submission (schema version 1) ---------- */
const TOP_FIELDS = new Set(['schemaVersion', 'submissionId', 'gameKey', 'buildVersion', 'description', 'steps', 'expected', 'actual', 'context']);
const CONTEXT_FIELDS = new Set(['placeId', 'universeId', 'platform', 'viewportWidth', 'viewportHeight']);

function validateSubmission(body) {
  const bad = [], add = (field, code) => bad.push({ field, code });
  for (const k of Object.keys(body)) if (!TOP_FIELDS.has(k)) add(k, 'unknown_field');
  if (body.schemaVersion !== 1) throw fail(400, 'unsupported_schema', 'schemaVersion must be 1.');
  const v = {};
  if (typeof body.submissionId !== 'string' || !UUID_RE.test(body.submissionId.toLowerCase())) add('submissionId', 'invalid_uuid'); else v.submissionId = body.submissionId.toLowerCase();
  if (typeof body.gameKey !== 'string' || !GAME_RE.test(body.gameKey)) add('gameKey', 'invalid_game_key'); else v.gameKey = body.gameKey;
  if (typeof body.buildVersion !== 'string') add('buildVersion', 'required'); else {
    const b = body.buildVersion.trim();
    if (!b || chars(b) > 64) add('buildVersion', 'length'); else if (!isPrintableAscii(b)) add('buildVersion', 'invalid_characters'); else v.buildVersion = b;
  }
  const text = (name, required) => {
    const raw = body[name];
    if (raw === undefined || raw === null || raw === '') { if (required) add(name, 'required'); v[name] = null; return; }
    if (typeof raw !== 'string') { add(name, 'invalid_type'); return; }
    const t = cleanText(raw).trim(), [min, max] = LIMITS[name], n = chars(t);
    if (n === 0 && !required) { v[name] = null; return; }
    if (n < min || n > max) { add(name, n < min ? 'too_short' : 'too_long'); return; }
    v[name] = t;
  };
  text('description', true); text('steps'); text('expected'); text('actual');
  const ctx = {};
  if (body.context !== undefined && body.context !== null) {
    if (typeof body.context !== 'object' || Array.isArray(body.context)) add('context', 'invalid_type'); else {
      for (const k of Object.keys(body.context)) if (!CONTEXT_FIELDS.has(k)) add('context.' + k, 'unknown_field');
      const int = (k, max) => { const x = body.context[k]; if (x === undefined || x === null) return; if (!Number.isInteger(x) || x < 0 || x > max) add('context.' + k, 'out_of_range'); else ctx[k] = x; };
      int('placeId', MAX_SAFE); int('universeId', MAX_SAFE); int('viewportWidth', 20000); int('viewportHeight', 20000);
      const p = body.context.platform;
      if (p !== undefined && p !== null) { if (typeof p !== 'string') add('context.platform', 'invalid_type'); else { const t = p.trim(); if (t && (chars(t) > 32 || !isPrintableAscii(t))) add('context.platform', 'invalid_value'); else if (t) ctx.platform = t; } }
    }
  }
  if (bad.length) throw fail(400, 'validation_failed', 'The report was not accepted. See details.', { details: bad.slice(0, 20) });
  v.context = ctx;
  return v;
}
const payloadHash = v => C.sha256Hex(JSON.stringify(['v1', v.buildVersion, v.description, v.steps, v.expected, v.actual,
  v.context.placeId ?? null, v.context.universeId ?? null, v.context.platform ?? null, v.context.viewportWidth ?? null, v.context.viewportHeight ?? null]));

/* ---------- the game server door ---------- */
async function handleSubmit(ctx) {
  const { request, env } = ctx;
  if (request.method !== 'POST') throw fail(405, 'method_not_allowed', 'Use POST.', { allow: 'POST' });
  const key = (request.headers.get('x-jetbreak-report-key') || request.headers.get('x-report-key') || '').trim();
  let row = null;
  if (key && KEY_RE.test(key)) row = await ctx.db.prepare('SELECT id, game_key FROM roblox_game_keys WHERE key_hash = ? AND revoked_at IS NULL').bind(await keyHash(key)).first();
  if (!row) {
    if (!(await A.limitByIp(env, request, 'rbx-bad-key', R.BAD_KEY_PER_15MIN, 15 * MS.MINUTE))) throw fail(429, 'rate_limited', 'Too many attempts. Please wait.', { retryAfter: 900 });
    throw fail(401, key ? 'invalid_key' : 'missing_key', 'A valid report key is required.');
  }
  if (!(await K.rateHit(ctx, 'rbx-min:' + row.id, R.KEY_PER_MINUTE, MS.MINUTE))) throw fail(429, 'rate_limited', 'Too many reports. Please slow down.', { retryAfter: 60 });
  if (!(await K.rateHit(ctx, 'rbx-hr:' + row.id, R.KEY_PER_HOUR, MS.HOUR))) throw fail(429, 'rate_limited', 'Too many reports. Please slow down.', { retryAfter: 3600 });
  const body = await readJsonObject(request, R.MAX_BODY_BYTES);
  if (typeof body.gameKey === 'string' && body.gameKey !== row.game_key) throw fail(403, 'game_mismatch', 'This key may not submit reports for that game.');
  const v = validateSubmission(body);
  if (v.gameKey !== row.game_key) throw fail(403, 'game_mismatch', 'This key may not submit reports for that game.');
  const hash = await payloadHash(v), id = 'rpt_' + C.randomToken(16);
  await ctx.db.prepare(`INSERT INTO roblox_reports (id, game_key, submission_id, payload_hash, build_version, description, steps, expected, actual, context, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(game_key, submission_id) DO NOTHING`)
    .bind(id, row.game_key, v.submissionId, hash, v.buildVersion, v.description, v.steps, v.expected, v.actual, Object.keys(v.context).length ? JSON.stringify(v.context) : null, ctx.now, ctx.now).run();
  const saved = await ctx.db.prepare('SELECT id, payload_hash FROM roblox_reports WHERE game_key = ? AND submission_id = ?').bind(row.game_key, v.submissionId).first();
  ctx.db.prepare('UPDATE roblox_game_keys SET last_used_at = ? WHERE id = ?').bind(ctx.now, row.id).run().catch(() => {});
  if (saved.id === id) return send({ ok: true, reportId: id }, 201);
  if (saved.payload_hash !== hash) throw fail(409, 'submission_conflict', 'That submissionId was already used for a different report.');
  return send({ ok: true, reportId: saved.id, duplicate: true }, 200);
}

/* ---------- the owner door ---------- */
const csrfFor = (ctx, s) => C.hmacHex(ctx.secret, 'owner-csrf:' + s.hash);
async function requireOwner(ctx) {
  K.requireSameOrigin(ctx);                                       // changes must come from this site's own pages
  const s = await K.requireUser(ctx);                              // logged in, rules accepted
  if (!K.isOwnerUser(ctx.env, s.user)) throw fail(403, 'forbidden', 'Not allowed.');          // Discord id compared on every request; closed when unset
  if (!(await K.rateHit(ctx, 'owner:' + s.user.id, R.OWNER_PER_MINUTE, MS.MINUTE))) throw fail(429, 'rate_limited', 'Slow down a little.', { retryAfter: 60 });
  const m = ctx.request.method;
  if (m !== 'GET' && m !== 'HEAD' && !C.safeEqual(ctx.request.headers.get('x-csrf-token') || '', await csrfFor(ctx, s))) throw fail(403, 'csrf', 'Please reload the page and try again.');
  return s;
}
const likePattern = q => '%' + q.replace(/[\\%_]/g, c => '\\' + c) + '%';
const intParam = (url, name, def, min, max) => { const raw = url.searchParams.get(name); if (raw === null || raw === '') return def; const n = Number(raw); if (!Number.isInteger(n) || n < min || n > max) throw fail(400, 'bad_parameter', 'Invalid ' + name + '.'); return n; };
const parseContext = s => { try { return s ? JSON.parse(s) : {}; } catch (e) { return {}; } };
const listItem = r => ({ id: r.id, status: r.status, createdAt: r.created_at, updatedAt: r.updated_at, buildVersion: r.build_version, preview: String(r.description).slice(0, 160), hasNotes: !!r.owner_notes, fixedInVersion: r.fixed_in_version || null });
async function findGame(ctx, game) {
  const g = await ctx.db.prepare('SELECT game_key, name FROM roblox_games WHERE game_key = ?').bind(String(game)).first();
  if (!g) throw fail(404, 'unknown_game', 'No such game.'); return g;
}
function detail(r, events) {
  return { id: r.id, game: r.game_key, gameName: r.game_name, status: r.status, buildVersion: r.build_version, description: r.description, steps: r.steps, expected: r.expected, actual: r.actual,
    context: parseContext(r.context), createdAt: r.created_at, updatedAt: r.updated_at, updatedBy: r.updated_by_name || null, ownerNotes: r.owner_notes, fixedInVersion: r.fixed_in_version || null,
    history: events.map(e => ({ at: e.created_at, by: e.actor_name || 'owner', changes: parseContext(e.detail) })) };
}
async function loadReport(ctx, id) {
  if (!REPORT_ID_RE.test(String(id))) throw fail(404, 'not_found', 'No such report.');
  const r = await ctx.db.prepare('SELECT r.*, g.name AS game_name FROM roblox_reports r JOIN roblox_games g ON g.game_key = r.game_key WHERE r.id = ?').bind(id).first();
  if (!r) throw fail(404, 'not_found', 'No such report.'); return r;
}
const loadEvents = (ctx, id) => ctx.db.prepare('SELECT actor_name, detail, created_at FROM roblox_report_events WHERE report_id = ? ORDER BY id DESC LIMIT 50').bind(id).all().then(x => x.results);
const ownerLog = (ctx, s, action, target) => ctx.db.prepare('INSERT INTO admin_log (admin_id, action, target, detail, created_at) VALUES (?, ?, ?, ?, ?)').bind(s.user.id, action, target, null, ctx.now);

async function handleOwner(ctx, parts) {            // parts: what follows /api/owner/
  const s = await requireOwner(ctx), m = ctx.request.method, url = ctx.url, reply = (o, st) => K.reply(ctx, o, st, { 'x-content-type-options': 'nosniff' });
  if (parts[0] === 'session' && parts.length === 1 && m === 'GET') return reply({ ok: true, owner: { username: s.user.username }, csrf: await csrfFor(ctx, s) });
  if (parts[0] !== 'roblox') throw fail(404, 'not_found', 'Not found.');

  if (parts[1] === 'games' && parts.length === 2 && m === 'GET') {
    const rows = (await ctx.db.prepare(`SELECT g.game_key, g.name, COUNT(r.id) AS total, COALESCE(SUM(r.status = 'new'), 0) AS n_new, COALESCE(SUM(r.status = 'investigating'), 0) AS n_inv,
      COALESCE(SUM(r.status = 'fixed'), 0) AS n_fixed, COALESCE(SUM(r.status = 'closed'), 0) AS n_closed, MAX(r.created_at) AS last_at,
      (SELECT COUNT(*) FROM roblox_game_keys k WHERE k.game_key = g.game_key AND k.revoked_at IS NULL) AS active_keys
      FROM roblox_games g LEFT JOIN roblox_reports r ON r.game_key = g.game_key GROUP BY g.game_key, g.name ORDER BY g.name`).all()).results;
    return reply({ ok: true, games: rows.map(r => ({ key: r.game_key, name: r.name, total: r.total, counts: { new: r.n_new, investigating: r.n_inv, fixed: r.n_fixed, closed: r.n_closed }, lastReportAt: r.last_at, activeKeys: r.active_keys })) });
  }

  if (parts[1] === 'games' && parts[3] === 'reports' && parts.length === 4 && m === 'GET') {
    const g = await findGame(ctx, parts[2]);
    const status = url.searchParams.get('status') || '', q = String(url.searchParams.get('q') || '').trim();
    if (status && !STATUSES.includes(status)) throw fail(400, 'bad_parameter', 'Invalid status.');
    if (chars(q) > 100) throw fail(400, 'bad_parameter', 'That search is too long.');
    const size = intParam(url, 'pageSize', R.PAGE_SIZE, 1, R.MAX_PAGE_SIZE), page = intParam(url, 'page', 1, 1, 100000);
    let where = 'game_key = ?'; const args = [g.game_key];
    if (status) { where += ' AND status = ?'; args.push(status); }
    if (q) { const p = likePattern(cleanText(q)); where += ` AND (id LIKE ? ESCAPE '\\' OR description LIKE ? ESCAPE '\\' OR steps LIKE ? ESCAPE '\\' OR expected LIKE ? ESCAPE '\\' OR actual LIKE ? ESCAPE '\\' OR build_version LIKE ? ESCAPE '\\' OR owner_notes LIKE ? ESCAPE '\\' OR fixed_in_version LIKE ? ESCAPE '\\')`; for (let i = 0; i < 8; i++) args.push(p); }
    const total = (await ctx.db.prepare('SELECT COUNT(*) AS n FROM roblox_reports WHERE ' + where).bind(...args).first()).n;
    const rows = (await ctx.db.prepare(`SELECT id, status, created_at, updated_at, build_version, description, owner_notes, fixed_in_version FROM roblox_reports WHERE ${where} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`).bind(...args, size, (page - 1) * size).all()).results;
    const counts = { new: 0, investigating: 0, fixed: 0, closed: 0 };
    for (const c of (await ctx.db.prepare('SELECT status, COUNT(*) AS n FROM roblox_reports WHERE game_key = ? GROUP BY status').bind(g.game_key).all()).results) counts[c.status] = c.n;
    return reply({ ok: true, game: { key: g.game_key, name: g.name }, reports: rows.map(listItem), total, page, pageSize: size, pages: Math.max(1, Math.ceil(total / size)), counts });
  }

  if (parts[1] === 'reports' && parts.length === 3 && m === 'GET') {
    const r = await loadReport(ctx, parts[2]); return reply({ ok: true, report: detail(r, await loadEvents(ctx, r.id)) });
  }

  if (parts[1] === 'reports' && parts.length === 3 && m === 'POST') {
    const body = await readJsonObject(ctx.request, 16 * 1024), r = await loadReport(ctx, parts[2]), changes = {}, set = [], args = [], bad = [];
    for (const k of Object.keys(body)) if (!['status', 'ownerNotes', 'fixedInVersion', 'expectedUpdatedAt'].includes(k)) bad.push({ field: k, code: 'unknown_field' });
    if (body.expectedUpdatedAt !== undefined && body.expectedUpdatedAt !== r.updated_at) throw fail(409, 'stale', 'This report changed since you opened it. Reload it and try again.', { report: detail(r, await loadEvents(ctx, r.id)) });
    if (body.status !== undefined) { if (!STATUSES.includes(body.status)) bad.push({ field: 'status', code: 'invalid_value' }); else if (body.status !== r.status) { changes.status = [r.status, body.status]; set.push('status = ?'); args.push(body.status); } }
    if (body.ownerNotes !== undefined) {
      if (typeof body.ownerNotes !== 'string') bad.push({ field: 'ownerNotes', code: 'invalid_type' });
      else { const t = cleanText(body.ownerNotes); if (chars(t) > LIMITS.notes[1]) bad.push({ field: 'ownerNotes', code: 'too_long' }); else if (t !== r.owner_notes) { changes.notes = true; set.push('owner_notes = ?'); args.push(t); } }
    }
    if (body.fixedInVersion !== undefined) {
      const raw = body.fixedInVersion === null ? '' : body.fixedInVersion;
      if (typeof raw !== 'string') bad.push({ field: 'fixedInVersion', code: 'invalid_type' });
      else { const t = raw.trim(); if (t && (chars(t) > 64 || !isPrintableAscii(t))) bad.push({ field: 'fixedInVersion', code: 'invalid_value' }); else if (t !== (r.fixed_in_version || '')) { changes.fixedInVersion = [r.fixed_in_version || '', t]; set.push('fixed_in_version = ?'); args.push(t || null); } }
    }
    if (bad.length) throw fail(400, 'validation_failed', 'The change was not accepted. See details.', { details: bad });
    if (!set.length) return reply({ ok: true, changed: false, report: detail(r, await loadEvents(ctx, r.id)) });
    const who = s.user.username;
    await ctx.db.batch([
      ctx.db.prepare(`UPDATE roblox_reports SET ${set.join(', ')}, updated_at = ?, updated_by = ?, updated_by_name = ? WHERE id = ?`).bind(...args, ctx.now, s.user.id, who, r.id),
      ctx.db.prepare('INSERT INTO roblox_report_events (report_id, actor_id, actor_name, detail, created_at) VALUES (?, ?, ?, ?, ?)').bind(r.id, s.user.id, who, JSON.stringify(changes).slice(0, 400), ctx.now)
    ]);
    const fresh = await loadReport(ctx, r.id); return reply({ ok: true, changed: true, report: detail(fresh, await loadEvents(ctx, r.id)) });
  }

  if (parts[1] === 'games' && parts[3] === 'keys') {
    const g = await findGame(ctx, parts[2]);
    if (parts.length === 4 && m === 'GET') {
      const rows = (await ctx.db.prepare('SELECT id, label, created_at, last_used_at, revoked_at FROM roblox_game_keys WHERE game_key = ? ORDER BY id DESC').bind(g.game_key).all()).results;
      return reply({ ok: true, keys: rows.map(k => ({ id: k.id, label: k.label || '', createdAt: k.created_at, lastUsedAt: k.last_used_at, revokedAt: k.revoked_at })) });
    }
    if (parts.length === 4 && m === 'POST') {
      const body = await readJsonObject(ctx.request, 2048), label = typeof body.label === 'string' ? cleanText(body.label).trim().slice(0, 60) : '';
      if (!(await K.rateHit(ctx, 'rbx-keygen:' + s.user.id, R.KEYS_CREATED_PER_HOUR, MS.HOUR))) throw fail(429, 'rate_limited', 'You created several keys recently. Try again later.', { retryAfter: 3600 });
      const key = 'rbxk_' + C.randomToken(32), h = await keyHash(key);
      await ctx.db.batch([
        ctx.db.prepare('INSERT INTO roblox_game_keys (game_key, key_hash, label, created_at, created_by) VALUES (?, ?, ?, ?, ?)').bind(g.game_key, h, label || null, ctx.now, s.user.id),
        ownerLog(ctx, s, 'roblox_key_created', g.game_key)
      ]);
      const id = (await ctx.db.prepare('SELECT id FROM roblox_game_keys WHERE key_hash = ?').bind(h).first()).id;
      return reply({ ok: true, id, key, note: 'This is the only time the key is shown. Store it in the Roblox experience secret store.' }, 201);
    }
    if (parts.length === 6 && parts[5] === 'revoke' && m === 'POST') {
      const id = Number(parts[4]); if (!Number.isInteger(id) || id < 1) throw fail(404, 'not_found', 'No such key.');
      if (!(await ctx.db.prepare('SELECT id FROM roblox_game_keys WHERE id = ? AND game_key = ? AND revoked_at IS NULL').bind(id, g.game_key).first())) throw fail(404, 'not_found', 'No such active key.');
      await ctx.db.batch([
        ctx.db.prepare('UPDATE roblox_game_keys SET revoked_at = ? WHERE id = ? AND game_key = ?').bind(ctx.now, id, g.game_key),
        ownerLog(ctx, s, 'roblox_key_revoked', g.game_key + '#' + id)
      ]);
      return reply({ ok: true });
    }
  }
  throw fail(404, 'not_found', 'Not found.');
}

/* ---------- entry point ---------- */
async function handle(request, env) {
  const path = new URL(request.url).pathname;
  const isSubmit = path === '/api/roblox-reports', isOwner = path.startsWith('/api/owner/');
  if (!isSubmit && !isOwner) return null;
  if (!env || !env.DB) return send({ ok: false, error: 'unavailable', message: 'Not available yet.' }, 503);
  let ctx;
  try {
    ctx = await K.makeCtx(request, env);
    if (isSubmit) return await handleSubmit(ctx);
    return await handleOwner(ctx, path.split('/').filter(Boolean).slice(2));
  } catch (e) {
    const c = ctx || { setCookies: [] };
    if (e instanceof A.HttpError) {
      const { retryAfter, allow, ...extra } = e.extra || {}, h = { ...jsonHeaders };
      if (retryAfter) h['retry-after'] = String(retryAfter);
      if (allow) h.allow = allow;
      return K.makeResponse(c, JSON.stringify({ ok: false, error: e.code, message: e.message, ...extra }), e.status, h);
    }
    return K.makeResponse(c, JSON.stringify({ ok: false, error: 'server', message: 'Something went wrong. Please try again.' }), 500, jsonHeaders);
  }
}

/* ---------- nightly retention ---------- */
const days = (v, def) => { const n = Number(v); return Number.isFinite(n) && n >= 1 ? n : def; };
async function runCleanup(env, now) {
  if (!env || !env.DB) return { skipped: 'no database yet' };
  now = now || Date.now(); await ensureSchema(env.DB);
  const closed = days(env.REPORT_RETENTION_DAYS, R.RETENTION_DAYS), open = days(env.REPORT_RETENTION_OPEN_DAYS, R.RETENTION_OPEN_DAYS), out = {};
  out.closedReports = (await env.DB.prepare(`DELETE FROM roblox_reports WHERE status IN ('fixed', 'closed') AND updated_at < ?`).bind(now - closed * MS.DAY).run()).meta.changes;
  out.openReports = (await env.DB.prepare(`DELETE FROM roblox_reports WHERE status IN ('new', 'investigating') AND created_at < ?`).bind(now - open * MS.DAY).run()).meta.changes;
  out.keys = (await env.DB.prepare('DELETE FROM roblox_game_keys WHERE revoked_at IS NOT NULL AND revoked_at < ?').bind(now - 30 * MS.DAY).run()).meta.changes;
  return out;
}

module.exports = { handle, runCleanup, validateSubmission, STATUSES };
