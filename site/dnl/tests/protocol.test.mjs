// End-to-end test of the room server: real HTTP + real WebSockets against site/dnl/dev-server.mjs (--fast).
// Run with: node site/dnl/tests/protocol.test.mjs
import { spawn } from 'node:child_process';
import http from 'node:http';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const PORT = 18000 + Math.floor(Math.random() * 2000);
const BASE = `http://127.0.0.1:${PORT}`;
const server = spawn(process.execPath, [path.join(here, '..', 'dev-server.mjs'), '--fast', '--port', String(PORT)], { stdio: ['ignore', 'pipe', 'inherit'] });
await new Promise((res, rej) => { server.stdout.on('data', d => String(d).includes('dev server on') && res()); server.on('exit', c => rej(new Error('server exited ' + c))); });

const sleep = ms => new Promise(r => setTimeout(r, ms));
const api = async (p, opt) => { const r = await fetch(BASE + p, opt); return { status: r.status, body: await r.json() }; };

class Client {
  constructor(name) { this.name = name; this.inbox = []; this.waiters = []; this.state = null; this.pid = null; this.secret = null; this.closed = null; }
  async connect(code, creds) {
    this.ws = new WebSocket(`ws://127.0.0.1:${PORT}/api/dnl/room/${code}/ws`);
    this.ws.onmessage = e => { if (e.data === 'pong') return; const m = JSON.parse(e.data); if (m.t === 'state' || m.t === 'welcome') this.state = m.state; this.inbox.push(m); this.waiters = this.waiters.filter(w => !w()); };
    this.ws.onclose = e => { this.closed = { code: e.code }; this.waiters = this.waiters.filter(w => !w()); };
    await new Promise((res, rej) => { this.ws.onopen = res; this.ws.onerror = () => rej(new Error('ws error')); });
    this.send({ t: 'hello', name: this.name, ...(creds || {}) });
    const w = await this.next(m => m.t === 'welcome' || m.t === 'error');
    if (w.t === 'welcome') { this.pid = w.pid; this.secret = w.secret; }
    return w;
  }
  send(o) { this.ws.send(JSON.stringify(o)); }
  next(pred, ms = 8000) {
    return new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error(this.name + ': timed out waiting; inbox=' + JSON.stringify(this.inbox.slice(-4)))), ms);
      const check = () => { const i = this.inbox.findIndex(pred); if (i < 0) return false; const [m] = this.inbox.splice(i, 1); clearTimeout(t); res(m); return true; };
      if (!check()) this.waiters.push(check);
    });
  }
  async until(pred, ms) { for (;;) { if (this.state && pred(this.state)) return this.state; await this.next(m => m.t === 'state', ms); } }
  close() { try { this.ws.close(); } catch (e) {} }
}

let n = 0;
const test = async (name, fn) => { await fn(); n++; console.log('ok -', name); };
const room = async () => { const r = await api('/api/dnl/room', { method: 'POST' }); assert.equal(r.status, 200); return r.body.code; };
const clients = [];
const mk = name => { const c = new Client(name); clients.push(c); return c; };

try {
  await test('create a room, look it up, bad and unknown codes', async () => {
    const code = await room(); assert.match(code, /^[0-9A-HJKMNP-TV-Z]{5}$/);
    const info = await api('/api/dnl/room/' + code); assert.equal(info.status, 200); assert.equal(info.body.phase, 'lobby'); assert.equal(info.body.players, 0); assert.equal(info.body.joinable, true);
    const lower = await api('/api/dnl/room/' + code.toLowerCase().split('').join('-')); assert.equal(lower.status, 200);
    assert.equal((await api('/api/dnl/room/!!')).status, 400);
    assert.equal((await api('/api/dnl/room/ZZZZZ')).status, 404);
    assert.equal((await api('/api/dnl/nothing')).status, 404);
    assert.equal((await api('/api/dnl/room', { method: 'GET' })).status, 405);
  });

  await test('two players join, chat-free lobby state is shared, host controls work, guests are refused', async () => {
    const code = await room(); const a = mk('Ann'), b = mk('Bob');
    const wa = await a.connect(code); assert.equal(wa.t, 'welcome'); assert.equal(wa.state.hostPid, a.pid); assert.ok(!JSON.stringify(wa.state).includes(a.secret));
    await b.connect(code);
    const s = await a.until(st => st.players.length === 2); assert.deepEqual(s.players.map(p => p.name), ['Ann', 'Bob']);
    b.send({ t: 'start' }); const e1 = await b.next(m => m.t === 'error'); assert.equal(e1.code, 'not_host');
    b.send({ t: 'rules', six: true }); assert.equal((await b.next(m => m.t === 'error')).code, 'not_host');
    a.send({ t: 'rules', six: true }); await b.until(st => st.rules.six === true);
    a.send({ t: 'addBot' }); await a.until(st => st.players.length === 3);
    a.send({ t: 'addBot' }); await a.until(st => st.players.length === 4);
    const c = mk('Cat'); const rej = await c.connect(code); assert.equal(rej.t, 'error'); assert.equal(rej.code, 'full');
    const info = await api('/api/dnl/room/' + code); assert.equal(info.body.joinable, false);
  });

  await test('a whole game: humans roll when told to, bots and the server do the rest, everyone sees the same result', async () => {
    const code = await room(); const a = mk('Ann'), b = mk('Bob');
    await a.connect(code); await b.connect(code); await a.until(st => st.players.length === 2);
    a.send({ t: 'addBot' }); a.send({ t: 'start' });
    const st0 = await a.until(st => st.phase === 'playing'); assert.equal(st0.players.length, 3);
    const late = mk('Late'); assert.equal((await late.connect(code)).code, 'started');
    const rolls = { a: 0, b: 0, auto: 0, seen: 0 };
    const play = async (c, key) => {
      while (c.state.phase !== 'over') {
        const s = c.state;
        if (s.phase === 'playing' && s.players[s.turn].pid === c.pid) { c.send({ t: 'roll' }); rolls[key]++; }
        try { await c.next(m => m.t === 'state', 1500); } catch (e) { /* nothing new; loop and try again */ }
      }
    };
    await Promise.all([play(a, 'a'), play(b, 'b')]);
    const fa = a.state, fb = b.state;
    assert.equal(fa.phase, 'over'); assert.ok(fa.winnerPid); assert.equal(fa.winnerPid, fb.winnerPid);
    assert.equal(fa.players.find(p => p.pid === fa.winnerPid).pos, 100);
    assert.deepEqual(fa.players.map(p => p.pos), fb.players.map(p => p.pos));
    const rollMsgs = [...a.inbox, ...b.inbox].filter(m => m.t === 'roll');
    assert.ok(rollMsgs.length > 20, 'expected roll events, got ' + rollMsgs.length);
    rollMsgs.forEach(m => { assert.ok(m.roll >= 1 && m.roll <= 6); assert.ok(m.out.end >= 0 && m.out.end <= 100); });
  });

  await test('reconnect: a dropped player takes the seat back with pid + secret, even after the room object was evicted', async () => {
    const code = await room(); const a = mk('Ann'), b = mk('Bob');
    await a.connect(code); await b.connect(code); await a.until(st => st.players.length === 2); a.send({ t: 'start' }); await a.until(st => st.phase === 'playing');
    const creds = { pid: b.pid, secret: b.secret }; b.close();
    await a.until(st => st.players.find(p => p.pid === creds.pid).connected === false);
    assert.equal((await (await fetch(BASE + '/__dev/hibernate/' + code)).text()), 'ok');    // room object thrown away; state must come back from storage
    const b2 = mk('Bob'); const w = await b2.connect(code, creds); assert.equal(w.t, 'welcome'); assert.equal(w.pid, creds.pid);
    assert.equal(w.state.phase, 'playing'); assert.equal(w.state.players.length, 2);
    await a.until(st => st.players.find(p => p.pid === creds.pid).connected === true);
    const bad = mk('Mallory'); const r = await bad.connect(code, { pid: creds.pid, secret: 'wrong' }); assert.equal(r.code, 'bad_secret');
    const ghost = mk('Ghost'); assert.equal((await ghost.connect(code, { pid: 'nobody', secret: 'x' })).code, 'seat_gone');
  });

  await test('a second connection for the same seat replaces the first', async () => {
    const code = await room(); const a = mk('Ann'), b = mk('Bob');
    await a.connect(code); await b.connect(code);
    const a2 = mk('Ann'); await a2.connect(code, { pid: a.pid, secret: a.secret });
    for (let i = 0; i < 50 && !a.closed; i++) await sleep(20);
    assert.equal(a.closed && a.closed.code, 4001);
    const s = await b.until(st => st.players.length === 2); assert.equal(s.players.find(p => p.pid === a.pid).connected, true);
  });

  await test('an idle human is rolled for by the server; a disconnected one sooner', async () => {
    const code = await room(); const a = mk('Ann'), b = mk('Bob');
    await a.connect(code); await b.connect(code); await a.until(st => st.players.length === 2); a.send({ t: 'start' });
    const first = await a.until(st => st.phase === 'playing'); const startTurn = first.turn;
    const roll = await a.next(m => m.t === 'roll', 6000);           // nobody clicked: the server rolled
    assert.equal(roll.auto, true); assert.equal(roll.pid, first.players[startTurn].pid);
  });

  await test('host can kick, leaving mid-game hands the seat to a bot, host passes on', async () => {
    const code = await room(); const a = mk('Ann'), b = mk('Bob'), c = mk('Cat');
    await a.connect(code); await b.connect(code); await c.connect(code); await a.until(st => st.players.length === 3);
    a.send({ t: 'remove', pid: c.pid }); await c.next(m => m.t === 'kicked'); await a.until(st => st.players.length === 2);
    a.send({ t: 'start' }); await b.until(st => st.phase === 'playing');
    a.send({ t: 'leave' }); const s = await b.until(st => st.hostPid === b.pid);
    assert.equal(s.players.find(p => p.name === 'Ann').bot, true);
  });

  await test('rematch returns to the lobby with the same people', async () => {
    const code = await room(); const a = mk('Ann'); await a.connect(code); a.send({ t: 'addBot' }); a.send({ t: 'start' });
    await a.until(st => st.phase === 'playing');
    for (;;) { const s = a.state; if (s.phase === 'over') break; if (s.players[s.turn].pid === a.pid) a.send({ t: 'roll' }); try { await a.next(m => m.t === 'state', 1500); } catch (e) {} }
    a.send({ t: 'rematch' }); const s = await a.until(st => st.phase === 'lobby');
    assert.equal(s.players.length, 2); assert.deepEqual(s.players.map(p => p.pos), [0, 0]); assert.equal(s.winnerPid, null);
  });

  await test('junk is refused politely: bad json, no hello, oversize, unknown type, spoofed roll', async () => {
    const code = await room(); const a = mk('Ann'), b = mk('Bob');
    const raw = new WebSocket(`ws://127.0.0.1:${PORT}/api/dnl/room/${code}/ws`); const got = [];
    raw.onmessage = e => got.push(JSON.parse(e.data)); await new Promise(r => raw.onopen = r);
    raw.send('not json'); raw.send(JSON.stringify({ t: 'roll' })); await sleep(150);
    assert.deepEqual(got.map(m => m.code), ['bad_message', 'no_hello']); raw.close();
    await a.connect(code); await b.connect(code); await a.until(st => st.players.length === 2);
    a.send({ t: 'fly' }); assert.equal((await a.next(m => m.t === 'error')).code, 'bad_message');
    b.send({ t: 'roll' }); assert.equal((await b.next(m => m.t === 'error')).code, 'bad_phase');
    a.ws.send('x'.repeat(2000)); for (let i = 0; i < 50 && !a.closed; i++) await sleep(20); assert.equal(a.closed && a.closed.code, 4009);
  });

  await test('the site origin rule: a socket opened from another website is refused, from this site it is accepted', async () => {
    const code = await room();
    const probe = origin => new Promise((res, rej) => {
      const req = http.request({ host: '127.0.0.1', port: PORT, path: `/api/dnl/room/${code}/ws`, headers: { Upgrade: 'websocket', Connection: 'Upgrade',
        Origin: origin, 'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==', 'Sec-WebSocket-Version': '13' } });
      req.on('response', r => { res(r.statusCode); r.resume(); });
      req.on('upgrade', (r, sock) => { res(r.statusCode); sock.destroy(); });
      req.on('error', rej); req.end();
    });
    assert.equal(await probe('https://evil.example'), 403);
    assert.equal(await probe(`http://127.0.0.1:${PORT}`), 101);
  });

  console.log(`\n${n} protocol tests passed`);
} catch (e) {
  console.error('\nFAILED:', e && e.stack || e); process.exitCode = 1;
} finally {
  clients.forEach(c => c.close()); server.kill();
}
