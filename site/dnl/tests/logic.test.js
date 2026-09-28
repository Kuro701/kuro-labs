'use strict';
// Run with: node site/dnl/tests/logic.test.js
const assert = require('node:assert/strict');
const L = require('../logic.js');
const E = require('../../../public/games/dragons-and-ladders/engine.js');
const T = L.T;

let n = 0;
const test = (name, fn) => { fn(); n++; console.log('ok -', name); };
const rigged = list => k => { const v = list.shift(); assert.ok(v !== undefined, 'rng ran out'); assert.ok(v < k, 'rng value ' + v + ' >= ' + k); return v; };
const fresh = (now = 1000) => L.createRoom('ABCDE', now);
function lobby(names, now = 1000) {
  const r = fresh(now), ps = [];
  names.forEach((nm, i) => { const j = L.join(r, { name: nm }, now + i); assert.ok(j.ok, j.message); ps.push(j.player); });
  return { r, ps };
}
function started(names = ['Ann', 'Bob'], first = 0, now = 1000) {
  const { r, ps } = lobby(names, now);
  const s = L.handle(r, ps[0].pid, { t: 'start' }, now, rigged([first])); assert.ok(s.ok, s.message);
  return { r, ps, now };
}

test('codes: normalise, validate, generate', () => {
  assert.equal(L.normalizeCode(' ab-c1e '), 'ABC1E');
  assert.equal(L.normalizeCode('oil0o'), '01100');          // O->0, I/L->1
  assert.ok(L.isValidCode('ABCDE')); assert.ok(!L.isValidCode('ABCD')); assert.ok(!L.isValidCode('ABCDI')); assert.ok(!L.isValidCode('abcde')); assert.ok(!L.isValidCode(null));
  for (let i = 0; i < 200; i++) assert.ok(L.isValidCode(L.newCode()));
});
test('names: sanitised, capped, unique, never empty', () => {
  assert.equal(L.sanitizeName('  Ann\u0000​  Lee ', [], 'P'), 'Ann Lee');
  assert.equal(L.sanitizeName('x'.repeat(40), [], 'P').length, 16);
  assert.equal(L.sanitizeName('‮evil', [], 'P'), 'evil');
  assert.equal(L.sanitizeName('   ', [], 'Player 3'), 'Player 3');
  assert.equal(L.sanitizeName(undefined, [], 'Player 1'), 'Player 1');
  assert.equal(L.sanitizeName('Ann', ['ann'], 'P'), 'Ann 2');
  assert.equal(L.sanitizeName('fuck', [], 'Player 2'), 'Player 2');                       // same filter as usernames
  assert.equal(L.sanitizeName('f u c k', [], 'Player 2'), 'Player 2');
  assert.equal(L.sanitizeName('Admin', [], 'Player 2'), 'Player 2');                      // staff look-alikes
  assert.equal(L.sanitizeName('Kuro Labs', [], 'Player 2'), 'Player 2');
  assert.equal(L.sanitizeName('Bot 3', [], 'Player 2'), 'Player 2');                      // nobody pretends to be a bot
  assert.equal(L.sanitizeName('Scunthorpe fan', [], 'P'), 'Scunthorpe fan');              // ordinary names are left alone
  assert.equal(L.sanitizeName('Zuzka', [], 'P'), 'Zuzka');
  assert.equal(L.sanitizeName('Ann', ['Ann', 'Ann 2'], 'P'), 'Ann 3');
  assert.ok(L.sanitizeName('a'.repeat(16), ['a'.repeat(16)], 'P').length <= 16);
});
test('join: first is host, room fills at four, then "full"', () => {
  const { r, ps } = lobby(['A', 'B', 'C', 'D']);
  assert.equal(r.hostPid, ps[0].pid);
  const j = L.join(r, { name: 'E' }, 2000); assert.equal(j.ok, false); assert.equal(j.code, 'full');
});
test('join: reconnect with pid + secret; wrong secret and unknown pid are refused', () => {
  const { r, ps } = lobby(['A', 'B']);
  L.disconnect(r, ps[1].pid, 5000); assert.equal(ps[1].connected, false);
  const back = L.join(r, { pid: ps[1].pid, secret: ps[1].secret }, 6000); assert.ok(back.ok); assert.equal(back.isNew, false); assert.equal(ps[1].connected, true);
  assert.equal(L.join(r, { pid: ps[1].pid, secret: 'nope' }, 6000).code, 'bad_secret');
  assert.equal(L.join(r, { pid: 'ghost', secret: 'x' }, 6000).code, 'seat_gone');
});
test('join: nobody new once the game has started, but seats can still be reclaimed', () => {
  const { r, ps } = started(['A', 'B']);
  assert.equal(L.join(r, { name: 'Late' }, 3000).code, 'started');
  L.disconnect(r, ps[0].pid, 4000);
  assert.ok(L.join(r, { pid: ps[0].pid, secret: ps[0].secret }, 5000).ok);
});
test('host tools: rules, bots, remove; others cannot', () => {
  const { r, ps } = lobby(['A', 'B']);
  assert.equal(L.handle(r, ps[1].pid, { t: 'rules', six: true }, 2000).code, 'not_host');
  assert.ok(L.handle(r, ps[0].pid, { t: 'rules', six: true }, 2000).ok); assert.equal(r.rules.six, true);
  assert.ok(L.handle(r, ps[0].pid, { t: 'addBot' }, 2000).ok);
  assert.ok(L.handle(r, ps[0].pid, { t: 'addBot' }, 2000).ok);
  assert.equal(L.handle(r, ps[0].pid, { t: 'addBot' }, 2000).code, 'full');
  assert.deepEqual(r.players.map(p => p.name), ['A', 'B', 'Bot 1', 'Bot 2']);
  const bot = r.players[2];
  assert.equal(L.handle(r, ps[1].pid, { t: 'remove', pid: bot.pid }, 2000).code, 'not_host');
  assert.equal(L.handle(r, ps[0].pid, { t: 'remove', pid: ps[0].pid }, 2000).code, 'bad_target');
  const k = L.handle(r, ps[0].pid, { t: 'remove', pid: ps[1].pid }, 2000); assert.deepEqual(k.kicked, [ps[1].pid]);
  const b = L.handle(r, ps[0].pid, { t: 'remove', pid: bot.pid }, 2000); assert.deepEqual(b.kicked, []);
  assert.equal(r.players.length, 2);
});
test('rename in the lobby only, kept unique', () => {
  const { r, ps } = lobby(['A', 'B']);
  assert.ok(L.handle(r, ps[1].pid, { t: 'rename', name: 'A' }, 2000).ok); assert.equal(ps[1].name, 'A 2');
  L.handle(r, ps[0].pid, { t: 'start' }, 2000, rigged([0]));
  assert.equal(L.handle(r, ps[1].pid, { t: 'rename', name: 'Z' }, 2000).code, 'bad_phase');
});
test('start: needs two, picks the first player with rng, sets the delay', () => {
  const { r, ps } = lobby(['A']);
  assert.equal(L.handle(r, ps[0].pid, { t: 'start' }, 2000).code, 'need_players');
  L.join(r, { name: 'B' }, 2000);
  assert.equal(L.handle(r, r.players[1].pid, { t: 'start' }, 2000).code, 'not_host');
  assert.ok(L.handle(r, ps[0].pid, { t: 'start' }, 2000, rigged([1])).ok);
  assert.equal(r.phase, 'playing'); assert.equal(r.turn, 1); assert.equal(r.readyAt, 2000 + T.START_DELAY_MS);
});
test('roll: turn and timing are enforced; event carries the outcome', () => {
  const { r, ps } = started(['A', 'B'], 0, 1000);
  assert.equal(L.handle(r, ps[1].pid, { t: 'roll' }, 9000).code, 'not_your_turn');
  assert.equal(L.handle(r, ps[0].pid, { t: 'roll' }, 1000).code, 'wait');                    // before the start delay is over
  const res = L.handle(r, ps[0].pid, { t: 'roll' }, 3000, rigged([2]));                      // roll = 3
  assert.ok(res.ok); assert.equal(res.event.roll, 3); assert.deepEqual(res.event.out.path, [1, 2, 3]); assert.equal(res.event.auto, false);
  assert.equal(ps[0].pos, 3); assert.equal(ps[0].turns, 1); assert.equal(r.turn, 1);
  assert.equal(r.readyAt, 3000 + E.animMs(res.event.out));
  assert.equal(L.handle(r, ps[0].pid, { t: 'roll' }, 3001).code, 'not_your_turn');
  assert.equal(L.handle(r, ps[1].pid, { t: 'roll' }, 3001).code, 'wait');
});
test('roll: ladder and dragon move the player', () => {
  const { r, ps } = started(['A', 'B'], 0, 1000);
  ps[0].pos = 7; const a = L.doRoll(r, ps[0].pid, 9000, rigged([0]));            // 7+1 = 8 -> ladder -> 33
  assert.equal(ps[0].pos, 33); assert.equal(a.event.out.jump.kind, 'ladder');
  ps[1].pos = 44; const b = L.doRoll(r, ps[1].pid, 20000, rigged([5]));           // 44+6 = 50 -> purple dragon -> 9
  assert.equal(ps[1].pos, 9); assert.equal(b.event.out.jump.color, 'purple');
});
test('six rule gives an extra roll, two at most', () => {
  const { r, ps } = started(['A', 'B'], 0, 1000); r.rules.six = true;
  let now = 5000;
  for (let i = 1; i <= 2; i++) { assert.ok(L.doRoll(r, ps[0].pid, now, rigged([5])).ok); assert.equal(r.turn, 0); assert.equal(r.sixes, i); now = r.readyAt; }
  assert.ok(L.doRoll(r, ps[0].pid, now, rigged([5])).ok); assert.equal(r.turn, 1); assert.equal(r.sixes, 0);
});
test('overshooting 100 stays put; exact roll wins and ends the game', () => {
  const { r, ps } = started(['A', 'B'], 0, 1000);
  ps[0].pos = 99;
  const stay = L.doRoll(r, ps[0].pid, 5000, rigged([1])); assert.equal(stay.event.out.stay, true); assert.equal(ps[0].pos, 99); assert.equal(r.turn, 1);
  ps[1].pos = 3; L.doRoll(r, ps[1].pid, r.readyAt, rigged([0]));
  const win = L.doRoll(r, ps[0].pid, r.readyAt, rigged([0])); assert.ok(win.ok); assert.equal(win.event.out.win, true);
  assert.equal(r.phase, 'over'); assert.equal(r.winnerPid, ps[0].pid);
  assert.equal(L.handle(r, ps[1].pid, { t: 'roll' }, 99999).code, 'bad_phase');
});
test('tick: a bot rolls by itself once the pause is over, and only then', () => {
  const { r, ps } = lobby(['A']); L.handle(r, ps[0].pid, { t: 'addBot' }, 1000);
  L.handle(r, ps[0].pid, { t: 'start' }, 1000, rigged([1]));                          // bot (index 1) starts
  const early = L.tick(r, 1000 + T.START_DELAY_MS + T.BOT_MS - 1, rigged([])); assert.equal(early.events.length, 0);
  const due = L.tick(r, 1000 + T.START_DELAY_MS + T.BOT_MS, rigged([3])); assert.equal(due.events.length, 1);
  assert.equal(due.events[0].auto, true); assert.equal(due.events[0].roll, 4); assert.equal(r.turn, 0);
  assert.equal(L.tick(r, r.readyAt, rigged([])).events.length, 0);                   // now it is the human's turn
});
test('tick: an idle connected human is rolled for after the turn limit', () => {
  const { r, ps } = started(['A', 'B'], 0, 1000);
  assert.equal(L.tick(r, r.readyAt + T.TURN_MS - 1, rigged([])).events.length, 0);
  const t = L.tick(r, r.readyAt + T.TURN_MS, rigged([1])); assert.equal(t.events.length, 1); assert.equal(t.events[0].pid, ps[0].pid); assert.equal(t.events[0].auto, true);
});
test('tick: a disconnected human is rolled for much sooner', () => {
  const { r, ps } = started(['A', 'B'], 0, 1000);
  L.disconnect(r, ps[0].pid, r.readyAt + 1000);
  const at = L.dueAt(r); assert.equal(at, r.readyAt + 1000 + T.AWAY_ROLL_MS);
  assert.equal(L.tick(r, at - 1, rigged([])).events.length, 0);
  assert.equal(L.tick(r, at, rigged([0])).events.length, 1);
});
test('a lobby with only bots left is closed', () => {
  const { r, ps } = lobby(['A']); ['x', 'y', 'z'].forEach(() => L.addBot(r, ps[0].pid, 1000));
  L.leave(r, ps[0].pid, 1000);                     // host leaves in the lobby -> nobody human -> closed
  assert.equal(L.shouldClose(r, 1000), true);
});
test('a full game with one idle human and bots finishes through tick alone', () => {
  const { r, ps } = lobby(['Ann']); L.addBot(r, ps[0].pid, 1000); L.addBot(r, ps[0].pid, 1000);
  L.handle(r, ps[0].pid, { t: 'start' }, 1000);
  let now = 1000, guard = 0, rolls = 0;              // the human is connected but never clicks: the server rolls for them
  while (r.phase === 'playing' && guard++ < 20000) {
    now = Math.max(now, L.nextAlarm(r, now));
    const t = L.tick(r, now); rolls += t.events.length;
    if (t.closed) break;
  }
  assert.equal(r.phase, 'over'); assert.ok(r.winnerPid); assert.ok(rolls > 10);
});
test('leave in the lobby removes the seat and passes on the host', () => {
  const { r, ps } = lobby(['A', 'B', 'C']);
  const res = L.handle(r, ps[0].pid, { t: 'leave' }, 2000);
  assert.equal(res.closed, false); assert.equal(r.players.length, 2); assert.equal(r.hostPid, ps[1].pid);
});
test('leave mid-game turns the seat into a bot, game goes on; last human leaving closes the room', () => {
  const { r, ps } = started(['A', 'B', 'C'], 0, 1000);
  const res = L.handle(r, ps[0].pid, { t: 'leave' }, 2000);
  assert.equal(res.closed, false); assert.equal(ps[0].bot, true); assert.equal(ps[0].left, true); assert.equal(r.hostPid, ps[1].pid);
  assert.equal(L.join(r, { pid: ps[0].pid, secret: ps[0].secret }, 3000).code, 'seat_gone');
  L.handle(r, ps[1].pid, { t: 'leave' }, 3000);
  assert.equal(L.handle(r, ps[2].pid, { t: 'leave' }, 4000).closed, true);
});
test('lobby: a human who stays disconnected is dropped after a minute, host passes on', () => {
  const { r, ps } = lobby(['A', 'B']);
  L.disconnect(r, ps[0].pid, 5000);
  assert.equal(L.tick(r, 5000 + T.GONE_MS - 1).changed, false);
  const t = L.tick(r, 5000 + T.GONE_MS + 1); assert.equal(t.changed, true);
  assert.deepEqual(r.players.map(p => p.name), ['B']); assert.equal(r.hostPid, ps[1].pid);
});
test('rematch: back to the lobby with the same people, positions cleared', () => {
  const { r, ps } = started(['A', 'B'], 0, 1000);
  ps[0].pos = 99; L.doRoll(r, ps[0].pid, 5000, rigged([0]));
  assert.equal(r.phase, 'over');
  assert.equal(L.handle(r, ps[1].pid, { t: 'rematch' }, 6000).code, 'not_host');
  assert.ok(L.handle(r, ps[0].pid, { t: 'rematch' }, 6000).ok);
  assert.equal(r.phase, 'lobby'); assert.equal(r.winnerPid, null); assert.deepEqual(r.players.map(p => p.pos), [0, 0]);
});
test('rooms close: unused after 30 minutes, idle after 2 hours, empty running game after 5 minutes', () => {
  const e = fresh(0); assert.equal(L.shouldClose(e, T.UNUSED_TTL_MS - 1), false); assert.equal(L.shouldClose(e, T.UNUSED_TTL_MS + 1), true);
  const { r } = lobby(['A', 'B'], 0);
  assert.equal(L.shouldClose(r, T.IDLE_TTL_MS - 5), false); assert.equal(L.shouldClose(r, T.IDLE_TTL_MS + 5), true);
  const g = started(['A', 'B'], 0, 0);
  g.ps.forEach(p => L.disconnect(g.r, p.pid, 10000));
  assert.equal(L.shouldClose(g.r, 10000 + T.NO_HUMAN_MS - 1), false); assert.equal(L.shouldClose(g.r, 10000 + T.NO_HUMAN_MS + 1), true);
});
test('nextAlarm is always in the future', () => {
  const { r } = started(['A', 'B'], 0, 1000);
  for (const now of [1000, 5000, 1e9]) assert.ok(L.nextAlarm(r, now) >= now + 100);
  assert.ok(L.nextAlarm(fresh(0), 5) > 5);
});
test('public state never contains secrets and reports timers', () => {
  const { r, ps } = started(['A', 'B'], 0, 1000);
  const s = L.publicState(r, 1500); const json = JSON.stringify(s);
  ps.forEach(p => assert.ok(!json.includes(p.secret)));
  assert.equal(s.readyIn, T.START_DELAY_MS - 500); assert.equal(s.deadlineIn, r.readyAt + T.TURN_MS - 1500);
  assert.equal(s.players.length, 2); assert.equal(s.phase, 'playing');
  assert.equal(L.publicState(fresh(), 5).deadlineIn, null);
});
test('unknown or malformed messages are refused', () => {
  const { r, ps } = lobby(['A', 'B']);
  assert.equal(L.handle(r, ps[0].pid, { t: 'fly' }, 1).code, 'bad_message');
  assert.equal(L.handle(r, ps[0].pid, null, 1).code, 'bad_message');
  assert.equal(L.handle(r, ps[0].pid, { t: 5 }, 1).code, 'bad_message');
});
test('the room object survives a JSON round trip (that is how it is stored)', () => {
  const { r } = started(['A', 'B'], 0, 1000);
  const copy = JSON.parse(JSON.stringify(r)); assert.deepEqual(copy, r);
  assert.ok(L.doRoll(copy, copy.players[copy.turn].pid, 9000, rigged([2])).ok);
});
/* ---- accounts: seats know their account, wins are saved by the server, and only when it is fair ---- */
test('accounts: a seat keeps the account id privately; the same account cannot take two seats; ids never reach clients', () => {
  const r = fresh(); const a = L.join(r, { name: 'A', uid: 7 }, 1000), b = L.join(r, { name: 'B', uid: 8 }, 1001), g = L.join(r, { name: 'G' }, 1002);
  assert.equal(a.player.uid, 7); assert.equal(g.player.uid, null);
  assert.equal(L.join(r, { name: 'Twin', uid: 7 }, 1003).code, 'dup_account');
  assert.equal(L.join(r, { name: 'Bad', uid: 'x' }, 1004).player.uid, null);                          // junk is not an account
  assert.equal(L.join(r, { pid: g.player.pid, secret: g.player.secret, uid: 9 }, 1005).player.uid, 9); // logging in later binds the seat once
  L.join(r, { pid: g.player.pid, secret: g.player.secret, uid: 10 }, 1006); assert.equal(g.player.uid, 9);
  L.join(r, { pid: b.player.pid, secret: b.player.secret, uid: 7 }, 1007); assert.equal(b.player.uid, 8);   // and cannot take another seat's account
  assert.ok(!JSON.stringify(L.publicState(r, 2000)).includes('"uid"'));
});
test('results: a finished game with two or more people is saved for logged-in players who stayed; bots-only, one person, and leavers are not', () => {
  const win = (r, ps, w) => { ps[w].pos = 99; while (r.phase === 'playing') { const c = r.players[r.turn]; if (c === ps[w]) { L.doRoll(r, c.pid, r.readyAt + 10, rigged([0])); } else { c.pos = 3; L.doRoll(r, c.pid, r.readyAt + 10, rigged([0])); } } };
  // two people, one guest: only the account is saved
  let { r, ps } = lobby(['A', 'B']); ps[0].uid = 5;
  L.handle(r, ps[0].pid, { t: 'start' }, 2000, rigged([0])); assert.equal(r.ranked, true);
  win(r, ps, 0); assert.deepEqual(L.pendingResults(r), [{ uid: 5, won: true, turns: r.players[0].turns }]);
  L.clearResults(r); assert.deepEqual(L.pendingResults(r), []);
  // the loser is saved as a loss
  ({ r, ps } = lobby(['A', 'B'])); ps[0].uid = 5; ps[1].uid = 6;
  L.handle(r, ps[0].pid, { t: 'start' }, 2000, rigged([0])); win(r, ps, 1);
  assert.deepEqual(L.pendingResults(r).map(x => [x.uid, x.won]), [[5, false], [6, true]]);
  // one person against bots: nothing counts
  ({ r, ps } = lobby(['A'])); ps[0].uid = 5; L.handle(r, ps[0].pid, { t: 'addBot' }, 1500);
  L.handle(r, ps[0].pid, { t: 'start' }, 2000, rigged([0])); assert.equal(r.ranked, false); win(r, r.players, 0); assert.deepEqual(L.pendingResults(r), []);
  // someone who left mid-game is not saved (no win, no loss)
  ({ r, ps } = lobby(['A', 'B', 'C'])); ps.forEach((p, i) => { p.uid = 10 + i; });
  L.handle(r, ps[0].pid, { t: 'start' }, 2000, rigged([0])); L.handle(r, ps[2].pid, { t: 'leave' }, 2500); win(r, ps, 1);
  assert.deepEqual(L.pendingResults(r).map(x => x.uid).sort(), [10, 11]);
  // a rematch does not lose results that are still waiting to be saved, and does not carry the ranked flag over
  L.handle(r, ps[0].pid, { t: 'rematch' }, 9000); assert.deepEqual(L.pendingResults(r).map(x => x.uid).sort(), [10, 11]); assert.equal(r.ranked, false); L.clearResults(r);
  // farming: two accounts start with a bot, one leaves, the other beats the bot alone -> nothing is saved
  ({ r, ps } = lobby(['A', 'B'])); ps[0].uid = 20; ps[1].uid = 21; L.handle(r, ps[0].pid, { t: 'addBot' }, 1500);
  L.handle(r, ps[0].pid, { t: 'start' }, 2000, rigged([0])); assert.equal(r.ranked, true); L.handle(r, ps[1].pid, { t: 'leave' }, 2500); win(r, ps, 0);
  assert.deepEqual(L.pendingResults(r), [], 'a win over bots after the other person left does not count');
});
test('host can remove a player mid-game (they become a bot) and can close the room; others cannot', () => {
  const { r, ps } = started(['A', 'B', 'C'], 0, 1000);
  assert.equal(L.handle(r, ps[1].pid, { t: 'remove', pid: ps[2].pid }, 2000).code, 'not_host');
  const bot = L.handle(r, ps[0].pid, { t: 'addBot' }, 2000); assert.equal(bot.code, 'bad_phase');
  const k = L.handle(r, ps[0].pid, { t: 'remove', pid: ps[2].pid }, 2000);
  assert.deepEqual(k.kicked, [ps[2].pid]); assert.equal(ps[2].bot, true); assert.equal(ps[2].left, true); assert.equal(ps[2].secret, null); assert.equal(r.players.length, 3);
  assert.equal(L.join(r, { pid: ps[2].pid, secret: 'x' }, 3000).code, 'seat_gone');
  assert.equal(L.handle(r, ps[0].pid, { t: 'remove', pid: ps[2].pid }, 2000).code, 'bad_target');       // bots stay until the game is over
  assert.equal(L.handle(r, ps[1].pid, { t: 'close' }, 2000).code, 'not_host');
  assert.equal(L.handle(r, ps[0].pid, { t: 'close' }, 2000).closed, true);
});
test('fuzz: hundreds of random rooms with joins, kicks, leaves, drops and timers never break the rules', () => {
  let seed = 12345; const rnd = k => { seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return Math.floor(((t ^ (t >>> 14)) >>> 0) / 4294967296 * k); };
  const seen = { over: 0, leaves: 0, kicks: 0, drops: 0 };
  for (let g = 0; g < 400; g++) {
    let now = 1000; const r = fresh(now); const seats = [];
    for (let i = 0, c = 1 + rnd(4); i < c; i++) { const j = L.join(r, { name: 'P' + i, uid: rnd(3) ? 100 + i : undefined }, now, rnd); if (j.ok) seats.push(j.player); }
    if (!seats.length) continue;
    for (let i = 0, c = rnd(3); i < c; i++) L.handle(r, r.hostPid, { t: 'addBot' }, now, rnd);
    L.handle(r, r.hostPid, { t: 'rules', six: !!rnd(2) }, now);
    L.handle(r, r.hostPid, { t: 'start' }, now, rnd);
    for (let step = 0; step < 900 && r.phase !== 'closed'; step++) {
      now += 500 + rnd(4000);
      const s = seats[rnd(seats.length)], a = rnd(12);
      if (a === 0) { L.disconnect(r, s.pid, now); seen.drops++; }
      else if (a === 1) L.join(r, { pid: s.pid, secret: s.secret }, now);
      else if (a === 2 && rnd(3) === 0) { L.handle(r, s.pid, { t: 'leave' }, now); seen.leaves++; }
      else if (a === 3 && rnd(3) === 0) { if (L.handle(r, r.hostPid || s.pid, { t: 'remove', pid: seats[rnd(seats.length)].pid }, now).kicked) seen.kicks++; }
      else if (a < 8) L.handle(r, s.pid, { t: 'roll' }, now, rnd);
      const t = L.tick(r, now, rnd);
      // invariants
      assert.ok(r.players.every(p => p.pos >= 0 && p.pos <= 100), 'position in range');
      assert.ok(r.players.length <= E.MAX_PLAYERS);
      if (r.players.length) assert.ok(r.turn >= 0 && r.turn < r.players.length, 'turn in range');
      const hp = r.players.filter(p => !p.bot); if (hp.length) assert.ok(r.players.some(p => p.pid === r.hostPid && !p.bot), 'host is a present human');
      assert.equal(new Set(r.players.map(p => p.pid)).size, r.players.length, 'unique pids');
      JSON.stringify(L.publicState(r, now));
      if (r.phase === 'over') { seen.over++; assert.ok(!r.players.some(p => p.pid === r.winnerPid) || r.players.find(p => p.pid === r.winnerPid).pos === 100, 'the winner (if still seated) is on 100'); L.pendingResults(r).forEach(x => assert.ok(Number.isInteger(x.uid))); break; }
      if (t.closed) break;
    }
  }
  assert.ok(seen.over > 40 && seen.leaves > 50 && seen.kicks > 20 && seen.drops > 100, 'the fuzz really exercised games, leaves, kicks and drops: ' + JSON.stringify(seen));
});

console.log(`\n${n} logic tests passed`);
