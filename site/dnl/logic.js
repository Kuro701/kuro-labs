'use strict';
/* Dragons & Ladders — room logic.
 *
 * Everything about a room that is NOT tied to Cloudflare lives here as plain functions over a plain,
 * JSON-serialisable `room` object, so it can be unit-tested in Node and stored as-is by the Durable Object.
 * Time (`now`, ms since epoch) and randomness (`rng`) are always passed in.
 *
 * Phases: 'lobby' (people join, host adds bots and starts) -> 'playing' -> 'over' (host can start a rematch,
 * which goes back to 'lobby' with the same people).
 */
const E = require('../../public/games/dragons-and-ladders/engine.js');

// Same alphabet as the Mytheder join codes (Crockford base32: no I, L, O, U).
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const CODE_LEN = 5;

const T = {
  TURN_MS: 45000,            // a connected human who does nothing is rolled for after this long
  AWAY_ROLL_MS: 8000,        // ... or after this long once they have disconnected
  BOT_MS: 900,               // pause before a bot rolls (after the previous move has finished animating)
  START_DELAY_MS: 1500,      // pause after the game starts before the first roll
  GONE_MS: 60000,            // a disconnected human is dropped from a lobby / finished game after this
  NO_HUMAN_MS: 5 * 60000,    // a running game with nobody connected for this long is closed
  IDLE_TTL_MS: 2 * 3600000,  // a room with no activity for this long is deleted
  UNUSED_TTL_MS: 30 * 60000, // a room nobody ever joined is deleted after this
  READY_SLACK_MS: 80         // a roll this much before the server-side "ready" time is still accepted
};

/* ---------- small helpers ---------- */

function defaultRng(n) {                       // uniform integer in [0, n)
  const a = new Uint32Array(1), lim = Math.floor(0x100000000 / n) * n;
  do { globalThis.crypto.getRandomValues(a); } while (a[0] >= lim);
  return a[0] % n;
}

function randomString(rng, len) {
  let s = '';
  for (let i = 0; i < len; i++) s += ALPHABET[rng(ALPHABET.length)];
  return s;
}
const newCode = rng => randomString(rng || defaultRng, CODE_LEN);

// Accepts what people type: any case, dashes/spaces, and the usual look-alikes (O -> 0, I/L -> 1).
function normalizeCode(input) {
  return String(input == null ? '' : input).toUpperCase().replace(/[^A-Z0-9]/g, '')
    .replace(/O/g, '0').replace(/[IL]/g, '1');
}
function isValidCode(code) {
  if (typeof code !== 'string' || code.length !== CODE_LEN) return false;
  for (const ch of code) if (ALPHABET.indexOf(ch) < 0) return false;
  return true;
}

function safeEqual(a, b) {
  a = String(a); b = String(b);
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

// Characters that never belong in a name: control, zero-width, line/paragraph separators, direction overrides, BOM.
// Built from code points so the file itself contains no invisible characters.
const STRIP = new RegExp('[' + [[0x00, 0x1f], [0x7f, 0x9f], [0x200b, 0x200f], [0x2028, 0x202f], [0x2060, 0x206f], [0xfeff, 0xfeff]]
  .map(r => String.fromCharCode(r[0]) + '-' + String.fromCharCode(r[1])).join('') + ']', 'g');

// Names: strip control / invisible / direction-override characters, collapse spaces, cap length, keep unique.
function sanitizeName(raw, taken, fallback) {
  let s = String(raw == null ? '' : raw).normalize('NFKC')
    .replace(STRIP, '')
    .replace(/\s+/g, ' ').trim();
  s = Array.from(s).slice(0, 16).join('').trim();
  if (!s) s = fallback;
  const lower = new Set((taken || []).map(n => String(n).toLowerCase()));
  let name = s, i = 2;
  while (lower.has(name.toLowerCase())) name = Array.from(s).slice(0, 13).join('') + ' ' + (i++);
  return name;
}

function freshPid(room, rng) {                  // ids are unique within a room
  for (let i = 0; i < 20; i++) { const pid = randomString(rng, 12); if (!room.players.some(q => q.pid === pid)) return pid; }
  throw new Error('could not make a unique player id');
}
const humans = room => room.players.filter(p => !p.bot);
const findPlayer = (room, pid) => room.players.find(p => p.pid === pid) || null;
const cur = room => room.players[room.turn] || null;
const fail = (code, message) => ({ ok: false, code, message });

/* ---------- create / join ---------- */

function createRoom(code, now) {
  return {
    v: 1, code, phase: 'lobby', createdAt: now, lastActivity: now, hostPid: null,
    rules: { six: false }, players: [], turn: 0, sixes: 0, winnerPid: null, readyAt: 0, seq: 0, botSeq: 0
  };
}

function transferHost(room) {
  const next = humans(room).find(p => p.connected) || humans(room)[0] || null;
  room.hostPid = next ? next.pid : null;
}

// Join a new seat (lobby only) or take back an existing one with pid + secret.
function join(room, req, now, rng) {
  rng = rng || defaultRng;
  const existing = req.pid ? findPlayer(room, req.pid) : null;
  if (existing && !existing.bot && existing.secret && safeEqual(existing.secret, req.secret || '')) {
    existing.connected = true; existing.lastSeen = now; room.lastActivity = now;
    return { ok: true, player: existing, isNew: false };
  }
  if (req.pid && (!existing || existing.bot)) return fail('seat_gone', 'Your seat in this room is gone.');
  if (req.pid) return fail('bad_secret', 'That seat belongs to someone else.');
  if (room.phase !== 'lobby') return fail('started', 'That game has already started.');
  if (room.players.length >= E.MAX_PLAYERS) return fail('full', 'That room is full.');
  const p = {
    pid: freshPid(room, rng), secret: randomString(rng, 24),
    name: sanitizeName(req.name, room.players.map(q => q.name), 'Player ' + (room.players.length + 1)),
    bot: false, pos: 0, turns: 0, connected: true, lastSeen: now
  };
  room.players.push(p);
  if (!room.hostPid) room.hostPid = p.pid;
  room.lastActivity = now;
  return { ok: true, player: p, isNew: true };
}

function disconnect(room, pid, now) {
  const p = findPlayer(room, pid);
  if (p && !p.bot) { p.connected = false; p.lastSeen = now; }
}

/* ---------- lobby actions ---------- */

function requireHost(room, pid) { return room.hostPid === pid ? null : fail('not_host', 'Only the host can do that.'); }
function requirePhase(room, phase) { return room.phase === phase ? null : fail('bad_phase', 'Not possible right now.'); }

function setRules(room, pid, msg, now) {
  const e = requireHost(room, pid) || requirePhase(room, 'lobby'); if (e) return e;
  room.rules.six = !!msg.six; room.lastActivity = now; return { ok: true };
}

function addBot(room, pid, now, rng) {
  const e = requireHost(room, pid) || requirePhase(room, 'lobby'); if (e) return e;
  if (room.players.length >= E.MAX_PLAYERS) return fail('full', 'The room is full.');
  let name;
  do { name = 'Bot ' + (++room.botSeq); } while (room.players.some(q => q.name === name));
  room.players.push({ pid: freshPid(room, rng || defaultRng), secret: null, name, bot: true, pos: 0, turns: 0, connected: true, lastSeen: now });
  room.lastActivity = now; return { ok: true };
}

// Host removes a bot, or kicks a human, from the lobby.
function removePlayer(room, pid, msg, now) {
  const e = requireHost(room, pid) || requirePhase(room, 'lobby'); if (e) return e;
  const t = findPlayer(room, msg.pid);
  if (!t || t.pid === pid) return fail('bad_target', 'No such player.');
  room.players = room.players.filter(q => q.pid !== t.pid);
  room.lastActivity = now;
  return { ok: true, kicked: t.bot ? [] : [t.pid] };
}

function rename(room, pid, msg, now) {
  const e = requirePhase(room, 'lobby'); if (e) return e;
  const p = findPlayer(room, pid); if (!p) return fail('bad_target', 'No such player.');
  p.name = sanitizeName(msg.name, room.players.filter(q => q !== p).map(q => q.name), p.name);
  room.lastActivity = now; return { ok: true };
}

function start(room, pid, now, rng) {
  const e = requireHost(room, pid) || requirePhase(room, 'lobby'); if (e) return e;
  if (room.players.length < 2) return fail('need_players', 'You need at least two players. Add a bot or wait for a friend.');
  room.phase = 'playing'; room.winnerPid = null; room.sixes = 0;
  room.players.forEach(p => { p.pos = 0; p.turns = 0; });
  room.turn = (rng || defaultRng)(room.players.length);
  room.readyAt = now + T.START_DELAY_MS; room.lastActivity = now; room.seq++;
  return { ok: true };
}

function rematch(room, pid, now) {
  const e = requireHost(room, pid) || requirePhase(room, 'over'); if (e) return e;
  room.players = room.players.filter(p => !p.left);       // seats of people who left mid-game are gone
  room.players.forEach(p => { p.pos = 0; p.turns = 0; });
  room.phase = 'lobby'; room.winnerPid = null; room.turn = 0; room.sixes = 0; room.readyAt = 0;
  room.lastActivity = now; room.seq++;
  return { ok: true };
}

// A player leaves for good. In a running game their seat turns into a bot so nobody else is stuck.
function leave(room, pid, now) {
  const p = findPlayer(room, pid); if (!p) return { ok: true };
  if (room.phase === 'playing') { p.bot = true; p.left = true; p.secret = null; p.connected = true; }
  else room.players = room.players.filter(q => q.pid !== pid);
  if (room.hostPid === pid) transferHost(room);
  room.lastActivity = now; room.seq++;
  return { ok: true, closed: humans(room).length === 0 };
}

/* ---------- playing ---------- */

// When the server rolls for the current player by itself (bot, idle human, or absent human). Pure function of state.
function dueAt(room) {
  const p = cur(room); if (room.phase !== 'playing' || !p) return Infinity;
  if (p.bot) return room.readyAt + T.BOT_MS;
  const limit = room.readyAt + T.TURN_MS;
  return p.connected ? limit : Math.min(limit, Math.max(room.readyAt, p.lastSeen) + T.AWAY_ROLL_MS);
}

function doRoll(room, pid, now, rng, auto) {
  const e = requirePhase(room, 'playing'); if (e) return e;
  const p = cur(room);
  if (!p || p.pid !== pid) return fail('not_your_turn', "It isn't your turn.");
  if (now + T.READY_SLACK_MS < room.readyAt) return fail('wait', 'Wait for the last move to finish.');
  const roll = 1 + (rng || defaultRng)(6);
  const out = E.rollOutcome(p.pos, roll);
  p.turns++; p.pos = out.end; room.lastActivity = now; room.seq++;
  const event = { t: 'roll', pid: p.pid, roll, out, auto: !!auto };
  if (out.win) {
    room.phase = 'over'; room.winnerPid = p.pid; room.readyAt = now;
  } else {
    const nt = E.nextTurn({ turn: room.turn, sixes: room.sixes, count: room.players.length, six: room.rules.six }, roll);
    room.turn = nt.turn; room.sixes = nt.sixes;
    room.readyAt = now + E.animMs(out);
  }
  return { ok: true, event };
}

/* ---------- time ---------- */

// Called when a timer fires. Does whatever is due; returns what happened.
function tick(room, now, rng) {
  const events = []; let changed = false;
  // Drop disconnected humans from a lobby or finished game; hand over the host role.
  if (room.phase !== 'playing') {
    const gone = humans(room).filter(p => !p.connected && now - p.lastSeen > T.GONE_MS).map(p => p.pid);
    if (gone.length) {
      room.players = room.players.filter(p => gone.indexOf(p.pid) < 0);
      if (gone.indexOf(room.hostPid) >= 0) transferHost(room);
      changed = true; room.seq++;
    }
  }
  // Server rolls for bots / idle / absent players.
  for (let i = 0; i < 12 && room.phase === 'playing' && now >= dueAt(room); i++) {
    const r = doRoll(room, cur(room).pid, now, rng, true);
    if (!r.ok) break;
    events.push(r.event); changed = true;
  }
  return { events, changed, closed: shouldClose(room, now) };
}

function shouldClose(room, now) {
  if (room.players.length === 0) return now - room.createdAt > T.UNUSED_TTL_MS || (room.phase !== 'lobby');
  if (humans(room).length === 0) return true;
  if (now - room.lastActivity > T.IDLE_TTL_MS) return true;
  if (room.phase === 'playing') {
    const hs = humans(room);
    if (hs.every(p => !p.connected) && now - Math.max.apply(null, hs.map(p => p.lastSeen)) > T.NO_HUMAN_MS) return true;
  }
  return false;
}

// When the Durable Object should wake up next (ms since epoch).
function nextAlarm(room, now) {
  let at = Infinity;
  if (room.players.length === 0) at = room.createdAt + T.UNUSED_TTL_MS + 1000;
  else {
    at = Math.min(at, room.lastActivity + T.IDLE_TTL_MS + 1000);
    if (room.phase === 'playing') {
      at = Math.min(at, dueAt(room));
      const hs = humans(room);
      if (hs.length && hs.every(p => !p.connected)) at = Math.min(at, Math.max.apply(null, hs.map(p => p.lastSeen)) + T.NO_HUMAN_MS + 1000);
    } else {
      humans(room).forEach(p => { if (!p.connected) at = Math.min(at, p.lastSeen + T.GONE_MS + 1000); });
    }
  }
  return Math.max(at, now + 100);
}

/* ---------- messages from a connected player ---------- */

function handle(room, pid, msg, now, rng) {
  if (!msg || typeof msg.t !== 'string') return fail('bad_message', 'Unknown message.');
  switch (msg.t) {
    case 'roll':    return doRoll(room, pid, now, rng, false);
    case 'start':   return start(room, pid, now, rng);
    case 'rules':   return setRules(room, pid, msg, now);
    case 'addBot':  return addBot(room, pid, now, rng);
    case 'remove':  return removePlayer(room, pid, msg, now);
    case 'rename':  return rename(room, pid, msg, now);
    case 'rematch': return rematch(room, pid, now);
    case 'leave':   return leave(room, pid, now);
    default:        return fail('bad_message', 'Unknown message.');
  }
}

/* ---------- what clients may see (never secrets) ---------- */

function publicState(room, now) {
  const p = cur(room);
  const playing = room.phase === 'playing';
  return {
    code: room.code, phase: room.phase, hostPid: room.hostPid, rules: { six: room.rules.six },
    players: room.players.map(q => ({ pid: q.pid, name: q.name, bot: q.bot, pos: q.pos, turns: q.turns, connected: q.connected, left: !!q.left })),
    turn: room.turn, sixes: room.sixes, winnerPid: room.winnerPid, seq: room.seq,
    readyIn: playing ? Math.max(0, room.readyAt - now) : 0,
    deadlineIn: playing && p && !p.bot ? Math.max(0, dueAt(room) - now) : null,
    max: E.MAX_PLAYERS
  };
}

function publicInfo(room) {
  return { code: room.code, phase: room.phase, players: room.players.length, max: E.MAX_PLAYERS,
    joinable: room.phase === 'lobby' && room.players.length < E.MAX_PLAYERS };
}

module.exports = {
  ALPHABET, CODE_LEN, T, defaultRng, newCode, normalizeCode, isValidCode, sanitizeName,
  createRoom, join, disconnect, handle, tick, nextAlarm, dueAt, shouldClose, publicState, publicInfo,
  // exported for tests
  doRoll, start, leave, addBot, rematch
};
