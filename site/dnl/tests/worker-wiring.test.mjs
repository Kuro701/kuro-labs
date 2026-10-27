// Checks site/worker.js itself: it still parses, exports the Durable Object class, sends /api/dnl/* to the
// room routes, and lets every other request (and /api/sales-count) go through untouched.
// Run with: node site/dnl/tests/worker-wiring.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { register } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const siteDir = path.resolve(here, '..', '..');

// "cloudflare:workers" only exists on Cloudflare
register('data:text/javascript,' + encodeURIComponent(`
export async function resolve(s, c, n) { if (s === 'cloudflare:workers') return { url: 'cf-shim:workers', shortCircuit: true }; return n(s, c); }
export async function load(u, c, n) { if (u === 'cf-shim:workers') return { format: 'module', shortCircuit: true, source: 'export class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }' }; return n(u, c); }`), import.meta.url);
globalThis.WebSocketRequestResponsePair = class {};

// import a temporary copy of worker.js (same code, but as .mjs and with absolute import paths)
let src = fs.readFileSync(path.join(siteDir, 'worker.js'), 'utf8');
src = src.replace(/from '\.\/(dnl|accounts|reports)\/([^']+)'/g, (m, d, f) => `from '${pathToFileURL(path.join(siteDir, d, f)).href}'`);
const tmp = path.join(os.tmpdir(), 'kl-worker-under-test-' + process.pid + '.mjs');
fs.writeFileSync(tmp, src);
const mod = await import(pathToFileURL(tmp).href);
fs.rmSync(tmp, { force: true });

let n = 0;
const test = async (name, fn) => { await fn(); n++; console.log('ok -', name); };
const ctx = { waitUntil() {} };
const assets = { fetch: async req => new Response('ASSET ' + new URL(req.url).pathname, { status: 200 }) };

await test('the Durable Object class is exported under the name wrangler.jsonc binds', () => {
  assert.equal(typeof mod.DnlRoom, 'function'); assert.equal(mod.DnlRoom.name, 'DnlRoom');
  assert.equal(typeof mod.default.fetch, 'function');
});
await test('normal pages still come straight from the assets binding', async () => {
  for (const p of ['/', '/games/', '/games/dragons-and-ladders/', '/assets/site.js', '/api/other']) {
    const r = await mod.default.fetch(new Request('https://kurolabs.net' + p), { ASSETS: assets, DNL_ROOMS: {} }, ctx);
    assert.equal(await r.text(), 'ASSET ' + p);
  }
});
await test('/api/dnl/* is handled by the room routes (503 when the binding is missing, 400 for a bad code)', async () => {
  const none = await mod.default.fetch(new Request('https://kurolabs.net/api/dnl/room', { method: 'POST' }), { ASSETS: assets }, ctx);
  assert.equal(none.status, 503); assert.deepEqual(await none.json(), { error: 'unavailable' });
  const bad = await mod.default.fetch(new Request('https://kurolabs.net/api/dnl/room/!!'), { ASSETS: assets, DNL_ROOMS: {} }, ctx);
  assert.equal(bad.status, 400);
});
await test('/api/sales-count is still answered by its own handler (not by the rooms)', async () => {
  globalThis.caches = { default: { match: async () => undefined, put: async () => {} } };
  const r = await mod.default.fetch(new Request('https://kurolabs.net/api/sales-count'), { ASSETS: assets }, ctx);
  assert.equal(r.status, 500); assert.deepEqual(await r.json(), { ok: false, error: 'not configured' });   // no token in this test env
});
await test('accounts routes are wired: config answers "closed" without a database; the cron handler exists and is safe without one', async () => {
  const r = await mod.default.fetch(new Request('https://kurolabs.net/api/auth/config'), { ASSETS: assets }, ctx);
  assert.equal(r.status, 200); assert.deepEqual(await r.json(), { ok: true, enabled: false });
  const me = await mod.default.fetch(new Request('https://kurolabs.net/api/me'), { ASSETS: assets }, ctx); assert.equal(me.status, 503);
  const other = await mod.default.fetch(new Request('https://kurolabs.net/api/mentions'), { ASSETS: assets }, ctx); assert.equal(await other.text(), 'ASSET /api/mentions');
  let waited; await mod.default.scheduled({}, { ASSETS: assets }, { waitUntil: p => { waited = p; } }); assert.deepEqual(await waited, { skipped: 'no database yet' });
});
await test('Roblox report routes are wired: closed without a database, and with one the game door wants a key and the owner door wants a login', async () => {
  const none = await mod.default.fetch(new Request('https://kurolabs.net/api/roblox-reports', { method: 'POST' }), { ASSETS: assets }, ctx); assert.equal(none.status, 503); assert.equal((await none.json()).error, 'unavailable');
  const own = await mod.default.fetch(new Request('https://kurolabs.net/api/owner/session'), { ASSETS: assets }, ctx); assert.equal(own.status, 503);
  const { D1Shim } = (await import('node:module')).createRequire(import.meta.url)('../../accounts/tests/d1-shim.js'); const env = { ASSETS: assets, DB: new D1Shim(), OWNER_DISCORD_ID: '123456789012345678' };
  const noKey = await mod.default.fetch(new Request('https://kurolabs.net/api/roblox-reports', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }), env, ctx); assert.equal(noKey.status, 401); assert.equal((await noKey.json()).error, 'missing_key');
  const anon = await mod.default.fetch(new Request('https://kurolabs.net/api/owner/roblox/games'), env, ctx); assert.equal(anon.status, 401);
  const waits = []; await mod.default.scheduled({}, env, { waitUntil: p => waits.push(p) }); assert.equal(waits.length, 2); const [, rep] = await Promise.all(waits); assert.deepEqual(rep, { closedReports: 0, openReports: 0, keys: 0 });
});
console.log(`\n${n} wiring tests passed`);
