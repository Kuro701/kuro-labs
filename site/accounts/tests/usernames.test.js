'use strict';
// Run with: node site/accounts/tests/usernames.test.js
const assert = require('node:assert/strict');
const U = require('../usernames.js');
const list = require('../data/blocklist.json');

let n = 0;
const test = (name, fn) => { fn(); n++; console.log('ok -', name); };

test('the word lists loaded', () => { assert.ok(U.TERM_COUNT > 300, 'terms: ' + U.TERM_COUNT); });

test('format rules (specific messages) ', () => {
  for (const good of ['Zed2', 'abc', 'A_b-C', 'Dragon_Slayer', 'x'.repeat(20), '123', 'a-b']) assert.equal(U.validate(good).ok, true, good);
  for (const bad of ['', 'ab', 'x'.repeat(21), '_abc', '-abc', 'a b', 'a.b', 'abéc', 'a___b', 'a@b', '<script>', null, undefined]) {
    const r = U.validate(bad); assert.equal(r.ok, false, String(bad)); assert.equal(r.code, 'format', String(bad));
  }
  assert.equal(U.validate('  Zed2  ').name, 'Zed2');            // surrounding spaces are trimmed
});

test('reserved names, in every disguise, and with digits or separators', () => {
  for (const r of ['admin', 'Admin', 'ADMIN', 'adm1n', 'a_d_m_i_n', 'admin123', 'Admin_', 'kuro', 'Kur0', 'kuro_labs', 'KuroLabs', 'mytheder', 'Support', 'sys7em']) {
    const v = U.validate(r); assert.equal(v.ok, false, r); assert.equal(v.code, 'unavailable', r);
  }
  for (const okName of ['KuroFan', 'kuro_fan', 'Administrator_of_fun', 'supporter', 'Mythederfan']) assert.equal(U.validate(okName).ok, true, okName);
});

test('innocent names that merely contain a short bad word are not refused', () => {
  const innocent = ['Scunthorpe', 'Assassin', 'Classic', 'Cumberland', 'Bass_Drop', 'Sussex', 'Penistone', 'Grasshopper', 'Passage', 'Analyst', 'Hancock',
    'Dragon_Slayer', 'Ladder-King', 'Player1', 'Kuro_Fan', 'Butterfly', 'Shiitake', 'Therapist', 'Peacock', 'Cocktail', 'Dickens', 'Mississippi', 'Essex_Girl', 'Ace_of_Spades', 'Nigeria', 'Nigerian', 'Therapist', 'Penistone'];
  const failed = innocent.filter(nm => !U.validate(nm).ok);
  assert.deepEqual(failed, [], 'wrongly refused: ' + failed.join(', '));
});

test('every list term is refused: plain, with separators, stretched, in leet and inside a longer name', () => {
  const ascii = t => /^[a-z ]+$/.test(t);
  let checked = 0;
  for (const t of [].concat(list.en, list.cs)) {
    const w = U.words(t).join(''); if (w.length < 3) continue;
    const base = t.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/ /g, '');
    if (!/^[a-z]+$/.test(base) || base.length > 18) continue;
    if (base.length <= 4) {                                            // short: refused as a whole word
      assert.ok(U.findBadTerm(base), 'plain #' + checked);
      assert.ok(U.findBadTerm('xx_' + base + '_yy'), 'as a word #' + checked);
    } else {
      assert.equal(U.validate(base).ok, false, 'plain #' + checked + ' len ' + base.length);
      if (base.length <= 10) assert.equal(U.validate(base.split('').join('_')).ok, false, 'separated #' + checked);
      assert.equal(U.validate('my' + base).ok, false, 'inside #' + checked);
      assert.equal(U.validate(base.toUpperCase()).ok, false, 'upper #' + checked);
      const leet = base.replace(/o/g, '0').replace(/e/g, '3').replace(/a/g, '4').replace(/s/g, '5').replace(/i/g, '1');
      if (leet.length <= 20) assert.equal(U.validate(leet).ok, false, 'leet #' + checked);
      const stretched = base.replace(/(.)/, '$1$1$1');
      if (stretched.length <= 20) assert.equal(U.validate(stretched).ok, false, 'stretched #' + checked);
    }
    checked++;
  }
  assert.ok(checked > 250, 'checked ' + checked);
});

test('numbers on their own are not read as disguised letters, but digits inside a word still are', () => {
  for (const nm of ['Player-7179', 'Player-2717', 'Gamer_1337', '1337', '5555', 'Dragon-4556-Fan']) assert.equal(U.validate(nm).ok, true, nm);
  let refused = 0; for (let i = 1000; i < 10000; i++) if (!U.validate('Player-' + i).ok) refused++; assert.equal(refused, 0);
  assert.equal(U.findBadTerm('4ss'), U.findBadTerm('ass'), 'digits inside a word are still folded');
  assert.ok(U.findBadTerm('a55'), 'digits stuck to a word are still folded');
});
test('unavailable is vague on purpose (no hint which rule fired)', () => {
  const reserved = U.validate('admin'), bad = U.validate(list.en.find(t => /^[a-z]{7,10}$/.test(t)));
  assert.equal(reserved.message, bad.message); assert.equal(bad.message, "That name isn't available.");
});

test('neutralName always passes the rules', () => {
  for (let i = 0; i < 300; i++) { const nm = U.neutralName(); assert.equal(U.validate(nm).ok, true, nm); }
});
console.log(`\n${n} username tests passed`);
