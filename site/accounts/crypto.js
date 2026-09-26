'use strict';
/* Small crypto helpers (WebCrypto: the same code runs in the Worker and in Node). */
const subtle = globalThis.crypto.subtle;
const enc = new TextEncoder();

const hex = buf => Array.from(new Uint8Array(buf), b => b.toString(16).padStart(2, '0')).join('');
function b64url(bytes) {
  let s = ''; for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
const randomBytes = n => globalThis.crypto.getRandomValues(new Uint8Array(n));
const randomToken = (bytes = 32) => b64url(randomBytes(bytes));            // 256 bits by default

function randomInt(max) {                                                   // uniform integer in [0, max)
  const a = new Uint32Array(1), lim = Math.floor(0x100000000 / max) * max;
  do { globalThis.crypto.getRandomValues(a); } while (a[0] >= lim);
  return a[0] % max;
}
const randomDigits = n => Array.from({ length: n }, () => randomInt(10)).join('');

async function sha256Hex(text) { return hex(await subtle.digest('SHA-256', enc.encode(text))); }
async function hmacHex(secret, message) {
  const key = await subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hex(await subtle.sign('HMAC', key, enc.encode(message)));
}
function safeEqual(a, b) {                                                  // constant-time string compare
  a = String(a); b = String(b);
  if (a.length !== b.length) return false;
  let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

/* Passwords: PBKDF2-SHA256, random 16-byte salt, 100000 rounds (the most Cloudflare Workers allows). Stored as "pbkdf2$rounds$salt$hash". */
const PBKDF2_ROUNDS = 100000;
const fromB64url = t => { const b = atob(t.replace(/-/g, '+').replace(/_/g, '/')); return Uint8Array.from(b, c => c.charCodeAt(0)); };
async function pbkdf2(password, salt, rounds) {
  const key = await subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  return new Uint8Array(await subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: rounds }, key, 256));
}
async function hashPassword(password) {
  const salt = randomBytes(16);
  return 'pbkdf2$' + PBKDF2_ROUNDS + '$' + b64url(salt) + '$' + b64url(await pbkdf2(password, salt, PBKDF2_ROUNDS));
}
async function verifyPassword(password, stored) {
  const m = /^pbkdf2\$(\d+)\$([\w-]+)\$([\w-]+)$/.exec(String(stored || ''));
  if (!m) { await pbkdf2(String(password), new Uint8Array(16), PBKDF2_ROUNDS); return false; }   // same work whether or not there is a password
  return safeEqual(b64url(await pbkdf2(String(password), fromB64url(m[2]), Number(m[1]))), m[3]);
}

module.exports = { hashPassword, verifyPassword, randomToken, randomInt, randomDigits, sha256Hex, hmacHex, safeEqual, b64url };
