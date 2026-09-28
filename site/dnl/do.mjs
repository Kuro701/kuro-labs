// Dragons & Ladders — one Durable Object per room.
//
// This file is only the Cloudflare glue: sockets in, sockets out, saving, timers. Every game rule and every
// decision lives in ./logic.js (plain functions, unit-tested). The room is saved after every change, so a
// restart or a deploy loses nothing; people reconnect to their seat with the pid + secret they were given.
//
// WebSocket messages (JSON):
//   client -> server   hello {name, pid?, secret?}   first message: join, or reclaim a seat
//                      roll | start | addBot | rules {six} | remove {pid} | rename {name} | rematch | leave | close (host)
//   server -> client   welcome {pid, secret, you, state}   (only to the socket that said hello)
//                      state {you, state}                  (after every change, to everyone)
//                      roll {pid, roll, out, auto}         (the animation to play; a state follows)
//                      error {code, message} | kicked | closed
import { DurableObject } from 'cloudflare:workers';
import logic from './logic.js';
import accounts from '../accounts/accounts.js';        // only recordGameResult: saves wins to the logged-in players' accounts

const MAX_MESSAGE = 1024;      // characters; every legitimate message is far smaller
const MAX_SOCKETS = 12;        // per room (4 players + reconnect overlaps + spectator-ish leftovers)

const json = (obj, status = 200) => new Response(JSON.stringify(obj), {
  status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }
});

export class DnlRoom extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.room = null;
    ctx.blockConcurrencyWhile(async () => { this.room = (await ctx.storage.get('room')) || null; });
    // Keep-alive pings are answered by the runtime without waking the object.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
  }

  /* ---------- HTTP entry: init | info | ws ---------- */
  async fetch(request) {
    const url = new URL(request.url);
    const action = url.pathname.split('/').filter(Boolean).pop();

    if (action === 'init' && request.method === 'POST') {
      if (this.room) return json({ error: 'exists' }, 409);
      let body; try { body = await request.json(); } catch (e) { return json({ error: 'bad_request' }, 400); }
      if (!logic.isValidCode(body && body.code)) return json({ error: 'bad_code' }, 400);
      this.room = logic.createRoom(body.code, Date.now());
      await this.save(); await this.schedule();
      return json({ ok: true });
    }

    if (action === 'info') {
      if (!this.room) return json({ error: 'not_found' }, 404);
      return json(logic.publicInfo(this.room));
    }

    if (action === 'ws') {
      if (request.headers.get('Upgrade') !== 'websocket') return json({ error: 'expected_websocket' }, 426);
      if (!this.room) return json({ error: 'not_found' }, 404);
      // cap on joined players and, separately, on sockets that have not said hello (those are closed after 15 s), so idle sockets cannot lock a room
      let joined = 0, idle = 0; const nowMs = Date.now();
      for (const w of this.ctx.getWebSockets()) {
        const a = w.deserializeAttachment() || {};
        if (a.pid) joined++; else if (a.t && nowMs - a.t > 15000) this.safeClose(w, 4008, 'no hello'); else idle++;
      }
      if (joined >= MAX_SOCKETS || idle >= MAX_SOCKETS) return json({ error: 'busy' }, 503);
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      this.ctx.acceptWebSocket(server);
      // x-kl-uid is put there by routes.mjs from the login cookie (it removes any copy the browser sent); it never reaches a client.
      const uid = Number(request.headers.get('x-kl-uid')) || null;
      server.serializeAttachment({ pid: null, uid, t: Date.now() });
      return new Response(null, { status: 101, webSocket: client });
    }

    return json({ error: 'not_found' }, 404);
  }

  /* ---------- sockets ---------- */
  async webSocketMessage(ws, message) {
    if (typeof message !== 'string' || message.length > MAX_MESSAGE) { this.safeClose(ws, 4009, 'message too big'); return; }
    if (!this.room) { this.send(ws, { t: 'closed' }); this.safeClose(ws, 4000, 'room closed'); return; }
    let msg;
    try { msg = JSON.parse(message); } catch (e) { this.send(ws, { t: 'error', code: 'bad_message', message: 'Could not read that.' }); return; }
    if (!msg || typeof msg.t !== 'string') { this.send(ws, { t: 'error', code: 'bad_message', message: 'Could not read that.' }); return; }

    const now = Date.now();
    const att = ws.deserializeAttachment() || {};

    if (msg.t === 'hello') {
      if (att.pid) return;                                       // already joined on this socket
      const j = logic.join(this.room, { name: msg.name, pid: msg.pid, secret: msg.secret, uid: att.uid }, now);
      if (!j.ok) { this.send(ws, { t: 'error', code: j.code, message: j.message }); this.safeClose(ws, 4003, j.code); return; }
      const pid = j.player.pid;
      ws.serializeAttachment({ pid, uid: att.uid || null });
      for (const other of this.ctx.getWebSockets()) {            // a newer connection replaces an older one for the same seat
        if (other === ws) continue;
        const a = other.deserializeAttachment();
        if (a && a.pid === pid) { other.serializeAttachment({ pid: null }); this.safeClose(other, 4001, 'replaced'); }
      }
      this.send(ws, { t: 'welcome', pid, secret: j.player.secret, you: pid, state: logic.publicState(this.room, now) });
      this.broadcastState(now);
      await this.save(); await this.schedule();
      return;
    }

    if (!att.pid) { this.send(ws, { t: 'error', code: 'no_hello', message: 'Join the room first.' }); return; }

    const res = logic.handle(this.room, att.pid, msg, now);
    if (!res.ok) {
      this.send(ws, { t: 'error', code: res.code, message: res.message });
      this.send(ws, { t: 'state', you: att.pid, state: logic.publicState(this.room, now) });   // re-sync the sender
      return;
    }
    if (res.event) this.broadcast({ t: 'roll', pid: res.event.pid, roll: res.event.roll, out: res.event.out, auto: res.event.auto });
    for (const kicked of res.kicked || []) {
      for (const other of this.ctx.getWebSockets()) {
        const a = other.deserializeAttachment();
        if (a && a.pid === kicked) { other.serializeAttachment({ pid: null }); this.send(other, { t: 'kicked' }); this.safeClose(other, 4002, 'removed'); }
      }
    }
    if (msg.t === 'close' && res.closed) { await this.closeRoom(); return; }
    if (msg.t === 'leave') {
      ws.serializeAttachment({ pid: null });
      this.safeClose(ws, 1000, 'left');
      if (res.closed) { await this.closeRoom(); return; }
    }
    this.broadcastState(now);
    await this.settle();
    await this.save(); await this.schedule();
  }

  async webSocketClose(ws) { await this.dropSocket(ws); }
  async webSocketError(ws) { await this.dropSocket(ws); }

  async dropSocket(ws) {
    const att = ws.deserializeAttachment && ws.deserializeAttachment();
    if (!att || !att.pid || !this.room) return;
    const stillHere = this.ctx.getWebSockets().some(o => o !== ws && (o.deserializeAttachment() || {}).pid === att.pid);
    if (stillHere) return;
    const now = Date.now();
    logic.disconnect(this.room, att.pid, now);
    this.broadcastState(now);
    await this.save(); await this.schedule();
  }

  /* ---------- timers ---------- */
  async alarm() {
    if (!this.room) return;
    const now = Date.now();
    const r = logic.tick(this.room, now);
    for (const ev of r.events) this.broadcast({ t: 'roll', pid: ev.pid, roll: ev.roll, out: ev.out, auto: ev.auto });
    if (r.closed) { await this.closeRoom(); return; }
    if (r.changed) this.broadcastState(now);
    await this.settle();
    await this.save(); await this.schedule();
  }

  /* ---------- helpers ---------- */
  // Save the result of a finished game to the accounts of the people who played it (only the game server does this, so scores
  // cannot be edited from a browser). An item is dropped once saved; a failed one is tried again on the next save, at most 3 times.
  async settle() {
    if (this.settling || !this.room) return;                          // another message or the alarm is already saving them: never save twice
    const items = logic.pendingResults(this.room); if (!items.length) return;
    logic.clearResults(this.room);                                     // take them out first, so nothing else can pick them up
    if (!this.env || !this.env.DB) return;
    this.settling = true;
    try {
      await this.save();
      const left = [];
      for (const x of items) {
        try { await accounts.recordGameResult(this.env, x.uid, 'dragons-and-ladders', { won: x.won, turns: x.turns }); }
        catch (e) { if (!/FOREIGN|constraint/i.test(String(e && e.message)) && (x.tries || 0) < 3) left.push({ ...x, tries: (x.tries || 0) + 1 }); }
      }
      if (this.room && left.length) this.room.results = (this.room.results || []).concat(left);
    } finally { this.settling = false; }
  }

  save() { return this.ctx.storage.put('room', this.room); }
  schedule() { return this.ctx.storage.setAlarm(logic.nextAlarm(this.room, Date.now())); }

  send(ws, obj) { try { ws.send(JSON.stringify(obj)); } catch (e) { /* socket already gone */ } }
  safeClose(ws, code, reason) { try { ws.close(code, reason); } catch (e) { /* already closed */ } }

  broadcast(obj) {
    const text = JSON.stringify(obj);
    for (const ws of this.ctx.getWebSockets()) {
      const a = ws.deserializeAttachment();
      if (a && a.pid) { try { ws.send(text); } catch (e) { /* gone */ } }
    }
  }

  broadcastState(now) {
    const state = logic.publicState(this.room, now);
    for (const ws of this.ctx.getWebSockets()) {
      const a = ws.deserializeAttachment();
      if (a && a.pid) this.send(ws, { t: 'state', you: a.pid, state });
    }
  }

  async closeRoom() {
    for (const ws of this.ctx.getWebSockets()) { this.send(ws, { t: 'closed' }); this.safeClose(ws, 4000, 'room closed'); }
    this.room = null;
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
  }
}
