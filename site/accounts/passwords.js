'use strict';
/* Password rules. Long beats clever: at least 10 characters, no other requirements, except not the username and not one of the very common ones. */
const MIN = 10, MAX = 128;
const COMMON = new Set(['password','passw0rd','1234567890','12345678910','qwertyuiop','qwerty1234','qwerty12345','password1','password12','password123','password1234','iloveyou12','1q2w3e4r5t','abcdefghij','0123456789','9876543210','letmein123','welcome123','admin12345','changeme123','football123','monkey1234','dragon1234','princess12','sunshine12','trustno1234','1111111111','0000000000','aaaaaaaaaa','zaq12wsxcde','heslo12345','kurolabs123']);

function validate(pw, username) {
  if (typeof pw !== 'string') return { ok: false, code: 'bad_password', message: 'Please choose a password.' };
  if (pw.length < MIN) return { ok: false, code: 'bad_password', message: `Use at least ${MIN} characters. A few random words in a row make a good password.` };
  if (pw.length > MAX) return { ok: false, code: 'bad_password', message: `Use at most ${MAX} characters.` };
  const low = pw.toLowerCase();
  if (COMMON.has(low) || /^(.)\1+$/.test(pw)) return { ok: false, code: 'bad_password', message: 'That password is too common. Please pick another.' };
  if (username && low.replace(/[^a-z0-9]/g, '') === String(username).toLowerCase().replace(/[^a-z0-9]/g, '')) return { ok: false, code: 'bad_password', message: "Your password can't be the same as your username." };
  return { ok: true };
}
module.exports = { validate, MIN, MAX };
