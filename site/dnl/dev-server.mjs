// Local stand-in for Cloudflare, so Dragons & Ladders online rooms can be tried and tested on one machine.
//
//   node site/dnl/dev-server.mjs                 -> http://localhost:8787  (serves public/ and /api/dnl/*)
//   node site/dnl/dev-server.mjs --port 9000 --root ./public --fast
//
// It runs the REAL code (routes.mjs, do.mjs, logic.js, engine.js) against a small in-memory imitation of
// Durable Objects and WebSockets. It is close to Cloudflare, not identical: the real thing has to be tried
// once after deploying. State lives in memory and is lost when this process stops.
//
//   --fast    shorter server timers and pacing, so whole games run in seconds (used by the automated tests)
//   GET /__dev/hibernate/CODE   simulate Cloudflare evicting the room object from memory (sockets stay connected)
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire, register } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const opt = (name, dflt) => { const i = args.indexOf('--' + name); return i >= 0 ? args[i + 1] : dflt; };
const PORT = Number(opt('port', 8787));
const ROOT = path.resolve(opt('root', path.join(here, '..', '..', 'public')));
const FAST = args.includes('--fast');

/* ---------- 1. imitate the Cloudflare runtime ---------- */

// "cloudflare:workers" only exists on Cloudflare; give do.mjs a tiny stand-in.
const loaderSource = `
export async function resolve(specifier, context, next) {
  if (specifier === 'cloudflare:workers') return { url: 'cf-shim:workers', shortCircuit: true };
  return next(specifier, context);
}
export async function load(url, context, next) {
  if (url === 'cf-shim:workers') return { format: 'module', shortCircuit: true,
    source: 'export class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }' };
  return next(url, context);
}`;
register('data:text/javascript,' + encodeURIComponent(loaderSource), import.meta.url);

// A Response with status 101 and a .webSocket, which Node's own Response refuses to build.
const NativeResponse = globalThis.Response;
globalThis.Response = class extends NativeResponse {
  constructor(body, init) {
    if (init && init.status === 101) { super(null, { ...init, status: 200 }); Object.defineProperty(this, 'status', { value: 101 }); this.webSocket = init.webSocket; }
    else super(body, init);
  }
};
globalThis.WebSocketRequestResponsePair = class { constructor(request, response) { this.request = request; this.response = response; } };

class FakeSocket {
  constructor() { this.peer = null; this.closed = false; this.attachment = null; this.onmessage = null; this.onclose = null; this._owner = null; }
  send(data) { if (this.closed) throw new Error('socket closed'); if (this.peer.onmessage) this.peer.onmessage(String(data)); }
  close(code = 1000, reason = '') {
    if (this.closed) throw new Error('socket already closed');
    this.closed = true; this.peer.closed = true;
    if (this.peer.onclose) this.peer.onclose({ code, reason });
  }
  serializeAttachment(v) { this.attachment = v === null || v === undefined ? null : JSON.parse(JSON.stringify(v)); }
  deserializeAttachment() { return this.attachment === null ? null : JSON.parse(JSON.stringify(this.attachment)); }
}
globalThis.WebSocketPair = class { constructor() { const a = new FakeSocket(), b = new FakeSocket(); a.peer = b; b.peer = a; this[0] = a; this[1] = b; } };
const origValues = Object.values;
Object.values = o => (o && o[0] instanceof FakeSocket && o[1] instanceof FakeSocket) ? [o[0], o[1]] : origValues(o);

/* ---------- 2. load the real code ---------- */
const require = createRequire(import.meta.url);
const logic = require('./logic.js');
const engine = require('../../public/games/dragons-and-ladders/engine.js');
if (FAST) {
  Object.assign(logic.T, { TURN_MS: 2500, AWAY_ROLL_MS: 900, BOT_MS: 120, START_DELAY_MS: 200, GONE_MS: 2500, READY_SLACK_MS: 30 });
  engine.animMs = () => 150;
}
const { DnlRoom } = await import(pathToFileURL(path.join(here, 'do.mjs')).href);
const { handleDnl } = await import(pathToFileURL(path.join(here, 'routes.mjs')).href);

/* ---------- 3. in-memory Durable Object namespace ---------- */
class Storage {
  constructor(owner) { this.map = new Map(); this.timer = null; this.at = null; this.owner = owner; }
  async get(k) { return this.map.has(k) ? structuredClone(this.map.get(k)) : undefined; }
  async put(k, v) { this.map.set(k, structuredClone(v)); }
  async deleteAll() { this.map.clear(); }
  async setAlarm(ts) {
    clearTimeout(this.timer); this.at = ts;
    this.timer = setTimeout(() => { this.at = null; this.owner.instance && this.owner.instance.alarm().catch(e => console.error('alarm error', e)); }, Math.min(Math.max(0, ts - Date.now()), 2 ** 31 - 1));
  }
  async deleteAlarm() { clearTimeout(this.timer); this.at = null; }
}
class Holder {                                    // what Cloudflare keeps per Durable Object: storage + sockets + the (evictable) object
  constructor(env) {
    this.env = env; this.storage = new Storage(this); this.sockets = new Set(); this.instance = null;
    const self = this;
    this.ctx = {
      storage: this.storage,
      blockConcurrencyWhile: fn => { self.ready = fn(); return self.ready; },
      acceptWebSocket(ws) { ws.peer._owner = self; ws._owner = self; self.sockets.add(ws); },
      getWebSockets() { return [...self.sockets].filter(s => !s.closed); },
      setWebSocketAutoResponse() {}
    };
    this.boot();
  }
  boot() { this.ready = null; this.instance = new DnlRoom(this.ctx, this.env); }   // constructor loads the room from storage
  async whenReady() { if (this.ready) await this.ready; }
}
const holders = new Map();
const env = {
  DNL_ROOMS: {
    idFromName: name => ({ name }),
    get: id => ({
      async fetch(input, init) {
        let h = holders.get(id.name); if (!h) { h = new Holder(env); holders.set(id.name, h); }
        await h.whenReady();
        const req = input instanceof Request ? input : new Request(input, init);
        return h.instance.fetch(req);
      }
    })
  }
};

/* ---------- 4. WebSocket framing (RFC 6455, what a browser speaks) ---------- */
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
function frame(opcode, payload) {
  const len = payload.length; let head;
  if (len < 126) head = Buffer.from([0x80 | opcode, len]);
  else if (len < 65536) { head = Buffer.alloc(4); head[0] = 0x80 | opcode; head[1] = 126; head.writeUInt16BE(len, 2); }
  else { head = Buffer.alloc(10); head[0] = 0x80 | opcode; head[1] = 127; head.writeBigUInt64BE(BigInt(len), 2); }
  return Buffer.concat([head, payload]);
}
function bridge(socket, clientEnd) {
  const serverEnd = clientEnd.peer, holder = serverEnd._owner;
  let done = false, buf = Buffer.alloc(0), text = [];
  const finish = (code, reason) => {
    if (done) return; done = true;
    holder.whenReady().then(() => holder.instance.webSocketClose(serverEnd, code, reason, code === 1000)).catch(e => console.error('close handler error', e));
  };
  clientEnd.onmessage = data => { if (!socket.destroyed) socket.write(frame(1, Buffer.from(data))); };
  clientEnd.onclose = ({ code, reason }) => {
    if (!socket.destroyed) { const p = Buffer.alloc(2); p.writeUInt16BE(code); socket.write(frame(8, Buffer.concat([p, Buffer.from(reason || '')]))); socket.end(); }
    finish(code, reason);
  };
  socket.on('data', chunk => {
    buf = Buffer.concat([buf, chunk]);
    for (;;) {
      if (buf.length < 2) return;
      const fin = !!(buf[0] & 0x80), op = buf[0] & 0x0f, masked = !!(buf[1] & 0x80); let len = buf[1] & 0x7f, off = 2;
      if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
      const need = off + (masked ? 4 : 0) + len; if (buf.length < need) return;
      let payload = buf.subarray(off + (masked ? 4 : 0), need);
      if (masked) { const key = buf.subarray(off, off + 4); payload = Buffer.from(payload.map((b, i) => b ^ key[i % 4])); }
      buf = buf.subarray(need);
      if (op === 8) { const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1005; if (!socket.destroyed) { socket.write(frame(8, payload.subarray(0, 2))); socket.end(); } serverEnd.closed = true; clientEnd.closed = true; finish(code, ''); return; }
      if (op === 9) { socket.write(frame(10, payload)); continue; }
      if (op === 1 || op === 0) {
        text.push(payload);
        if (fin) {
          const msg = Buffer.concat(text).toString('utf8'); text = [];
          if (msg === 'ping') socket.write(frame(1, Buffer.from('pong')));            // the runtime's auto-response
          else holder.whenReady().then(() => holder.instance.webSocketMessage(serverEnd, msg)).catch(e => console.error('message handler error', e));
        }
      }
    }
  });
  socket.on('close', () => { serverEnd.closed = true; clientEnd.closed = true; finish(1006, ''); });
  socket.on('error', () => {});
}

/* ---------- 5. HTTP server ---------- */
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.webp': 'image/webp', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.mp3': 'audio/mpeg', '.woff2': 'font/woff2' };

function toRequest(req, body) {
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) if (v !== undefined) headers.set(k, Array.isArray(v) ? v.join(', ') : v);
  const init = { method: req.method, headers };
  if (body && body.length && req.method !== 'GET' && req.method !== 'HEAD') init.body = body;
  return new Request('http://' + (req.headers.host || 'localhost') + req.url, init);
}
async function sendResponse(res, r) {
  res.writeHead(r.status, Object.fromEntries(r.headers));
  res.end(Buffer.from(await r.arrayBuffer()));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname.startsWith('/__dev/hibernate/')) {                  // simulate the room object being evicted from memory
      const h = holders.get('room:' + logic.normalizeCode(url.pathname.split('/').pop()));
      if (!h) { res.writeHead(404); res.end('no such room'); return; }
      h.instance = null; h.boot(); await h.whenReady();
      res.writeHead(200); res.end('ok'); return;
    }
    if (url.pathname.startsWith('/api/dnl/')) {
      const chunks = []; for await (const c of req) chunks.push(c);
      const r = await handleDnl(toRequest(req, Buffer.concat(chunks)), env);
      return sendResponse(res, r || new NativeResponse('not found', { status: 404 }));
    }
    let file = path.join(ROOT, decodeURIComponent(url.pathname));
    if (!file.startsWith(ROOT)) { res.writeHead(403); res.end('forbidden'); return; }
    if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
    if (!fs.existsSync(file)) { res.writeHead(404, { 'content-type': 'text/plain' }); res.end('not found'); return; }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
    fs.createReadStream(file).pipe(res);
  } catch (err) { console.error(err); res.writeHead(500); res.end('server error'); }
});

server.on('upgrade', async (req, socket) => {
  try {
    const r = await handleDnl(toRequest(req), env);
    if (!r || r.status !== 101) {
      const body = r ? Buffer.from(await r.arrayBuffer()) : Buffer.from('not found');
      socket.write(`HTTP/1.1 ${r ? r.status : 404} Error\r\ncontent-type: application/json\r\ncontent-length: ${body.length}\r\nconnection: close\r\n\r\n`); socket.end(body); return;
    }
    const key = req.headers['sec-websocket-key'];
    const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
    bridge(socket, r.webSocket);
  } catch (err) { console.error(err); socket.destroy(); }
});

server.listen(PORT, () => console.log(`Dragons & Ladders dev server on http://localhost:${PORT}${FAST ? '  (fast timers)' : ''}\nserving ${ROOT}`));
