/* Kuro Labs accounts: the Log in button, the login / sign-up dialogs, the /account/ page and the /admin/ page.
 * Plain JavaScript, no libraries. Does nothing at all (the button stays hidden) until the server says accounts are switched on.
 * Not loaded on the game pages: games only reach the account through the API. */
(() => {
'use strict';
const root = document.getElementById('kl-techno'); if (!root) return;
const slot = document.getElementById('kl-account');
const isAccountPage = !!document.getElementById('kl-account-page'), isAdminPage = !!document.getElementById('kl-admin-page'), isLeaderboardPage = !!document.getElementById('kl-leaderboard-page');
const GAMES = { 'dragons-and-ladders': 'Dragons & Ladders' };
const S = { config: null, me: null };

/* ---------- small helpers ---------- */
function el(tag, attrs, ...kids) {
  const n = document.createElement(tag);
  for (const k in (attrs || {})) {
    const v = attrs[k]; if (v === false || v == null) continue;
    if (k === 'class') n.className = v; else if (k.slice(0, 2) === 'on') n.addEventListener(k.slice(2), v); else if (k === 'html') n.innerHTML = v; else n.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat()) if (c != null && c !== false) n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  return n;
}
async function api(path, opt) {
  opt = opt || {};
  let r, j = null;
  try { r = await fetch(path, { method: opt.method || 'GET', credentials: 'same-origin', headers: opt.body ? { 'content-type': 'application/json' } : undefined, body: opt.body ? JSON.stringify(opt.body) : undefined }); }
  catch (e) { const err = new Error('Could not reach the server. Check your connection and try again.'); err.code = 'network'; throw err; }
  try { j = await r.json(); } catch (e) { /* not JSON */ }
  if (!r.ok || !j || j.ok === false) { const err = new Error((j && j.message) || 'Something went wrong. Please try again.'); err.code = j && j.error; err.data = j; err.status = r.status; throw err; }
  return j;
}
let toastTimer;
function toast(text, bad) {
  let t = document.getElementById('kl-toast');
  if (!t) { t = el('div', { id: 'kl-toast', class: 'kl-toast', role: 'status' }); root.appendChild(t); }
  t.textContent = text; t.className = 'kl-toast kl-show' + (bad ? ' kl-bad' : ''); clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.className = 'kl-toast'; }, 7000);
}
function makeDialog(title, { closable = true } = {}) {
  document.querySelectorAll('dialog.kl-dialog[open]').forEach(d => d.close());
  const dlg = el('dialog', { class: 'kl-dialog', 'aria-label': title });
  const body = el('div', { class: 'kl-dialog-body' });
  dlg.append(el('div', { class: 'kl-dialog-head' }, el('h2', {}, title), closable ? el('button', { type: 'button', class: 'kl-x', 'aria-label': 'Close', onclick: () => dlg.close() }, '×') : null), body);
  if (!closable) dlg.addEventListener('cancel', e => e.preventDefault());
  dlg.addEventListener('close', () => dlg.remove());
  root.appendChild(dlg); dlg.showModal(); return { dlg, body };
}
const errBox = () => el('p', { class: 'kl-err', role: 'alert' });
function busy(btn, on) { btn.disabled = on; btn.dataset.label = btn.dataset.label || btn.textContent; btn.textContent = on ? 'One moment…' : btn.dataset.label; }
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{2,19}$/;

/* ---------- the security check (loaded only when someone chooses email login) ---------- */
let tsPromise = null;
function loadTurnstile() {
  if (!tsPromise) tsPromise = new Promise((res, rej) => {
    const s = document.createElement('script'); s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit'; s.async = true;
    s.onload = () => res(window.turnstile); s.onerror = () => { tsPromise = null; rej(new Error('Could not load the security check. Please try again.')); }; document.head.appendChild(s);
  });
  return tsPromise;
}

/* ---------- email code panel: used for logging in, re-checking and adding an email ---------- */
function emailPanel(purpose, onDone, opts) {
  opts = opts || {};
  const box = el('div', { class: 'kl-email' }), err = errBox();
  let token = null, widget = null, emailValue = '', resendAt = 0, timer = null;
  const emailInput = el('input', { type: 'email', id: 'kl-email-' + purpose, autocomplete: 'email', inputmode: 'email', placeholder: 'you@example.com', required: true, maxlength: 254 });
  const ts = el('div', { class: 'kl-ts' });
  const send = el('button', { type: 'button', class: 'kl-action kl-primary', disabled: true }, 'Send me a code');
  const step1 = el('div', {}, el('label', { for: emailInput.id }, opts.emailLabel || 'Your email address'), emailInput, ts, send);
  const codeInput = el('input', { type: 'text', inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: 8, placeholder: '123456', 'aria-label': 'The 6-digit code from the email', class: 'kl-code' });
  const go = el('button', { type: 'button', class: 'kl-action kl-primary' }, opts.verifyLabel || 'Check code');
  const again = el('button', { type: 'button', class: 'kl-link', disabled: true }, 'Send a new code');
  const other = el('button', { type: 'button', class: 'kl-link' }, 'Use a different email');
  const sentText = el('p', { class: 'kl-note' });
  const step2 = el('div', { hidden: true }, sentText, el('label', { for: '' }, 'Code'), codeInput, go, el('div', { class: 'kl-row' }, again, other));
  box.append(step1, step2, err);

  loadTurnstile().then(t => { widget = t.render(ts, { sitekey: S.config.turnstileSiteKey, theme: 'dark', callback: tk => { token = tk; send.disabled = !token; }, 'expired-callback': () => { token = null; send.disabled = true; }, 'error-callback': () => { token = null; send.disabled = true; } }); })
    .catch(e => { err.textContent = e.message; });
  const resetCheck = () => { token = null; send.disabled = true; try { if (window.turnstile && widget != null) window.turnstile.reset(widget); } catch (e) { /* ignore */ } };
  function tick() { const left = Math.ceil((resendAt - Date.now()) / 1000); again.disabled = left > 0; again.textContent = left > 0 ? 'Send a new code (' + left + 's)' : 'Send a new code'; if (left <= 0) clearInterval(timer); }
  async function sendCode() {
    err.textContent = ''; emailValue = emailInput.value.trim(); if (!emailValue) { err.textContent = 'Please type your email address.'; return; }
    busy(send, true);
    try {
      await api('/api/auth/email/start', { method: 'POST', body: { email: emailValue, turnstileToken: token, purpose } });
      step1.hidden = true; step2.hidden = false; sentText.textContent = 'We sent a 6-digit code to ' + emailValue + '. It works for 10 minutes. Check your spam folder if it does not arrive.';
      resendAt = Date.now() + 60000; clearInterval(timer); timer = setInterval(tick, 500); tick(); codeInput.focus();
    } catch (e) { err.textContent = e.message; if (e.code === 'wait') { step1.hidden = true; step2.hidden = false; } }
    busy(send, false); resetCheck();
  }
  send.addEventListener('click', sendCode);
  emailInput.addEventListener('keydown', e => { if (e.key === 'Enter' && !send.disabled) sendCode(); });
  again.addEventListener('click', () => { step2.hidden = true; step1.hidden = false; codeInput.value = ''; err.textContent = ''; emailInput.focus(); });
  other.addEventListener('click', () => { step2.hidden = true; step1.hidden = false; codeInput.value = ''; emailInput.value = ''; err.textContent = ''; emailInput.focus(); });
  async function verify() {
    err.textContent = ''; busy(go, true);
    try { const r = await api('/api/auth/email/verify', { method: 'POST', body: { email: emailValue, code: codeInput.value, purpose } }); clearInterval(timer); onDone(r); }
    catch (e) { err.textContent = e.message; busy(go, false); codeInput.select(); }
  }
  go.addEventListener('click', verify);
  codeInput.addEventListener('keydown', e => { if (e.key === 'Enter') verify(); });
  return box;
}

/* ---------- dialogs ---------- */
function pwField(id, label, autocomplete) {
  const input = el('input', { type: 'password', id, autocomplete, maxlength: 128, required: true });
  return { input, wrap: el('div', {}, el('label', { for: id }, label), input) };
}
const PW_MIN = 10;

function passwordLogin(dlg) {
  const err = errBox(), form = el('form', { novalidate: true });
  const name = el('input', { type: 'text', id: 'kl-login-name', autocomplete: 'username', maxlength: 40, spellcheck: 'false', autocapitalize: 'off' });
  const pw = pwField('kl-login-pw', 'Password', 'current-password');
  const go = el('button', { type: 'submit', class: 'kl-action kl-primary kl-wide' }, 'Log in');
  form.append(el('label', { for: name.id }, 'Username'), name, pw.wrap, go, err);
  form.addEventListener('submit', async e => {
    e.preventDefault(); err.textContent = '';
    if (!name.value.trim() || !pw.input.value) { err.textContent = 'Please type your username and password.'; return; }
    busy(go, true);
    try { await api('/api/auth/login', { method: 'POST', body: { username: name.value.trim(), password: pw.input.value } }); dlg.close(); location.reload(); }
    catch (e2) { err.textContent = e2.message; busy(go, false); pw.input.select(); }
  });
  return form;
}

function openLogin() {
  const { dlg, body } = makeDialog('Log in or sign up');
  body.append(passwordLogin(dlg));
  body.append(el('p', { class: 'kl-note' }, 'New here, or forgot your password? Use Discord or an email code below. The first time creates your account, after you agree to the rules and choose a password. You must be 18 or older to have an account.'));
  if (S.config.discord) body.append(el('a', { class: 'kl-action kl-primary kl-wide', href: '/api/auth/discord?next=' + encodeURIComponent(location.pathname === '/account/' ? '/account/' : '/') }, 'Continue with Discord'));
  if (S.config.discord && S.config.email) body.append(el('p', { class: 'kl-or' }, 'or with your email'));
  if (S.config.email) body.append(emailPanel('login', r => { dlg.close(); if (r.next === 'register') refresh(); else location.reload(); }));
  if (!S.config.email && !S.config.discord) body.append(el('p', {}, 'Login is not available right now.'));
}

function agreementFields(form) {
  const rules = el('input', { type: 'checkbox', id: 'kl-agree-rules' }), adult = el('input', { type: 'checkbox', id: 'kl-agree-18' });
  form.append(
    el('label', { class: 'kl-check', for: rules.id }, rules, el('span', {}, 'I have read and agree to the ', el('a', { href: '/rules/', target: '_blank', rel: 'noopener' }, 'community rules'), '.')),
    el('label', { class: 'kl-check', for: adult.id }, adult, el('span', {}, 'I am 18 or older.')));
  return { rules, adult, ok: () => rules.checked && adult.checked };
}

function openRegister() {
  const { dlg, body } = makeDialog('Almost there');
  const p = S.me.pending, err = errBox();
  body.append(el('p', { class: 'kl-note' }, p && p.kind === 'discord' ? 'Your Discord login worked.' : 'Your email address is confirmed.', ' Choose a username and a password and your account is ready.'));
  const form = el('form', { novalidate: true }); const ag = agreementFields(form);
  const name = el('input', { type: 'text', id: 'kl-username', autocomplete: 'off', maxlength: 20, spellcheck: 'false', autocapitalize: 'off' });
  const hint = el('p', { class: 'kl-note kl-hint' }, '3 to 20 letters, numbers, "_" or "-". Other players will see this name. You can change it once every 30 days.');
  const pw1 = pwField('kl-new-pw', 'Choose a password', 'new-password'), pw2 = pwField('kl-new-pw2', 'Type the password again', 'new-password');
  const pwHint = el('p', { class: 'kl-note kl-hint' }, 'At least ' + PW_MIN + ' characters. A few random words in a row make a good password. You will use it with your username to log in; Discord or email stays as your backup.');
  const submit = el('button', { type: 'submit', class: 'kl-action kl-primary kl-wide' }, 'Create my account');
  form.append(el('label', { for: name.id }, 'Choose a username'), name, hint, pw1.wrap, pw2.wrap, pwHint, submit, err);
  form.addEventListener('submit', async e => {
    e.preventDefault(); err.textContent = '';
    if (!ag.ok()) { err.textContent = 'Please agree to the rules and confirm that you are 18 or older.'; return; }
    if (!NAME_RE.test(name.value.trim())) { err.textContent = 'Use 3 to 20 letters, numbers, "_" or "-", starting with a letter or number.'; return; }
    if (pw1.input.value.length < PW_MIN) { err.textContent = 'Your password needs at least ' + PW_MIN + ' characters.'; return; }
    if (pw1.input.value !== pw2.input.value) { err.textContent = 'The two passwords are not the same.'; return; }
    busy(submit, true);
    try { await api('/api/auth/register', { method: 'POST', body: { agreedRules: true, is18: true, username: name.value.trim(), password: pw1.input.value } }); dlg.close(); location.reload(); }
    catch (e2) { err.textContent = e2.message; busy(submit, false); if (e2.code === 'no_pending') setTimeout(() => { dlg.close(); refresh(); }, 1800); }
  });
  body.append(form); name.focus();
}

function openRulesUpdate() {
  const { dlg, body } = makeDialog('The rules have changed', { closable: false });
  const err = errBox();
  body.append(el('p', { class: 'kl-note' }, 'Please read the ', el('a', { href: '/rules/', target: '_blank', rel: 'noopener' }, 'community rules'), ' again and accept them to keep using your account.'));
  const form = el('form', { novalidate: true }); const ag = agreementFields(form);
  const ok = el('button', { type: 'submit', class: 'kl-action kl-primary' }, 'Accept and continue'), out = el('button', { type: 'button', class: 'kl-action' }, 'Log out');
  form.append(el('div', { class: 'kl-row' }, ok, out), err);
  form.addEventListener('submit', async e => {
    e.preventDefault(); err.textContent = ''; if (!ag.ok()) { err.textContent = 'Please agree to the rules and confirm that you are 18 or older.'; return; }
    busy(ok, true); try { await api('/api/auth/accept-rules', { method: 'POST', body: { agreedRules: true, is18: true } }); dlg.close(); location.reload(); } catch (e2) { err.textContent = e2.message; busy(ok, false); }
  });
  out.addEventListener('click', logout); body.append(form);
}

async function logout(all) { try { await api('/api/auth/logout', { method: 'POST', body: { all: all === true } }); } catch (e) { /* the cookie is cleared either way when it works */ } location.href = '/'; }

/* ---------- the header button ---------- */
function renderHeader() {
  if (!slot) return; slot.textContent = ''; slot.hidden = false;
  const me = S.me && S.me.user;
  if (!me) { slot.append(el('button', { type: 'button', class: 'kl-acct-btn', onclick: openLogin }, 'Log in')); return; }
  const btn = el('button', { type: 'button', class: 'kl-acct-btn kl-signed-in', 'aria-haspopup': 'true', 'aria-expanded': 'false', 'aria-controls': 'kl-acct-menu' }, me.username, el('span', { 'aria-hidden': 'true' }, ' ▾'));
  const menu = el('div', { id: 'kl-acct-menu', class: 'kl-acct-menu', hidden: true },
    el('a', { href: '/account/' }, 'Account'), me.isAdmin ? el('a', { href: '/admin/' }, 'Admin') : null, el('button', { type: 'button', onclick: () => logout(false) }, 'Log out'));
  const close = () => { menu.hidden = true; btn.setAttribute('aria-expanded', 'false'); };
  btn.addEventListener('click', e => { e.stopPropagation(); const open = menu.hidden; menu.hidden = !open; btn.setAttribute('aria-expanded', String(open)); });
  document.addEventListener('click', e => { if (!slot.contains(e.target)) close(); });
  slot.addEventListener('keydown', e => { if (e.key === 'Escape') { close(); btn.focus(); } });
  slot.append(btn, menu);
}

/* ---------- /account/ ---------- */
const card = (title, ...kids) => el('section', { class: 'kl-card' }, el('h2', {}, title), ...kids);
function renderAccountPage() {
  const page = document.getElementById('kl-account-page'); page.textContent = '';
  const me = S.me.user;
  if (!me) { page.append(el('p', {}, 'Please log in to see your account.'), el('button', { type: 'button', class: 'kl-action kl-primary', onclick: openLogin }, 'Log in')); return; }
  const say = el('p', { class: 'kl-note', role: 'status' }), err = errBox();

  // name
  const nameForm = el('form', { novalidate: true }), nameIn = el('input', { type: 'text', value: me.username, maxlength: 20, autocomplete: 'off', id: 'kl-new-name', 'aria-label': 'Username' });
  const canRename = Date.now() >= me.renameAt, nameBtn = el('button', { type: 'submit', class: 'kl-action', disabled: !canRename }, 'Change name');
  nameForm.append(nameIn, nameBtn);
  const nameErr = errBox();
  nameForm.addEventListener('submit', async e => { e.preventDefault(); nameErr.textContent = ''; busy(nameBtn, true); try { await api('/api/me/username', { method: 'POST', body: { username: nameIn.value.trim() } }); toast('Name changed.'); await refresh(); } catch (e2) { nameErr.textContent = e2.message; busy(nameBtn, false); } });
  page.append(card('Your name', el('p', {}, 'Other players see this name.'), nameForm, nameErr,
    canRename ? null : el('p', { class: 'kl-note' }, 'You can change it again on ' + new Date(me.renameAt).toLocaleDateString() + '.')));

  // my games (numbers only the game server can change)
  { const box = el('div', {}, el('p', { class: 'kl-note' }, 'Loading…'));
    page.append(card('Your games', box));
    api('/api/me/stats').then(r => {
      box.textContent = '';
      if (!r.stats.length) { box.append(el('p', { class: 'kl-note' }, 'No results yet. Wins in online rooms with two or more people are saved here.')); return; }
      for (const g of r.stats) box.append(el('p', {}, el('strong', {}, (GAMES[g.game] || g.game) + ': '), g.won + (g.won === 1 ? ' win' : ' wins') + ' in ' + g.played + (g.played === 1 ? ' game' : ' games') + (g.bestTurns ? ', fastest win ' + g.bestTurns + ' turns' : '') + '.'));
      box.append(el('p', { class: 'kl-note' }, 'See the ', el('a', { href: '/leaderboard/' }, 'leaderboard'), '. You can hide yourself from it under Privacy below.'));
    }).catch(() => { box.textContent = 'Could not load your results.'; });
  }

  // password
  {
    const f = el('form', { novalidate: true }), pErr = errBox();
    const cur = me.fresh || !me.hasPassword ? null : pwField('kl-cur-pw', 'Current password', 'current-password');
    const n1 = pwField('kl-pw-1', 'New password', 'new-password'), n2 = pwField('kl-pw-2', 'New password again', 'new-password');
    const b = el('button', { type: 'submit', class: 'kl-action' }, me.hasPassword ? 'Change password' : 'Set a password');
    f.append(...(cur ? [cur.wrap] : []), n1.wrap, n2.wrap, b, pErr);
    f.addEventListener('submit', async e => {
      e.preventDefault(); pErr.textContent = '';
      if (n1.input.value.length < PW_MIN) { pErr.textContent = 'Your password needs at least ' + PW_MIN + ' characters.'; return; }
      if (n1.input.value !== n2.input.value) { pErr.textContent = 'The two passwords are not the same.'; return; }
      busy(b, true);
      try { await api('/api/me/password', { method: 'POST', body: { current: cur ? cur.input.value : undefined, password: n1.input.value } }); toast('Password saved. Other devices were logged out.'); await refresh(); }
      catch (e2) { pErr.textContent = e2.message; busy(b, false); }
    });
    page.append(card('Password', el('p', {}, me.hasPassword ? 'Change your password.' : 'This account has no password yet. Set one to log in with your username.'),
      f,
      el('p', { class: 'kl-note' }, 'Forgot it? Log in with Discord or an email code, then set a new one here.')));
  }

  // ways to log in
  const methods = el('ul', { class: 'kl-methods' });
  methods.append(el('li', {}, el('strong', {}, 'Discord: '), me.discord ? 'connected' : el('a', { href: '/api/auth/discord?purpose=link&next=/account/' }, S.config.discord ? 'Add Discord' : 'not available')),
    el('li', {}, el('strong', {}, 'Email: '), me.email || (S.config.email ? 'not added' : 'not available')));
  const add = el('div', {});
  if (!me.email && S.config.email) { const btn = el('button', { type: 'button', class: 'kl-action' }, 'Add an email address'); btn.addEventListener('click', () => { btn.replaceWith(emailPanel('link', () => { toast('Email address added.'); refresh(); }, { verifyLabel: 'Add this email' })); }); add.append(btn); }
  page.append(card('Ways to log in', el('p', {}, 'Your password logs you in, and these are your backup if you ever forget it.'), methods, add));

  // privacy + data
  const hide = el('input', { type: 'checkbox', id: 'kl-hide-lb', checked: me.hideLeaderboards });
  hide.addEventListener('change', async () => { try { await api('/api/me/settings', { method: 'POST', body: { hideLeaderboards: hide.checked } }); toast('Saved.'); } catch (e) { toast(e.message, true); hide.checked = !hide.checked; } });
  page.append(card('Privacy', el('label', { class: 'kl-check', for: hide.id }, hide, el('span', {}, 'Hide me from leaderboards')),
    el('p', {}, el('a', { class: 'kl-action', href: '/api/me/export', download: 'kurolabs-my-data.json' }, 'Download my data')), el('p', { class: 'kl-note' }, 'A file with everything we hold about your account. See the ', el('a', { href: '/privacy/' }, 'privacy note'), '.')));

  // sessions
  page.append(card('Logging out', el('button', { type: 'button', class: 'kl-action', onclick: () => logout(true) }, 'Log out on all devices')));

  // report
  const rName = el('input', { type: 'text', id: 'kl-report-name', maxlength: 20, placeholder: 'Their username', 'aria-label': 'Username to report' }), rWhy = el('textarea', { maxlength: 500, rows: 3, placeholder: 'What is wrong?', 'aria-label': 'What is wrong' });
  const rBtn = el('button', { type: 'submit', class: 'kl-action' }, 'Send report'), rErr = errBox(), rForm = el('form', { novalidate: true }, rName, rWhy, rBtn, rErr);
  rForm.addEventListener('submit', async e => { e.preventDefault(); rErr.textContent = ''; busy(rBtn, true); try { await api('/api/report', { method: 'POST', body: { username: rName.value, reason: rWhy.value } }); toast('Thank you, the report was sent.'); rForm.reset(); } catch (e2) { rErr.textContent = e2.message; } busy(rBtn, false); });
  page.append(card('Report a player', el('p', {}, 'Bad username or bad behaviour? Tell us.'), rForm));

  // delete
  const del = el('div', {});
  if (!me.fresh) {
    del.append(el('p', {}, 'For your safety, please confirm it is you before deleting your account.'));
    if (me.hasPassword) {
      const rf = el('form', { novalidate: true }), rp = pwField('kl-reauth-pw', 'Your password', 'current-password'), rb = el('button', { type: 'submit', class: 'kl-action' }, 'Confirm with password'), rErr2 = errBox();
      rf.append(rp.wrap, rb, rErr2);
      rf.addEventListener('submit', async e => { e.preventDefault(); rErr2.textContent = ''; busy(rb, true); try { await api('/api/auth/reauth', { method: 'POST', body: { password: rp.input.value } }); toast('Thank you.'); refresh(); } catch (e2) { rErr2.textContent = e2.message; busy(rb, false); } });
      del.append(rf);
    }
    if (me.discord && S.config.discord) del.append(el('p', {}, el('a', { class: 'kl-action', href: '/api/auth/discord?purpose=reauth&next=/account/' }, 'Confirm with Discord')));
    if (me.email && S.config.email) { const b = el('button', { type: 'button', class: 'kl-action' }, 'Confirm with my email'); b.addEventListener('click', () => b.replaceWith(emailPanel('reauth', () => { toast('Thank you.'); refresh(); }, { verifyLabel: 'Confirm', emailLabel: 'The email address of this account' }))); del.append(b); }
  } else {
    const conf = el('input', { type: 'text', id: 'kl-del-confirm', autocomplete: 'off', placeholder: me.username, 'aria-label': 'Type your username to confirm' });
    const b = el('button', { type: 'button', class: 'kl-action kl-danger' }, 'Delete my account for good'), dErr = errBox();
    b.addEventListener('click', async () => { dErr.textContent = ''; busy(b, true); try { await api('/api/me', { method: 'DELETE', body: { confirm: conf.value } }); location.href = '/?deleted=1'; } catch (e) { dErr.textContent = e.message; busy(b, false); } });
    del.append(el('p', {}, 'This deletes your username, login details, saves and stats. It cannot be undone. Type your username to confirm.'), conf, b, dErr);
  }
  page.append(card('Delete my account', del), say, err);
}

/* ---------- /leaderboard/ (public: no login needed to look) ---------- */
async function renderLeaderboard() {
  const page = document.getElementById('kl-leaderboard-page'); page.textContent = '';
  for (const game of Object.keys(GAMES)) {
    let rows;
    try { rows = (await api('/api/leaderboard/' + game)).players; } catch (e) { page.append(el('p', { class: 'kl-note' }, 'The leaderboard is not available right now.')); return; }
    const box = el('section', { class: 'kl-card' }, el('h2', {}, GAMES[game]));
    if (!rows.length) box.append(el('p', { class: 'kl-note' }, 'No results yet. Log in, then play an online room with a friend and your wins show up here.'));
    else {
      const t = el('table', { class: 'kl-table' }, el('thead', {}, el('tr', {}, el('th', { scope: 'col' }, '#'), el('th', { scope: 'col' }, 'Player'), el('th', { scope: 'col' }, 'Wins'), el('th', { scope: 'col' }, 'Games'), el('th', { scope: 'col' }, 'Fastest win'))),
        el('tbody', {}, ...rows.map(r => el('tr', {}, el('td', {}, String(r.rank)), el('th', { scope: 'row' }, r.username), el('td', {}, String(r.won)), el('td', {}, String(r.played)), el('td', {}, r.bestTurns ? r.bestTurns + ' turns' : '–')))));
      box.append(el('div', { class: 'kl-scroll' }, t));
    }
    page.append(box);
  }
}

/* ---------- /admin/ ---------- */
function renderAdminPage() {
  const page = document.getElementById('kl-admin-page'); page.textContent = '';
  const me = S.me.user;
  if (!me || !me.isAdmin) { page.append(el('p', {}, me ? 'This page is for administrators.' : 'Please log in.')); if (!me) page.append(el('button', { type: 'button', class: 'kl-action kl-primary', onclick: openLogin }, 'Log in')); return; }
  const err = errBox(), reports = el('div', {}), users = el('div', {});
  const act = async (path, body, msg) => { err.textContent = ''; try { await api(path, { method: 'POST', body: body || {} }); toast(msg || 'Done.'); await load(); } catch (e) { err.textContent = e.message; } };
  async function load() {
    const r = await api('/api/admin/reports'); reports.textContent = '';
    if (!r.reports.length) reports.append(el('p', {}, 'No open reports.'));
    for (const x of r.reports) reports.append(el('div', { class: 'kl-item' },
      el('p', {}, el('strong', {}, x.target), ' (' + x.target_status + ') reported by ' + (x.reporter || 'a deleted account') + ' on ' + new Date(x.created_at).toLocaleString()), el('p', { class: 'kl-note' }, x.reason),
      el('div', { class: 'kl-row' },
        el('button', { type: 'button', class: 'kl-action', onclick: () => act('/api/admin/reports/' + x.id + '/resolve', { note: 'dismissed' }, 'Report closed.') }, 'Close report'),
        el('button', { type: 'button', class: 'kl-action', onclick: () => act('/api/admin/users/' + encodeURIComponent(x.target) + '/rename', {}, 'Renamed.') }, 'Force a new name'),
        el('button', { type: 'button', class: 'kl-action kl-danger', onclick: () => { if (confirm('Ban ' + x.target + '?')) act('/api/admin/users/' + encodeURIComponent(x.target) + '/ban', { reason: x.reason.slice(0, 100) }, 'Banned.'); } }, 'Ban'))));
  }
  const q = el('input', { type: 'text', placeholder: 'Start of a username', 'aria-label': 'Search users', maxlength: 20 });
  const find = el('button', { type: 'button', class: 'kl-action' }, 'Search');
  find.addEventListener('click', async () => {
    err.textContent = ''; users.textContent = '';
    try {
      const r = await api('/api/admin/users?q=' + encodeURIComponent(q.value));
      if (!r.users.length) users.append(el('p', {}, 'No one found.'));
      for (const u of r.users) users.append(el('div', { class: 'kl-item' }, el('p', {}, el('strong', {}, u.username), ' – ' + u.status + (u.is_admin ? ', admin' : '') + ', joined ' + new Date(u.created_at).toLocaleDateString() + ', last seen ' + new Date(u.last_login_at).toLocaleDateString()),
        el('div', { class: 'kl-row' },
          u.status === 'banned' ? el('button', { type: 'button', class: 'kl-action', onclick: () => act('/api/admin/users/' + encodeURIComponent(u.username) + '/unban', {}, 'Unbanned.') }, 'Unban')
            : el('button', { type: 'button', class: 'kl-action kl-danger', onclick: () => { if (confirm('Ban ' + u.username + '?')) act('/api/admin/users/' + encodeURIComponent(u.username) + '/ban', { reason: 'admin' }, 'Banned.'); } }, 'Ban'),
          el('button', { type: 'button', class: 'kl-action', onclick: () => act('/api/admin/users/' + encodeURIComponent(u.username) + '/rename', {}, 'Renamed.') }, 'Force a new name'),
          el('button', { type: 'button', class: 'kl-action kl-danger', onclick: () => { if (confirm('Delete ' + u.username + ' for good?')) act('/api/admin/users/' + encodeURIComponent(u.username) + '/delete', {}, 'Deleted.'); } }, 'Delete'))));
    } catch (e) { err.textContent = e.message; }
  });
  page.append(card('Open reports', reports), card('Find a user', el('div', { class: 'kl-row' }, q, find), users), err);
  load().catch(e => { err.textContent = e.message; });
}

/* ---------- start-up ---------- */
const MESSAGES = {
  auth_error: { cancelled: 'Login cancelled.', expired: 'That login link expired. Please try again.', banned: "This account can't be used. Contact " + 'us if you think that is a mistake.', discord_failed: "Discord didn't confirm the login. Please try again.",
    rate: 'Too many tries. Please wait a while.', login_required: 'Please log in first.', wrong_account: 'That is a different account.', discord_taken: 'That Discord account already belongs to another account.' },
  linked: { discord: 'Discord added to your account.' }, reauth: { ok: 'Thank you. You can now delete your account if you want to.' }
};
function readParams() {
  const p = new URLSearchParams(location.search); let shown = false;
  for (const k of Object.keys(MESSAGES)) { const v = p.get(k); if (v && MESSAGES[k][v]) { toast(MESSAGES[k][v], k === 'auth_error'); shown = true; } p.delete(k); }
  if (p.get('deleted')) { toast('Your account was deleted.'); p.delete('deleted'); shown = true; }
  p.delete('auth');
  if (shown || location.search) { const qs = p.toString(); history.replaceState(null, '', location.pathname + (qs ? '?' + qs : '') + location.hash); }
}
async function refresh() {
  S.me = await api('/api/me'); renderHeader();
  if (S.me.pending && !S.me.user) openRegister();
  else if (S.me.user && !S.me.user.rulesOk && !(document.querySelector('dialog.kl-dialog[open]'))) openRulesUpdate();
  if (isAccountPage) renderAccountPage();
  if (isAdminPage) renderAdminPage();
}
(async function start() {
  if (isLeaderboardPage) renderLeaderboard();
  try { S.config = await api('/api/auth/config'); } catch (e) { return; }
  if (!S.config.enabled) {
    const page = document.getElementById('kl-account-page') || document.getElementById('kl-admin-page');
    if (page) page.textContent = 'Accounts are not open yet.'; return;
  }
  readParams();
  try { await refresh(); } catch (e) { /* the button simply stays hidden if the server cannot be reached */ }
})();
})();
