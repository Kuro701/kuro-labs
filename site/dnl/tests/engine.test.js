'use strict';
// Run with: node site/dnl/tests/engine.test.js
const assert = require('node:assert/strict');
const E = require('../../../public/games/dragons-and-ladders/engine.js');

let n = 0;
const test = (name, fn) => { fn(); n++; console.log('ok -', name); };

test('jump table is valid', () => assert.deepEqual(E.checkJumps(), []));
test('checkJumps catches mistakes', () => {
  assert.ok(E.checkJumps([{ kind: 'dragon', from: 10, to: 20 }]).length);
  assert.ok(E.checkJumps([{ kind: 'ladder', from: 10, to: 5 }]).length);
  assert.ok(E.checkJumps([{ kind: 'ladder', from: 10, to: 20 }, { kind: 'ladder', from: 20, to: 30 }]).length);
  assert.ok(E.checkJumps([{ kind: 'ladder', from: 100, to: 100 }]).length);
});
test('plain move', () => {
  const o = E.rollOutcome(1, 3);
  assert.deepEqual(o.path, [2, 3, 4]); assert.equal(o.end, 4); assert.equal(o.jump, null); assert.equal(o.win, false); assert.equal(o.stay, false);
});
test('from the start pad', () => {
  const o = E.rollOutcome(0, 4);
  assert.deepEqual(o.path, [1, 2, 3, 4]); assert.equal(o.end, 4);
});
test('ladder climbs (7 + 1 -> 8 -> 33)', () => {
  const o = E.rollOutcome(7, 1);
  assert.equal(o.jump.kind, 'ladder'); assert.equal(o.end, 33); assert.deepEqual(o.path, [8]);
});
test('dragon carries down (44 + 6 -> 50 -> 9)', () => {
  const o = E.rollOutcome(44, 6);
  assert.equal(o.jump.kind, 'dragon'); assert.equal(o.jump.color, 'purple'); assert.equal(o.end, 9);
});
test('exact finish wins, overshoot stays', () => {
  const w = E.rollOutcome(99, 1); assert.equal(w.win, true); assert.equal(w.end, 100);
  const s = E.rollOutcome(99, 2); assert.equal(s.stay, true); assert.equal(s.end, 99); assert.equal(s.need, 1); assert.deepEqual(s.path, []);
  const s2 = E.rollOutcome(97, 6); assert.equal(s2.stay, true); assert.equal(s2.need, 3);
});
test('98 is a dragon head, so landing there carries you to 44', () => {
  const o = E.rollOutcome(95, 3); assert.equal(o.end, 44);
});
test('every jump is reachable and lands where the table says', () => {
  for (const j of E.JUMPS) {
    const pos = Math.max(0, j.from - 6), roll = j.from - pos;
    const o = E.rollOutcome(pos, roll);
    assert.equal(o.jump && o.jump.from, j.from); assert.equal(o.end, j.to);
  }
});
test('no move ever ends on a jump start (so one jump is always final)', () => {
  for (let p = 0; p < 100; p++) for (let r = 1; r <= 6; r++) {
    if (E.JUMP_AT[p]) continue;   // nobody can stand on a jump start
    const o = E.rollOutcome(p, r); assert.equal(E.JUMP_AT[o.end], undefined, `pos ${p} roll ${r} ended on ${o.end}`);
  }
});
test('turn order without the six rule', () => {
  assert.deepEqual(E.nextTurn({ turn: 0, sixes: 0, count: 3, six: false }, 6), { turn: 1, sixes: 0, extra: false });
  assert.deepEqual(E.nextTurn({ turn: 2, sixes: 0, count: 3, six: false }, 2), { turn: 0, sixes: 0, extra: false });
});
test('six rule: extra roll, at most two in a row', () => {
  let t = { turn: 1, sixes: 0, count: 2, six: true };
  let r = E.nextTurn(t, 6); assert.deepEqual(r, { turn: 1, sixes: 1, extra: true });
  r = E.nextTurn({ ...t, sixes: 1 }, 6); assert.deepEqual(r, { turn: 1, sixes: 2, extra: true });
  r = E.nextTurn({ ...t, sixes: 2 }, 6); assert.deepEqual(r, { turn: 0, sixes: 0, extra: false });
  r = E.nextTurn({ ...t, sixes: 1 }, 3); assert.deepEqual(r, { turn: 0, sixes: 0, extra: false });
});
test('animMs grows with the move', () => {
  const a = E.animMs(E.rollOutcome(0, 1)), b = E.animMs(E.rollOutcome(0, 6)), c = E.animMs(E.rollOutcome(44, 6));
  assert.ok(a < b && b < c);
});
test('random games always finish and never leave the board', () => {
  for (let g = 0; g < 500; g++) {
    let pos = 0, turns = 0;
    while (pos !== 100) {
      const o = E.rollOutcome(pos, 1 + Math.floor(Math.random() * 6));
      assert.ok(o.end >= 0 && o.end <= 100); pos = o.end; turns++; assert.ok(turns < 5000);
    }
  }
});
console.log(`\n${n} engine tests passed`);
