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

module.exports = { randomToken, randomInt, randomDigits, sha256Hex, hmacHex, safeEqual, b64url };
