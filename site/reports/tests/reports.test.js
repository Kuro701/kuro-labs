'use strict';
// Run with: node site/reports/tests/reports.test.js
// The Roblox bug-report system against an SQLite stand-in for D1: unauthorised access, game-key isolation, validation,
// duplicate retries, rate limits, safe text, persistent status/notes, key handling and retention.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { D1Shim } = require('../../accounts/tests/d1-shim.js');
const { ensureSchema } = require('../../accounts/schema.js');
const C = require('../../accounts/crypto.js');
const cfg = require('../../accounts/config.js');
const reports = require('../reports.js');

const ORIGIN = 'https://kurolabs.net', MS = cfg.MS, R = cfg.ROBLOX_REPORTS;
const OWNER_DISCORD = '123456789012345678', OTHER_DISCORD = '987654321098765432';
const uuid = () => crypto.randomUUID();
const ch = n => String.fromCharCode(n);
const tests = []; const test = (name, fn) => tests.push([name, fn]);

/* ---------- harness ---------- */
async function newEnv(over) {
  const env = { DB: new D1Shim(), OWNER_DISCORD_ID: OWNER_DISCORD, ...(over || {}) };
  await ensureSchema(env.DB); return env;
}
async function addUser(env, { name, discord = null, admin = 0, status = 'active' }) {
  const now = Date.now();
  await env.DB.prepare('INSERT INTO users (username, username_lower, discord_id, status, is_admin, rules_version, accepted_at, created_at, last_login_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(name, name.toLowerCase(), discord, status, admin, cfg.RULES_VERSION, now, now, now).run();
  const id = (await env.DB.prepare('SELECT id FROM users WHERE username_lower = ?').bind(name.toLowerCase()).first()).id;
  const token = C.randomToken(32);
  await env.DB.prepare('INSERT INTO sessions (token_hash, user_id, created_at, expires_at, last_auth_at) VALUES (?, ?, ?, ?, ?)').bind(await C.sha256Hex(token), id, now, now + MS.DAY, now).run();
  return { id, token };
}
async function call(env, method, p, { headers, body, raw, cookie, origin = ORIGIN, ip = '203.0.113.7', csrf, type = 'application/json' } = {}) {
  const h = { 'cf-connecting-ip': ip, ...(headers || {}) };
  if (origin) h.origin = origin;
  if (cookie) h.cookie = 'kl_session=' + encodeURIComponent(cookie);
  if (csrf) h['x-csrf-token'] = csrf;
  let b; if (raw !== undefined) b = raw; else if (body !== undefined) b = JSON.stringify(body);
  if (b !== undefined && type) h['content-type'] = type;
  const res = await reports.handle(new Request(ORIGIN + p, { method, headers: h, body: b }), env);
  if (!res) return null;
  const text = await res.text(); let json = null; try { json = JSON.parse(text); } catch (e) { /* not JSON */ }
  return { status: res.status, json, text, headers: res.headers };
}
// the game server
const goodBody = (over) => ({ schemaVersion: 1, submissionId: uuid(), gameKey: 'jetbreak', buildVersion: '0.4.2', description: 'The jet stops responding after I respawn.', steps: '1. Spawn\n2. Die\n3. Respawn', expected: 'Jet flies', actual: 'Jet frozen', context: { placeId: 111, universeId: 222, platform: 'Windows', viewportWidth: 1920, viewportHeight: 1080 }, ...(over || {}) });
const submit = (env, key, body, o) => call(env, 'POST', '/api/roblox-reports', { headers: key ? { 'x-jetbreak-report-key': key } : {}, body, origin: null, ...(o || {}) });
// the owner
async function owner(env) {
  const u = await addUser(env, { name: 'Kuro', discord: OWNER_DISCORD, admin: 1 });
  const s = await call(env, 'GET', '/api/owner/session', { cookie: u.token }); assert.equal(s.status, 200, s.text);
  const csrf = s.json.csrf;
  return { user: u, csrf,
    get: p => call(env, 'GET', p, { cookie: u.token }),
    post: (p, body, o) => call(env, 'POST', p, { cookie: u.token, csrf, body, ...(o || {}) }) };
}
async function makeKey(own, game = 'jetbreak', label = 'test') { const r = await own.post(`/api/owner/roblox/games/${game}/keys`, { label }); assert.equal(r.status, 201, r.text); return r.json.key; }
async function addGame(env, key, name) { await env.DB.prepare('INSERT INTO roblox_games (game_key, name, created_at) VALUES (?, ?, ?)').bind(key, name, Date.now()).run(); }
const count = async (env, sql = 'SELECT COUNT(*) AS n FROM roblox_reports') => (await env.DB.prepare(sql).first()).n;

/* ---------- tests ---------- */
test('schema: migrations are repeatable, JetBreak is registered, and the database itself refuses duplicate submissions', async () => {
  const env = await newEnv();
  await ensureSchema(env.DB);
  assert.deepEqual((await env.DB.prepare('SELECT game_key, name FROM roblox_games').all()).results.map(r => ({ ...r })), [{ game_key: 'jetbreak', name: 'JetBreak' }]);
  const ins = (id) => env.DB.prepare(`INSERT INTO roblox_reports (id, game_key, submission_id, payload_hash, build_version, description, created_at, updated_at) VALUES (?, 'jetbreak', 'same', 'h', '1', 'a long enough text', 1, 1)`).bind(id).run();
  await ins('a'); await assert.rejects(ins('b'), /UNIQUE/);
  await assert.rejects(env.DB.prepare(`UPDATE roblox_reports SET status = 'bogus' WHERE id = 'a'`).run(), /CHECK/);
});

test('unauthorised access: the dashboard API is closed to everyone but the owner, and closed completely when no owner is configured', async () => {
  const env = await newEnv();
  const paths = ['/api/owner/session', '/api/owner/roblox/games', '/api/owner/roblox/games/jetbreak/reports', '/api/owner/roblox/games/jetbreak/keys'];
  for (const p of paths) assert.equal((await call(env, 'GET', p)).status, 401, 'anonymous ' + p);
  const nodiscord = await addUser(env, { name: 'Plain' }), other = await addUser(env, { name: 'Other', discord: OTHER_DISCORD }), admin = await addUser(env, { name: 'Moderator', discord: OTHER_DISCORD + '1', admin: 1 });
  for (const who of [nodiscord, other, admin]) for (const p of paths) assert.equal((await call(env, 'GET', p, { cookie: who.token })).status, 403, 'non-owner ' + p);
  // a banned owner is out as well
  const env2 = await newEnv({ OWNER_DISCORD_ID: '555555555555555555' }); const b2 = await addUser(env2, { name: 'B', discord: '555555555555555555', status: 'banned' });
  assert.ok([401, 403].includes((await call(env2, 'GET', paths[0], { cookie: b2.token })).status));
  // fail closed: the real owner gets nothing while OWNER_DISCORD_ID is unset or malformed
  for (const bad of [undefined, '', '   ', 'not-a-number', '12']) {
    const e = await newEnv({ OWNER_DISCORD_ID: bad }); const u = await addUser(e, { name: 'Kuro', discord: OWNER_DISCORD, admin: 1 });
    assert.equal((await call(e, 'GET', paths[0], { cookie: u.token })).status, 403, 'unset/bad owner id: ' + bad);
  }
  // a game key is not a login
  const own = await owner(env), key = await makeKey(own);
  for (const p of paths) assert.equal((await call(env, 'GET', p, { headers: { 'x-jetbreak-report-key': key } })).status, 401, 'game key on ' + p);
  assert.equal(own.csrf.length, 64);
  // /api/me tells the page whether to show the Admin entry; only the owner's session says isOwner
  const A = require('../../accounts/accounts.js');
  const me = async (env_, tok) => (await (await A.handleAccounts(new Request(ORIGIN + '/api/me', { headers: { cookie: 'kl_session=' + tok, 'cf-connecting-ip': '1.1.1.1' } }), env_)).json()).user;
  assert.equal((await me(env, own.user.token)).isOwner, true);
  assert.equal((await me(env, other.token)).isOwner, false);
  assert.equal((await me(env, admin.token)).isOwner, false);
});

test('owner changes need the same-origin check AND the session-bound CSRF token', async () => {
  const env = await newEnv(), own = await owner(env), key = await makeKey(own);
  const created = await submit(env, key, goodBody()); assert.equal(created.status, 201);
  const url = '/api/owner/roblox/reports/' + created.json.reportId;
  assert.equal((await call(env, 'POST', url, { cookie: own.user.token, body: { status: 'fixed' } })).status, 403, 'no token');
  assert.equal((await call(env, 'POST', url, { cookie: own.user.token, csrf: 'f'.repeat(64), body: { status: 'fixed' } })).status, 403, 'wrong token');
  assert.equal((await call(env, 'POST', url, { cookie: own.user.token, csrf: own.csrf, origin: 'https://evil.example', body: { status: 'fixed' } })).status, 403, 'other origin');
  assert.equal((await call(env, 'POST', url, { cookie: own.user.token, csrf: own.csrf, origin: null, body: { status: 'fixed' } })).status, 403, 'no origin and no fetch metadata');
  assert.equal((await call(env, 'POST', url, { cookie: own.user.token, csrf: own.csrf, origin: null, headers: { 'sec-fetch-site': 'cross-site' }, body: { status: 'fixed' } })).status, 403, 'cross-site fetch');
  const other = await addUser(env, { name: 'Other', discord: OTHER_DISCORD });
  assert.equal((await call(env, 'POST', url, { cookie: other.token, csrf: own.csrf, body: { status: 'fixed' } })).status, 403, "someone else, even with the owner's token");
  assert.equal((await own.get(url)).json.report.status, 'new', 'nothing changed');
  assert.equal((await own.post(url, { status: 'fixed' })).status, 200);
});

test('game credentials: a key submits only for its own game and can do nothing else; keys are stored as hashes, shown once, and can be revoked', async () => {
  const env = await newEnv(); await addGame(env, 'otherquest', 'Other Quest');
  const own = await owner(env), kJet = await makeKey(own, 'jetbreak'), kOther = await makeKey(own, 'otherquest');
  assert.notEqual(kJet, kOther); assert.match(kJet, /^rbxk_[A-Za-z0-9_-]{43}$/);
  assert.equal((await submit(env, kJet, goodBody())).status, 201);
  assert.equal((await submit(env, kOther, goodBody({ gameKey: 'otherquest' }))).status, 201);
  assert.equal((await submit(env, kJet, goodBody({ gameKey: 'otherquest' }))).json.error, 'game_mismatch');       // gameKey alone is not trusted
  assert.equal((await submit(env, kOther, goodBody({ gameKey: 'jetbreak' }))).status, 403);
  assert.equal((await submit(env, kJet, goodBody({ gameKey: 'nonexistent' }))).status, 403);
  assert.equal((await submit(env, kJet, { ...goodBody(), gameKey: undefined })).status, 400);
  assert.equal(await count(env, `SELECT COUNT(*) AS n FROM roblox_reports WHERE game_key = 'otherquest'`), 1);
  // missing / malformed / unknown keys, and the alternative header name
  assert.equal((await submit(env, null, goodBody())).json.error, 'missing_key');
  assert.equal((await submit(env, 'nope', goodBody())).json.error, 'invalid_key');
  assert.equal((await submit(env, 'rbxk_' + 'A'.repeat(43), goodBody())).json.error, 'invalid_key');
  assert.equal((await call(env, 'POST', '/api/roblox-reports', { headers: { 'x-report-key': kJet }, body: goodBody(), origin: null })).status, 201);
  // a key cannot read: there is no read route for it, and a GET is refused outright
  for (const m of ['GET', 'PUT', 'DELETE']) { const r = await call(env, m, '/api/roblox-reports', { headers: { 'x-jetbreak-report-key': kJet }, origin: null }); assert.equal(r.status, 405); assert.equal(r.headers.get('allow'), 'POST'); }
  // only the hash is stored; the key is never listed
  const rows = (await env.DB.prepare('SELECT key_hash FROM roblox_game_keys').all()).results.map(r => r.key_hash);
  assert.ok(rows.every(h => /^[0-9a-f]{64}$/.test(h)) && !rows.includes(kJet));
  const listed = await own.get('/api/owner/roblox/games/jetbreak/keys'); assert.ok(!listed.text.includes(kJet) && !/key_hash|keyHash/.test(listed.text));
  assert.equal(listed.json.keys.length, 1);
  assert.ok(listed.json.keys[0].lastUsedAt > 0);
  // revoke: the old key dies immediately, a replacement works, and revoking the wrong game's key id does nothing
  assert.equal((await own.post(`/api/owner/roblox/games/otherquest/keys/${listed.json.keys[0].id}/revoke`, {})).status, 404);
  assert.equal((await submit(env, kJet, goodBody())).status, 201, 'still alive after the wrong-game attempt');
  assert.equal((await own.post(`/api/owner/roblox/games/jetbreak/keys/${listed.json.keys[0].id}/revoke`, {})).status, 200);
  assert.equal((await submit(env, kJet, goodBody())).status, 401);
  assert.equal((await own.post(`/api/owner/roblox/games/jetbreak/keys/${listed.json.keys[0].id}/revoke`, {})).status, 404, 'already revoked');
  assert.equal((await submit(env, await makeKey(own, 'jetbreak', 'rotated'), goodBody())).status, 201);
  assert.equal(await count(env, `SELECT COUNT(*) AS n FROM admin_log WHERE action LIKE 'roblox_key_%'`), 4, 'key changes are logged: 3 created + 1 revoked');
  assert.equal((await own.post('/api/owner/roblox/games/nosuchgame/keys', {})).status, 404);
});

test('validation: the documented limits, types and unknown fields are enforced, and errors stay machine-readable without leaking anything', async () => {
  const env = await newEnv(), own = await owner(env), key = await makeKey(own);
  const savedLimit = R.KEY_PER_MINUTE; R.KEY_PER_MINUTE = 1000;
  try {
    const err = async (body, status, code, field) => {
      const r = await submit(env, key, body); assert.equal(r.status, status, String(JSON.stringify(body)).slice(0, 80) + ' -> ' + r.text);
      assert.equal(r.json.ok, false); assert.equal(r.json.error, code);
      if (field) assert.ok(r.json.details.some(d => d.field === field), r.text);
      assert.ok(!/stack|node_modules|rbxk_|\.js:\d/.test(r.text)); return r;
    };
    const ok = async (body) => { const r = await submit(env, key, body); assert.equal(r.status, 201, r.text); assert.match(r.json.reportId, /^rpt_[A-Za-z0-9_-]{22}$/); return r; };
    await ok(goodBody()); await ok(goodBody({ steps: undefined, expected: undefined, actual: undefined, context: undefined })); await ok(goodBody({ steps: null, expected: '', actual: '   ' }));
    await ok(goodBody({ description: 'x'.repeat(10) })); await ok(goodBody({ description: 'x'.repeat(2000), steps: 'y'.repeat(2000), expected: 'z'.repeat(1000), actual: 'w'.repeat(1000) }));
    await ok(goodBody({ description: '😀'.repeat(2000) }));                                   // characters, not bytes or UTF-16 units
    await ok(goodBody({ context: { placeId: 0, universeId: 0, viewportWidth: 0, viewportHeight: 0 } }));
    await ok(goodBody({ submissionId: uuid().toUpperCase() }));
    await err(goodBody({ description: undefined }), 400, 'validation_failed', 'description');
    await err(goodBody({ description: 'too short' }), 400, 'validation_failed', 'description');
    await err(goodBody({ description: '         short         ' }), 400, 'validation_failed', 'description');
    await err(goodBody({ description: 'x'.repeat(2001) }), 400, 'validation_failed', 'description');
    await err(goodBody({ description: '😀'.repeat(2001) }), 400, 'validation_failed', 'description');
    await err(goodBody({ steps: 'x'.repeat(2001) }), 400, 'validation_failed', 'steps');
    await err(goodBody({ expected: 'x'.repeat(1001) }), 400, 'validation_failed', 'expected');
    await err(goodBody({ actual: 'x'.repeat(1001) }), 400, 'validation_failed', 'actual');
    await err(goodBody({ description: 12345678901 }), 400, 'validation_failed', 'description');
    await err(goodBody({ steps: ['a'] }), 400, 'validation_failed', 'steps');
    await err(goodBody({ submissionId: 'not-a-uuid' }), 400, 'validation_failed', 'submissionId');
    await err(goodBody({ submissionId: '{' + uuid() + '}' }), 400, 'validation_failed', 'submissionId');
    await err(goodBody({ submissionId: undefined }), 400, 'validation_failed', 'submissionId');
    await err(goodBody({ gameKey: 'Bad Key!' }), 403, 'game_mismatch');                         // anything but this key's own game is refused
    await err(goodBody({ buildVersion: undefined }), 400, 'validation_failed', 'buildVersion');
    await err(goodBody({ buildVersion: '' }), 400, 'validation_failed', 'buildVersion');
    await err(goodBody({ buildVersion: 'v'.repeat(65) }), 400, 'validation_failed', 'buildVersion');
    await err(goodBody({ buildVersion: '1.0' + ch(0x202e) }), 400, 'validation_failed', 'buildVersion');
    await err(goodBody({ schemaVersion: 2 }), 400, 'unsupported_schema');
    await err(goodBody({ schemaVersion: '1' }), 400, 'unsupported_schema');
    await err({ ...goodBody(), schemaVersion: undefined }, 400, 'unsupported_schema');
    await err({ ...goodBody(), isAdmin: true }, 400, 'validation_failed', 'isAdmin');
    await err({ ...goodBody(), userId: 5 }, 400, 'validation_failed', 'userId');
    await err(goodBody({ context: 'x' }), 400, 'validation_failed', 'context');
    await err(goodBody({ context: [1] }), 400, 'validation_failed', 'context');
    await err(goodBody({ context: { playerName: 'Bob' } }), 400, 'validation_failed', 'context.playerName');
    await err(goodBody({ context: { placeId: -1 } }), 400, 'validation_failed', 'context.placeId');
    await err(goodBody({ context: { placeId: 1.5 } }), 400, 'validation_failed', 'context.placeId');
    await err(goodBody({ context: { placeId: '5' } }), 400, 'validation_failed', 'context.placeId');
    await err(goodBody({ context: { viewportWidth: 20001 } }), 400, 'validation_failed', 'context.viewportWidth');
    await err(goodBody({ context: { platform: 'p'.repeat(33) } }), 400, 'validation_failed', 'context.platform');
    await err(goodBody({ context: { platform: 5 } }), 400, 'validation_failed', 'context.platform');
    // not JSON / wrong shapes / wrong content type / too big
    await err(undefined, 415, 'unsupported_media_type');                                                          // no body, no content type
    assert.equal((await submit(env, key, undefined, { raw: '{"a":' })).json.error, 'invalid_json');
    assert.equal((await submit(env, key, undefined, { raw: '[]' })).json.error, 'invalid_json');
    assert.equal((await submit(env, key, undefined, { raw: 'null' })).json.error, 'invalid_json');
    assert.equal((await submit(env, key, undefined, { raw: '' })).json.error, 'invalid_json');
    assert.equal((await submit(env, key, undefined, { raw: JSON.stringify(goodBody()), type: 'text/plain' })).status, 415);
    const big = await submit(env, key, undefined, { raw: JSON.stringify({ ...goodBody(), description: 'x'.repeat(R.MAX_BODY_BYTES) }) }); assert.equal(big.status, 413); assert.equal(big.json.error, 'payload_too_large');
    // a body that lies about its size is still cut off while it is being read
    const sneaky = await submit(env, key, undefined, { raw: JSON.stringify({ ...goodBody(), description: 'x'.repeat(R.MAX_BODY_BYTES) }), headers: { 'x-jetbreak-report-key': key, 'content-length': '10' } });
    assert.ok([400, 413].includes(sneaky.status), 'sneaky ' + sneaky.status);
    // unusual characters are cleaned, not trusted: control characters vanish, markup is kept as plain text
    const weird = await submit(env, key, goodBody({ description: 'Bad' + ch(0) + ' <script>alert(1)</script> text\r\nline two ' + ch(0xd800) + ' end' })); assert.equal(weird.status, 201);
    const row = await env.DB.prepare('SELECT description FROM roblox_reports WHERE id = ?').bind(weird.json.reportId).first();
    assert.equal(row.description, 'Bad <script>alert(1)</script> text\nline two ' + ch(0xfffd) + ' end');
    // nothing invalid was stored: only the accepted ones above
    assert.equal(await count(env), 9);
  } finally { R.KEY_PER_MINUTE = savedLimit; }
});

test('duplicate retries return the same report; conflicting reuse is rejected; the same id for another game is independent', async () => {
  const env = await newEnv(); await addGame(env, 'otherquest', 'Other Quest');
  const own = await owner(env), kJet = await makeKey(own, 'jetbreak'), kOther = await makeKey(own, 'otherquest');
  const body = goodBody(), a = await submit(env, kJet, body); assert.equal(a.status, 201);
  const b = await submit(env, kJet, { ...body }); assert.equal(b.status, 200); assert.equal(b.json.reportId, a.json.reportId); assert.equal(b.json.duplicate, true);
  const c = await submit(env, kJet, { ...body, submissionId: body.submissionId.toUpperCase() }); assert.equal(c.json.reportId, a.json.reportId);     // GUID case does not matter
  assert.equal(await count(env), 1);
  const conflict = await submit(env, kJet, { ...body, description: 'A completely different description.' }); assert.equal(conflict.status, 409); assert.equal(conflict.json.error, 'submission_conflict');
  assert.equal((await submit(env, kJet, { ...body, context: { placeId: 999 } })).status, 409);
  assert.equal((await submit(env, kJet, { ...body, buildVersion: '9.9' })).status, 409);
  assert.equal(await count(env), 1);
  const o = await submit(env, kOther, { ...body, gameKey: 'otherquest' }); assert.equal(o.status, 201); assert.notEqual(o.json.reportId, a.json.reportId);
  // concurrent retries (the unique constraint decides): exactly one row, everyone gets the same id
  const b2 = goodBody(), results = await Promise.all(Array.from({ length: 8 }, () => submit(env, kJet, b2)));
  assert.ok(results.every(r => r.status === 201 || r.status === 200)); assert.equal(new Set(results.map(r => r.json.reportId)).size, 1);
  assert.equal(results.filter(r => r.status === 201).length, 1); assert.equal(await count(env), 3);
});

test('rate limits: per game key, and wrong-key guessing from one address is braked', async () => {
  const env = await newEnv(), own = await owner(env), key = await makeKey(own);
  const saved = R.KEY_PER_MINUTE; R.KEY_PER_MINUTE = 3;
  try {
    for (let i = 0; i < 3; i++) assert.equal((await submit(env, key, goodBody())).status, 201);
    const r = await submit(env, key, goodBody()); assert.equal(r.status, 429); assert.equal(r.json.error, 'rate_limited'); assert.equal(r.headers.get('retry-after'), '60');
    assert.equal(await count(env), 3, 'the rejected one was not stored');
    const other = await makeKey(own, 'jetbreak', 'second');
    assert.equal((await submit(env, other, goodBody())).status, 201, 'another key has its own budget');
  } finally { R.KEY_PER_MINUTE = saved; }
  const env2 = await newEnv(); let last;
  for (let i = 0; i < R.BAD_KEY_PER_15MIN + 3; i++) last = await submit(env2, 'rbxk_' + 'B'.repeat(43), goodBody(), { ip: '198.51.100.20' });
  assert.equal(last.status, 429); assert.ok(Number(last.headers.get('retry-after')) > 0);
  assert.equal((await submit(env2, 'rbxk_' + 'B'.repeat(43), goodBody(), { ip: '198.51.100.21' })).status, 401, 'another address is not affected');
  const saved2 = R.KEYS_CREATED_PER_HOUR; R.KEYS_CREATED_PER_HOUR = 2;
  try { const e3 = await newEnv(), o3 = await owner(e3); await makeKey(o3); await makeKey(o3); assert.equal((await o3.post('/api/owner/roblox/games/jetbreak/keys', {})).status, 429); } finally { R.KEYS_CREATED_PER_HOUR = saved2; }
});

test('the inbox: newest first, paginated, filtered by status, searched safely, with counts', async () => {
  const env = await newEnv(), own = await owner(env), key = await makeKey(own);
  const base = Date.now() - 60 * MS.MINUTE; const ids = [];
  for (let i = 0; i < 7; i++) {
    const r = await submit(env, key, goodBody({ description: `Report number ${i} about ${i % 2 ? 'wings' : 'engines'}`, buildVersion: i < 4 ? '0.1.0' : '0.2.0' })); ids.push(r.json.reportId);
    await env.DB.prepare('UPDATE roblox_reports SET created_at = ? WHERE id = ?').bind(base + i * MS.MINUTE, r.json.reportId).run();
  }
  await own.post('/api/owner/roblox/reports/' + ids[0], { status: 'fixed', fixedInVersion: '0.2.0' }); await own.post('/api/owner/roblox/reports/' + ids[1], { status: 'investigating' });
  const list = async (qs) => { const r = await own.get('/api/owner/roblox/games/jetbreak/reports' + (qs || '')); assert.equal(r.status, 200, r.text); return r.json; };
  let j = await list(); assert.equal(j.total, 7); assert.deepEqual(j.reports.map(r => r.id), [...ids].reverse()); assert.deepEqual(j.counts, { new: 5, investigating: 1, fixed: 1, closed: 0 }); assert.equal(j.game.name, 'JetBreak');
  j = await list('?pageSize=3'); assert.equal(j.pages, 3); assert.equal(j.reports.length, 3);
  const p3 = await list('?pageSize=3&page=3'); assert.equal(p3.reports.length, 1); assert.equal(p3.reports[0].id, ids[0]);
  assert.equal((await list('?pageSize=3&page=9')).reports.length, 0);
  j = await list('?status=new'); assert.equal(j.total, 5); assert.ok(j.reports.every(r => r.status === 'new'));
  j = await list('?status=fixed'); assert.equal(j.reports[0].fixedInVersion, '0.2.0');
  j = await list('?q=wings'); assert.equal(j.total, 3);
  j = await list('?q=WINGS&status=new'); assert.equal(j.total, 2);
  j = await list('?q=0.2.0'); assert.equal(j.total, 4);                                  // build version (and fixed-in) are searchable
  j = await list('?q=' + encodeURIComponent(ids[3])); assert.equal(j.total, 1);          // by report id
  j = await list('?q=' + encodeURIComponent('%')); assert.equal(j.total, 0, 'a % in the search is literal');
  j = await list('?q=' + encodeURIComponent('_____')); assert.equal(j.total, 0, '_ is literal too');
  j = await list('?q=' + encodeURIComponent("'; DROP TABLE roblox_reports; --")); assert.equal(j.total, 0); assert.equal(await count(env), 7);
  for (const bad of ['?status=bogus', '?page=0', '?page=x', '?pageSize=0', '?pageSize=101', '?q=' + 'x'.repeat(101)]) assert.equal((await own.get('/api/owner/roblox/games/jetbreak/reports' + bad)).status, 400, bad);
  assert.equal((await own.get('/api/owner/roblox/games/nosuch/reports')).status, 404);
  const g = (await own.get('/api/owner/roblox/games')).json.games; assert.equal(g.length, 1);
  assert.deepEqual(g[0], { key: 'jetbreak', name: 'JetBreak', total: 7, counts: { new: 5, investigating: 1, fixed: 1, closed: 0 }, lastReportAt: base + 6 * MS.MINUTE, activeKeys: 1 });
});

test('status, notes and fixed-in version persist, with who and when; bad changes and stale edits are refused', async () => {
  const env = await newEnv(), own = await owner(env), key = await makeKey(own);
  const created = await submit(env, key, goodBody()), id = created.json.reportId, url = '/api/owner/roblox/reports/' + id;
  let r = (await own.get(url)).json.report;
  assert.equal(r.status, 'new'); assert.equal(r.description, 'The jet stops responding after I respawn.'); assert.equal(r.buildVersion, '0.4.2');
  assert.deepEqual(r.context, { placeId: 111, universeId: 222, platform: 'Windows', viewportWidth: 1920, viewportHeight: 1080 }); assert.deepEqual(r.history, []); assert.equal(r.updatedBy, null); assert.equal(r.ownerNotes, '');
  const t0 = r.updatedAt;
  const up = await own.post(url, { status: 'investigating', ownerNotes: 'Repro on my PC.\nCheck respawn handler.', expectedUpdatedAt: t0 }); assert.equal(up.status, 200, up.text); assert.equal(up.json.changed, true);
  const reread = (await own.get(url)).json.report;                                                                    // a fresh read, not the echo
  assert.equal(reread.status, 'investigating'); assert.equal(reread.ownerNotes, 'Repro on my PC.\nCheck respawn handler.'); assert.equal(reread.updatedBy, 'Kuro'); assert.ok(reread.updatedAt >= t0);
  assert.equal(reread.history.length, 1); assert.equal(reread.history[0].by, 'Kuro'); assert.deepEqual(reread.history[0].changes, { status: ['new', 'investigating'], notes: true });
  assert.ok(!JSON.stringify(reread.history).includes('Repro on my PC'), 'the history keeps what changed, not private notes');
  assert.equal((await own.post(url, { status: 'fixed', fixedInVersion: '0.4.3' })).json.report.status, 'fixed');
  const row = await env.DB.prepare('SELECT status, fixed_in_version, updated_by, updated_by_name, owner_notes FROM roblox_reports WHERE id = ?').bind(id).first();
  assert.deepEqual({ ...row }, { status: 'fixed', fixed_in_version: '0.4.3', updated_by: own.user.id, updated_by_name: 'Kuro', owner_notes: 'Repro on my PC.\nCheck respawn handler.' });
  assert.equal((await own.get('/api/owner/roblox/games')).json.games[0].counts.fixed, 1);
  // nothing to change: no write, no history entry
  const same = await own.post(url, { status: 'fixed', fixedInVersion: '0.4.3' }); assert.equal(same.json.changed, false); assert.equal((await own.get(url)).json.report.history.length, 2);
  // clearing the fixed-in version, closing, reopening
  assert.equal((await own.post(url, { fixedInVersion: '' })).json.report.fixedInVersion, null); assert.equal((await own.post(url, { status: 'closed' })).json.report.status, 'closed'); assert.equal((await own.post(url, { status: 'new' })).json.report.status, 'new');
  // refused
  for (const [b, f] of [[{ status: 'done' }, 'status'], [{ status: 5 }, 'status'], [{ ownerNotes: 'x'.repeat(5001) }, 'ownerNotes'], [{ ownerNotes: {} }, 'ownerNotes'], [{ fixedInVersion: 'v'.repeat(65) }, 'fixedInVersion'], [{ fixedInVersion: 5 }, 'fixedInVersion'], [{ description: 'rewritten' }, 'description'], [{ gameKey: 'x' }, 'gameKey']]) {
    const x = await own.post(url, b); assert.equal(x.status, 400, JSON.stringify(b)); assert.ok(x.json.details.some(d => d.field === f));
  }
  assert.equal((await own.get(url)).json.report.description, 'The jet stops responding after I respawn.', 'player text cannot be edited');
  const stale = await own.post(url, { status: 'fixed', expectedUpdatedAt: t0 - 1 }); assert.equal(stale.status, 409); assert.equal(stale.json.error, 'stale'); assert.equal(stale.json.report.status, 'new');
  assert.equal((await own.get('/api/owner/roblox/reports/rpt_' + 'A'.repeat(22))).status, 404);
  assert.equal((await own.get('/api/owner/roblox/reports/..%2F..%2Fsession')).status, 404);
  assert.equal((await own.post('/api/owner/roblox/reports/nope', { status: 'new' })).status, 404);
  assert.equal((await own.post(url, undefined, { raw: 'not json' })).status, 400);
  assert.equal((await own.post(url, undefined, { raw: '{}', type: 'text/plain' })).status, 415);
  assert.equal((await own.post(url, {})).json.changed, false);
  // the history survives the owner account being deleted (the name is kept, the link is cleared)
  await env.DB.prepare('DELETE FROM users WHERE id = ?').bind(own.user.id).run();
  assert.equal((await env.DB.prepare('SELECT updated_by FROM roblox_reports WHERE id = ?').bind(id).first()).updated_by, null);
  assert.equal(await count(env, 'SELECT COUNT(*) AS n FROM roblox_report_events'), 5);
  assert.equal(await count(env, 'SELECT COUNT(*) AS n FROM roblox_report_events WHERE actor_name = ' + "'Kuro'"), 5);
});

test('player text is only ever data: the API returns it verbatim as JSON (never HTML), and the dashboard code has no HTML-injection paths', async () => {
  const env = await newEnv(), own = await owner(env), key = await makeKey(own);
  const nasty = '<img src=x onerror=alert(1)> <script>alert(2)</script> "quotes" \'single\' &amp; `tick` ${x} {{y}} javascript:alert(3)';
  const r = await submit(env, key, goodBody({ description: nasty, steps: nasty, expected: nasty, actual: nasty, buildVersion: '1.0 <b>', context: { platform: '<i>win' } })); assert.equal(r.status, 201);
  const d = await own.get('/api/owner/roblox/reports/' + r.json.reportId);
  assert.equal(d.headers.get('content-type'), 'application/json; charset=utf-8'); assert.equal(d.headers.get('x-content-type-options'), 'nosniff'); assert.equal(d.headers.get('cache-control'), 'no-store');
  assert.equal(d.json.report.description, nasty); assert.equal(d.json.report.context.platform, '<i>win'); assert.equal(d.json.report.buildVersion, '1.0 <b>');
  const list = await own.get('/api/owner/roblox/games/jetbreak/reports'); assert.equal(list.headers.get('content-type'), 'application/json; charset=utf-8');
  assert.equal((await own.post('/api/owner/roblox/reports/' + r.json.reportId, { ownerNotes: nasty })).json.report.ownerNotes, nasty);
  const ui = fs.readFileSync(path.join(__dirname, '../../../public/assets/owner-dashboard.js'), 'utf8');
  for (const bad of [/\.innerHTML\b/, /\.outerHTML\b/, /insertAdjacentHTML/, /document\.write/, /\beval\s*\(/, /new Function/, /\bhtml\s*:/, /\.srcdoc/, /setAttribute\(\s*['"]on/i, /\.href\s*=/, /location\s*=/]) assert.ok(!bad.test(ui), 'dashboard code must not use ' + bad);
  assert.ok(/textContent|createTextNode|kit\.el/.test(ui));
});

test('retention: old fixed/closed and very old open reports are deleted nightly; the limits are configurable', async () => {
  const env = await newEnv(), own = await owner(env), key = await makeKey(own), now = Date.now(), mk = async (status, created, updated) => {
    const r = await submit(env, key, goodBody()); await env.DB.prepare('UPDATE roblox_reports SET status = ?, created_at = ?, updated_at = ? WHERE id = ?').bind(status, created, updated, r.json.reportId).run(); return r.json.reportId; };
  await mk('closed', now - 400 * MS.DAY, now - 200 * MS.DAY); await mk('fixed', now - 400 * MS.DAY, now - 181 * MS.DAY);
  const recentFixed = await mk('fixed', now - 400 * MS.DAY, now - 10 * MS.DAY);
  await mk('new', now - 366 * MS.DAY, now - 366 * MS.DAY);
  const midNew = await mk('investigating', now - 200 * MS.DAY, now - 200 * MS.DAY), freshNew = await mk('new', now - MS.DAY, now - MS.DAY);
  const out = await reports.runCleanup(env, now); assert.deepEqual({ ...out }, { closedReports: 2, openReports: 1, keys: 0 });
  const left = (await env.DB.prepare('SELECT id FROM roblox_reports').all()).results.map(x => x.id).sort(); assert.deepEqual(left, [recentFixed, midNew, freshNew].sort());
  Object.assign(env, { REPORT_RETENTION_DAYS: '5', REPORT_RETENTION_OPEN_DAYS: '100' });
  assert.deepEqual({ ...(await reports.runCleanup(env, now)) }, { closedReports: 1, openReports: 1, keys: 0 });
  assert.deepEqual((await env.DB.prepare('SELECT id FROM roblox_reports').all()).results.map(x => x.id), [freshNew]);
  await env.DB.prepare('UPDATE roblox_game_keys SET revoked_at = ?').bind(now - 31 * MS.DAY).run(); assert.equal((await reports.runCleanup(env, now)).keys, 1);
  assert.deepEqual(await reports.runCleanup({}), { skipped: 'no database yet' });
});

test('routing: other paths are not ours, and without a database everything says "not available" instead of crashing', async () => {
  const env = await newEnv();
  for (const p of ['/api/me', '/api/report', '/api/roblox-reports/extra', '/shop/', '/api/owner']) assert.equal(await call(env, 'GET', p), null, p);
  const r = await reports.handle(new Request(ORIGIN + '/api/roblox-reports', { method: 'POST' }), {}); assert.equal(r.status, 503);
  const r2 = await reports.handle(new Request(ORIGIN + '/api/owner/session'), {}); assert.equal(r2.status, 503);
  assert.equal((await call(env, 'GET', '/api/owner/nothing', { cookie: (await owner(env)).user.token })).status, 404);
});

(async () => {
  let failed = 0;
  for (const [name, fn] of tests) { try { await fn(); console.log('ok - ' + name); } catch (e) { failed++; console.log('FAIL - ' + name + '\n' + (e && e.stack || e)); } }
  if (failed) { console.log(failed + ' of ' + tests.length + ' failed'); process.exit(1); }
  console.log(tests.length + ' report tests passed');
})();
