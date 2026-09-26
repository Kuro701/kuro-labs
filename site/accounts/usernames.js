'use strict';
/* Usernames: the format rules, the reserved names and the bad-word filter.
 *
 * Format: 3-20 characters, ASCII letters, digits, "_" and "-", starting with a letter or digit.
 * Uniqueness is case-insensitive (the caller stores username_lower with a UNIQUE index).
 *
 * The filter looks at a "folded" copy of the name: lower case, accents removed, look-alike digits and symbols turned into
 * letters (0 -> o, 1 -> i, 3 -> e, 4 -> a, 5 -> s, 7 -> t, 8 -> b, @ -> a, $ -> s, ! -> i, + -> t), separators and other
 * digits dropped, so "s_l_u_r" and "sl.ur" and "5lur" all fold to the same letters. Then:
 *   - terms of 5+ letters block a name if they appear ANYWHERE in it (also with repeated letters squeezed: "niiigger"),
 *   - terms of 4 or fewer letters only block when they are a whole word in the name (words = the parts between separators),
 *     so ordinary names that merely contain them (the famous "Scunthorpe" problem) are not refused.
 * The word lists (English + Czech) live in data/blocklist.json and can be extended without touching this code.
 * No filter catches everything: players can report a name and an admin can rename it.
 */
const cfg = require('./config.js');
const list = require('./data/blocklist.json');

const FORMAT = /^[A-Za-z0-9][A-Za-z0-9_-]{2,19}$/;
const MARKS = new RegExp('[' + String.fromCharCode(0x300) + '-' + String.fromCharCode(0x36f) + ']', 'g');   // combining accents
const LEET = { '0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's', '7': 't', '8': 'b', '@': 'a', '$': 's', '!': 'i', '+': 't', '|': 'i' };

function stripAccents(s) { return String(s).normalize('NFD').replace(MARKS, '').normalize('NFC'); }

// Turn text into a list of lower-case letter-only words (separators and unmapped digits split words).
function words(text) {
  let s = stripAccents(String(text)).toLowerCase();
  s = s.replace(/(^|[^a-z0-9])[0-9]+(?![a-z0-9])/g, '$1 ');            // a part made only of digits ("Player-7179") is a number, not disguised letters
  s = Array.from(s).map(ch => (LEET[ch] !== undefined ? LEET[ch] : ch)).join('');
  return s.split(/[^a-z]+/).filter(Boolean);
}
const squeeze = s => s.replace(/(.)\1+/g, '$1');

// Prepared once: [{ term, short, sq }]
const TERMS = (() => {
  const raw = [].concat(list.en || [], list.cs || [], list.extra || []);
  const seen = new Set(), out = [];
  for (const t of raw) {
    const ws = words(t);                       // multi-word entries ("foo bar") become one run of letters
    const term = ws.join('');
    if (term.length < 3 || seen.has(term)) continue;
    seen.add(term);
    out.push({ term, short: term.length <= 4, sq: squeeze(term) });
  }
  return out;
})();
const ALLOW = new Set((list.allow || []).map(w => words(w).join('')));          // ordinary words that contain a listed term
const RESERVED = new Set(cfg.RESERVED_NAMES.map(n => words(n).join('')));

// Which bad-word term does this text contain? (null when none). Exposed for the tests and the admin tool.
function findBadTerm(text) {
  const ws = words(text).filter(w => !ALLOW.has(w));
  if (!ws.length) return null;
  const joined = ws.join(''), joinedSq = squeeze(joined), wsSq = ws.map(squeeze);
  for (const t of TERMS) {
    const useSq = t.sq.length >= 4;               // squeezing repeated letters is only safe for terms that stay 4+ letters long
    if (t.short) { if (ws.indexOf(t.term) >= 0 || (useSq && wsSq.indexOf(t.sq) >= 0)) return t.term; }
    else if (joined.indexOf(t.term) >= 0 || (useSq && joinedSq.indexOf(t.sq) >= 0)) return t.term;
  }
  return null;
}

// Reserved if the name equals a reserved word after look-alike folding ("adm1n"), or after dropping trailing digits
// ("admin123"), or after dropping every digit ("ad2min"). "KuroFan" is fine; "Kuro", "Kur0" and "kuro7" are not.
function isReserved(text) {
  const t = String(text);
  return [words(t).join(''), words(t.replace(/[0-9]+$/, '')).join(''), words(t.replace(/[0-9]+/g, '')).join('')].some(v => RESERVED.has(v));
}

/* -> { ok: true, name } or { ok: false, code: 'format' | 'unavailable', message }
   'format' errors are specific (they help people fix a typo); 'unavailable' is deliberately vague (reserved, filtered). */
function validate(input) {
  const name = String(input == null ? '' : input).trim();
  if (!FORMAT.test(name)) {
    return { ok: false, code: 'format', message: 'Use 3 to 20 letters, numbers, "_" or "-", starting with a letter or number.' };
  }
  if (/[_-]{3,}/.test(name)) return { ok: false, code: 'format', message: 'Use 3 to 20 letters, numbers, "_" or "-", starting with a letter or number.' };
  if (isReserved(name) || findBadTerm(name)) return { ok: false, code: 'unavailable', message: "That name isn't available." };
  return { ok: true, name };
}

// A neutral replacement name for when an admin renames someone.
function neutralName(rng) {
  for (let i = 0; i < 50; i++) {
    const name = 'Player-' + ((typeof rng === 'function' ? rng(9000) : Math.floor(Math.random() * 9000)) + 1000);
    if (validate(name).ok) return name;
  }
  return 'Player-1000';
}

module.exports = { validate, findBadTerm, isReserved, neutralName, words, TERM_COUNT: TERMS.length };
