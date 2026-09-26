/* Dragons & Ladders — rules engine.
 *
 * ONE file used by BOTH the browser game (loaded with a plain <script>, defines the global
 * DnlEngine) and the room server (require()d / bundled, exports the same object).
 * Keep it free of any browser or server APIs: plain data in, plain data out.
 *
 * Squares are numbered 1..100 in the usual zig-zag: 1 is bottom-left, 100 is top-left.
 * Position 0 means "not on the board yet".
 * A dragon carries you DOWN from its head (from) to its tail (to).
 * A ladder carries you UP from its foot (from) to its top (to).
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  else root.DnlEngine = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // Read off the board picture (public/games/dragons-and-ladders/board.webp).
  var JUMPS = [
    { kind: 'dragon', color: 'red',    from: 98, to: 44 },
    { kind: 'dragon', color: 'blue',   from: 88, to: 48 },
    { kind: 'dragon', color: 'green',  from: 66, to: 26 },
    { kind: 'dragon', color: 'purple', from: 50, to: 9 },
    { kind: 'ladder',                  from: 76, to: 96 },
    { kind: 'ladder',                  from: 69, to: 91 },
    { kind: 'ladder',                  from: 38, to: 79 },
    { kind: 'ladder',                  from: 17, to: 37 },
    { kind: 'ladder',                  from: 8,  to: 33 }
  ];

  var JUMP_AT = {};
  for (var i = 0; i < JUMPS.length; i++) JUMP_AT[JUMPS[i].from] = JUMPS[i];

  var MAX_PLAYERS = 4;
  var GOAL = 100;

  // Returns a list of problems with the jump table (empty = fine).
  function checkJumps(jumps) {
    var problems = [], starts = {};
    (jumps || JUMPS).forEach(function (j) { starts[j.from] = true; });
    (jumps || JUMPS).forEach(function (j) {
      if (!(j.from >= 1 && j.from <= 99 && j.to >= 1 && j.to <= 100 && j.from !== j.to)) problems.push('out of range: ' + JSON.stringify(j));
      if (j.kind === 'dragon' && j.to >= j.from) problems.push('dragon must go down: ' + JSON.stringify(j));
      if (j.kind === 'ladder' && j.to <= j.from) problems.push('ladder must go up: ' + JSON.stringify(j));
      if (j.kind !== 'dragon' && j.kind !== 'ladder') problems.push('unknown kind: ' + JSON.stringify(j));
      if (starts[j.to]) problems.push('a jump ends on another jump start (chains are not supported): ' + JSON.stringify(j));
    });
    return problems;
  }

  /* What happens when a player on `pos` rolls `roll`. Pure; never touches any state.
     stay: true      -> would go past 100, so the player does not move
     path            -> the squares stepped through, one by one (empty when staying)
     jump            -> the dragon or ladder landed on, or null
     end             -> where the player finishes the move
     win             -> reached exactly 100 */
  function rollOutcome(pos, roll) {
    var target = pos + roll;
    if (target > GOAL) {
      return { stay: true, need: GOAL - pos, target: target, path: [], jump: null, end: pos, win: false };
    }
    var path = [];
    for (var s = pos + 1; s <= target; s++) path.push(s);
    var jump = JUMP_AT[target] || null;
    var end = jump ? jump.to : target;
    return { stay: false, target: target, path: path, jump: jump, end: end, win: end === GOAL };
  }

  /* Whose turn is next. `t` = { turn, sixes, count, six }.
     With the "six = roll again" rule a player may roll again after a six, at most twice in a row. */
  function nextTurn(t, roll) {
    if (t.six && roll === 6 && t.sixes < 2) return { turn: t.turn, sixes: t.sixes + 1, extra: true };
    return { turn: (t.turn + 1) % t.count, sixes: 0, extra: false };
  }

  // Rough time (ms) the animation of a roll takes on a client at normal speed. The server uses it to pace turns.
  function animMs(out) {
    var ms = 700;                       // dice tumble
    if (out.stay) ms += 500;
    else ms += 150 * out.path.length;   // hops
    if (out.jump) ms += out.jump.kind === 'ladder' ? 1000 : 1300;
    return ms + 300;                    // margin
  }

  return {
    JUMPS: JUMPS, JUMP_AT: JUMP_AT, MAX_PLAYERS: MAX_PLAYERS, GOAL: GOAL,
    checkJumps: checkJumps, rollOutcome: rollOutcome, nextTurn: nextTurn, animMs: animMs
  };
});
