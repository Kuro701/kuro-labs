/* Kuro Labs owner dashboard: the "Roblox Games" tab of /admin/ (game list, report inbox, report details, submission keys).
 * Loaded only on /admin/. Shown only to the owner's Discord account, and the server checks that on every request: hiding the tab protects nothing by itself.
 *
 * Everything that comes from players or from the server is shown with text nodes (the shared `el` helper, textContent): there is no HTML string building,
 * innerHTML or link creation anywhere in this file, so report text cannot become markup or script. A test (site/reports/tests/reports.test.js) enforces that. */
(() => {
'use strict';
const STATUSES = ['new', 'investigating', 'fixed', 'closed'];
const LABEL = { new: 'New', investigating: 'Investigating', fixed: 'Fixed', closed: 'Closed' };
const FILTERS = {};                                     // per-game inbox filters, kept while moving between views: { gameKey: { status, q, page } }
const st = { csrf: null, kit: null, host: null, seq: 0 };

const when = ms => ms ? new Date(ms).toLocaleString() : '—';
const safeStatus = s => (STATUSES.includes(s) ? s : 'new');
const plural = (n, w) => n + ' ' + w + (n === 1 ? '' : 's');

/* ---------- plumbing ---------- */
const el = (...a) => st.kit.el(...a);
function call(path, method, body) {
  return st.kit.api(path, { method: method || 'GET', body, headers: method && method !== 'GET' ? { 'x-csrf-token': st.csrf || '' } : undefined });
}
function go(hash) { history.pushState(null, '', hash); render(); }
function route() {
  const parts = location.hash.replace(/^#/, '').split('/').filter(Boolean).map(p => { try { return decodeURIComponent(p); } catch (e) { return ''; } });
  if (parts[0] !== 'roblox') return { view: 'games' };
  if (!parts[1]) return { view: 'games' };
  if (parts[2] === 'r' && parts[3]) return { view: 'report', game: parts[1], id: parts[3] };
  if (parts[2] === 'keys') return { view: 'keys', game: parts[1] };
  return { view: 'inbox', game: parts[1] };
}
const crumbs = (...items) => el('nav', { class: 'od-crumbs', 'aria-label': 'Breadcrumb' }, ...items.flatMap((it, i) => [i ? el('span', { 'aria-hidden': 'true' }, ' / ') : null, it.go ? el('button', { type: 'button', class: 'od-link', onclick: () => go(it.go) }, it.label) : el('span', { 'aria-current': 'page' }, it.label)]));
const notice = (text, kind) => el('p', { class: 'od-notice' + (kind ? ' od-' + kind : ''), role: kind === 'bad' ? 'alert' : 'status' }, text);

// Runs a loader into a container with clear loading / failure states. `draw` receives the loaded data.
async function load(box, loader, draw) {
  const mine = ++st.seq;
  box.textContent = ''; box.append(notice('Loading…'));
  let data;
  try { data = await loader(); }
  catch (e) {
    if (mine !== st.seq) return;
    box.textContent = '';
    const denied = e.status === 401 || e.status === 403;
    box.append(notice(denied ? 'You are not signed in as the site owner. Log in with the owner Discord account.' : 'Could not load this: ' + e.message, 'bad'));
    if (!denied) box.append(el('button', { type: 'button', class: 'kl-action', onclick: () => load(box, loader, draw) }, 'Try again'));
    return;
  }
  if (mine !== st.seq) return;                          // the user already moved on
  box.textContent = ''; draw(data);
}

function statusBadge(s) { s = safeStatus(s); return el('span', { class: 'od-badge od-st-' + s }, LABEL[s]); }
function textBlock(title, text) {
  return el('div', { class: 'od-block' }, el('h3', {}, title), text ? el('p', { class: 'od-text' }, text) : el('p', { class: 'od-muted' }, 'Not provided'));
}

/* ---------- view: registered games ---------- */
function viewGames(host) {
  host.append(el('h2', { class: 'od-h' }, 'Roblox Games'), el('p', { class: 'od-muted' }, 'Games that send bug reports to this site. Players report from inside Roblox; the report arrives here.'));
  const box = el('div', { class: 'od-box' }); host.append(box);
  load(box, () => call('/api/owner/roblox/games'), data => {
    if (!data.games.length) { box.append(notice('No games are registered yet.')); return; }
    box.append(el('div', { class: 'od-grid' }, ...data.games.map(g => el('article', { class: 'od-card' },
      el('div', { class: 'od-card-head' }, el('h3', {}, g.name), el('span', { class: 'od-mono' }, g.key)),
      el('p', { class: 'od-big' }, plural(g.total, 'report')),
      el('p', { class: 'od-chips' }, ...STATUSES.map(s => el('span', { class: 'od-chip od-st-' + s }, LABEL[s] + ' ' + g.counts[s]))),
      el('p', { class: 'od-muted' }, 'Last report: ' + (g.lastReportAt ? when(g.lastReportAt) : 'none yet') + ' · ' + plural(g.activeKeys, 'active key')),
      el('div', { class: 'od-actions' },
        el('button', { type: 'button', class: 'kl-action kl-primary', onclick: () => go('#roblox/' + encodeURIComponent(g.key)) }, 'Open inbox'),
        el('button', { type: 'button', class: 'kl-action', onclick: () => go('#roblox/' + encodeURIComponent(g.key) + '/keys') }, 'Submission keys'))))));
  });
}

/* ---------- view: the inbox of one game ---------- */
function viewInbox(host, game) {
  const f = FILTERS[game] || (FILTERS[game] = { status: '', q: '', page: 1 });
  host.append(crumbs({ label: 'Roblox Games', go: '#roblox' }, { label: game }));
  const head = el('div', { class: 'od-head' }), bar = el('div', { class: 'od-bar' }), list = el('div', { class: 'od-box' }), pager = el('div', { class: 'od-pager' });
  host.append(head, bar, list, pager);
  const q = el('input', { type: 'search', class: 'od-search', placeholder: 'Search text, build, report ID', 'aria-label': 'Search reports', maxlength: 100, value: f.q });
  const form = el('form', { class: 'od-searchform', role: 'search' }, q, el('button', { type: 'submit', class: 'kl-action' }, 'Search'), f.q ? el('button', { type: 'button', class: 'kl-action', onclick: () => { f.q = ''; f.page = 1; render(); } }, 'Clear') : null);
  form.addEventListener('submit', e => { e.preventDefault(); f.q = q.value.trim(); f.page = 1; render(); });
  const params = () => { const p = new URLSearchParams({ page: String(f.page), pageSize: '25' }); if (f.status) p.set('status', f.status); if (f.q) p.set('q', f.q); return p.toString(); };
  load(list, () => call('/api/owner/roblox/games/' + encodeURIComponent(game) + '/reports?' + params()), data => {
    head.append(el('h2', { class: 'od-h' }, data.game.name + ' reports'), el('button', { type: 'button', class: 'kl-action', onclick: () => go('#roblox/' + encodeURIComponent(game) + '/keys') }, 'Submission keys'));
    const all = STATUSES.reduce((n, s) => n + data.counts[s], 0);
    const chip = (value, label, n) => el('button', { type: 'button', class: 'od-filter' + (f.status === value ? ' od-on' : ''), 'aria-pressed': String(f.status === value), onclick: () => { f.status = value; f.page = 1; render(); } }, label + ' ', el('span', { class: 'od-count' }, String(n)));
    bar.append(el('div', { class: 'od-filters', role: 'group', 'aria-label': 'Filter by status' }, chip('', 'All', all), ...STATUSES.map(s => chip(s, LABEL[s], data.counts[s]))), form);
    if (!data.reports.length) { list.append(notice(all === 0 ? 'No reports yet. They appear here when players submit them from the game.' : 'No reports match this filter or search.')); return; }
    list.append(el('ul', { class: 'od-list' }, ...data.reports.map(r => el('li', {}, el('button', { type: 'button', class: 'od-row', onclick: () => go('#roblox/' + encodeURIComponent(game) + '/r/' + encodeURIComponent(r.id)) },
      el('span', { class: 'od-row-top' }, statusBadge(r.status), el('span', { class: 'od-muted' }, when(r.createdAt)), el('span', { class: 'od-mono' }, 'build ' + r.buildVersion), r.hasNotes ? el('span', { class: 'od-muted' }, 'has notes') : null, r.fixedInVersion ? el('span', { class: 'od-muted' }, 'fixed in ' + r.fixedInVersion) : null),
      el('span', { class: 'od-row-text' }, r.preview))))));
    pager.append(el('button', { type: 'button', class: 'kl-action', disabled: data.page <= 1, onclick: () => { f.page = data.page - 1; render(); } }, '← Newer'),
      el('span', { class: 'od-muted', 'aria-live': 'polite' }, 'Page ' + data.page + ' of ' + data.pages + ' · ' + plural(data.total, 'report')),
      el('button', { type: 'button', class: 'kl-action', disabled: data.page >= data.pages, onclick: () => { f.page = data.page + 1; render(); } }, 'Older →'));
    if (data.page > data.pages) { f.page = data.pages; render(); }
  });
}

/* ---------- view: one report ---------- */
function describeChange(c) {
  const out = [];
  if (c.status) out.push('Status ' + LABEL[safeStatus(c.status[0])] + ' → ' + LABEL[safeStatus(c.status[1])]);
  if (c.notes) out.push('Notes edited');
  if (c.fixedInVersion) out.push(c.fixedInVersion[1] ? 'Fixed in ' + c.fixedInVersion[1] : 'Fixed-in version cleared');
  return out.join(' · ') || 'Updated';
}
function viewReport(host, game, id) {
  host.append(crumbs({ label: 'Roblox Games', go: '#roblox' }, { label: game, go: '#roblox/' + encodeURIComponent(game) }, { label: 'Report' }));
  const box = el('div', { class: 'od-box' }); host.append(box);
  const draw = r => {
    box.textContent = '';
    const c = r.context || {}, dl = (k, v) => v === undefined || v === null || v === '' ? null : [el('dt', {}, k), el('dd', {}, String(v))];
    const err = el('p', { class: 'od-err', role: 'alert' });
    const sel = el('select', { id: 'od-status', class: 'od-input' }, ...STATUSES.map(s => el('option', { value: s, selected: s === r.status }, LABEL[s])));
    const notes = el('textarea', { id: 'od-notes', class: 'od-input', rows: 6, maxlength: 5000, placeholder: 'Private notes. Only you can see these.' }); notes.value = r.ownerNotes;
    const fixed = el('input', { id: 'od-fixed', type: 'text', class: 'od-input', maxlength: 64, placeholder: 'e.g. 0.4.3', value: r.fixedInVersion || '' });
    const save = el('button', { type: 'submit', class: 'kl-action kl-primary', disabled: true }, 'Save changes');
    const dirty = () => { save.disabled = sel.value === r.status && notes.value === r.ownerNotes && fixed.value.trim() === (r.fixedInVersion || ''); };
    for (const x of [sel, notes, fixed]) { x.addEventListener('input', dirty); x.addEventListener('change', dirty); }
    const form = el('form', { class: 'od-form', novalidate: true },
      el('h3', {}, 'Your handling'),
      el('div', { class: 'od-field' }, el('label', { for: 'od-status' }, 'Status'), sel),
      el('div', { class: 'od-field' }, el('label', { for: 'od-fixed' }, 'Fixed in version (optional)'), fixed),
      el('div', { class: 'od-field' }, el('label', { for: 'od-notes' }, 'Private notes'), notes),
      err, el('div', { class: 'od-actions' }, save, el('span', { class: 'od-muted' }, r.updatedBy ? 'Last changed by ' + r.updatedBy + ' · ' + when(r.updatedAt) : 'Not changed yet')));
    form.addEventListener('submit', async e => {
      e.preventDefault(); err.textContent = ''; save.disabled = true; save.textContent = 'Saving…';
      try { const res = await call('/api/owner/roblox/reports/' + encodeURIComponent(r.id), 'POST', { status: sel.value, ownerNotes: notes.value, fixedInVersion: fixed.value.trim(), expectedUpdatedAt: r.updatedAt }); st.kit.toast(res.changed ? 'Saved.' : 'Nothing to change.'); draw(res.report); }
      catch (ex) {
        save.textContent = 'Save changes'; dirty();
        if (ex.code === 'stale' && ex.data && ex.data.report) { err.textContent = ex.message; err.append(' ', el('button', { type: 'button', class: 'od-link', onclick: () => draw(ex.data.report) }, 'Load the latest version')); }
        else err.textContent = ex.message + (ex.data && ex.data.details ? ' (' + ex.data.details.map(d => d.field + ': ' + d.code).join(', ') + ')' : '');
      }
    });
    box.append(el('article', { class: 'od-report' },
      el('div', { class: 'od-report-head' }, el('h2', { class: 'od-h' }, 'Report'), statusBadge(r.status)),
      el('p', { class: 'od-muted' }, r.gameName + ' · build ' + r.buildVersion + ' · submitted ' + when(r.createdAt)),
      el('div', { class: 'od-cols' },
        el('div', { class: 'od-main' }, textBlock('Description', r.description), textBlock('Steps to reproduce', r.steps), textBlock('Expected behaviour', r.expected), textBlock('Actual behaviour', r.actual),
          el('div', { class: 'od-block' }, el('h3', {}, 'Diagnostics'), el('dl', { class: 'od-dl' }, ...[dl('Report ID', r.id), dl('Game version', r.buildVersion), dl('Place ID', c.placeId), dl('Universe ID', c.universeId), dl('Platform', c.platform), dl('Viewport', c.viewportWidth !== undefined && c.viewportHeight !== undefined ? c.viewportWidth + ' × ' + c.viewportHeight : null)].filter(Boolean).flat()))),
        el('div', { class: 'od-side' }, form,
          el('div', { class: 'od-block' }, el('h3', {}, 'History'), r.history.length ? el('ul', { class: 'od-history' }, ...r.history.map(h => el('li', {}, el('span', { class: 'od-muted' }, when(h.at) + ' · ' + h.by), el('span', {}, describeChange(h.changes))))) : el('p', { class: 'od-muted' }, 'No changes yet.'))))));
  };
  load(box, () => call('/api/owner/roblox/reports/' + encodeURIComponent(id)).then(x => x.report), draw);
}

/* ---------- view: submission keys ---------- */
function viewKeys(host, game) {
  host.append(crumbs({ label: 'Roblox Games', go: '#roblox' }, { label: game, go: '#roblox/' + encodeURIComponent(game) }, { label: 'Submission keys' }));
  host.append(el('h2', { class: 'od-h' }, 'Submission keys'),
    el('p', { class: 'od-muted' }, 'A key lets the game\'s Roblox server send reports. It can only submit reports for this game; it can never read or manage anything. Keep it in the experience\'s Secrets in Roblox, never in a script or in Git. A key is shown once, when you create it; only a fingerprint is stored.'));
  const secret = el('div', { class: 'od-secretbox' }), err = el('p', { class: 'od-err', role: 'alert' }), box = el('div', { class: 'od-box' });
  const label = el('input', { type: 'text', class: 'od-input', maxlength: 60, placeholder: 'Label, e.g. production', 'aria-label': 'Key label' });
  const create = el('button', { type: 'submit', class: 'kl-action kl-primary' }, 'Create new key');
  const form = el('form', { class: 'od-searchform' }, label, create);
  form.addEventListener('submit', async e => {
    e.preventDefault(); err.textContent = ''; create.disabled = true;
    try {
      const r = await call('/api/owner/roblox/games/' + encodeURIComponent(game) + '/keys', 'POST', { label: label.value.trim() }); label.value = ''; secret.textContent = '';
      const code = el('code', { class: 'od-secret' }, r.key);
      secret.append(el('p', { role: 'status' }, 'New key created. Copy it now: it will not be shown again.'), code,
        el('button', { type: 'button', class: 'kl-action', onclick: async () => { try { await navigator.clipboard.writeText(r.key); st.kit.toast('Copied.'); } catch (x) { const s = window.getSelection(); s.removeAllRanges(); const rg = document.createRange(); rg.selectNodeContents(code); s.addRange(rg); st.kit.toast('Press Ctrl+C to copy.'); } } }, 'Copy'));
      refresh();
    } catch (ex) { err.textContent = ex.message; } finally { create.disabled = false; }
  });
  host.append(form, err, secret, box);
  const refresh = () => load(box, () => call('/api/owner/roblox/games/' + encodeURIComponent(game) + '/keys'), data => {
    if (!data.keys.length) { box.append(notice('No keys yet. Create one, then add it to the Roblox experience secrets.')); return; }
    box.append(el('ul', { class: 'od-list od-keys' }, ...data.keys.map(k => el('li', { class: 'od-keyrow' },
      el('div', {}, el('strong', {}, k.label || 'Unnamed key'), ' ', el('span', { class: 'od-badge ' + (k.revokedAt ? 'od-st-closed' : 'od-st-fixed') }, k.revokedAt ? 'Revoked' : 'Active')),
      el('p', { class: 'od-muted' }, 'Created ' + when(k.createdAt) + ' · last used ' + (k.lastUsedAt ? when(k.lastUsedAt) : 'never') + (k.revokedAt ? ' · revoked ' + when(k.revokedAt) : '')),
      k.revokedAt ? null : el('button', { type: 'button', class: 'kl-action kl-danger', onclick: async () => {
        if (!confirm('Revoke this key? The game stops being able to send reports with it immediately.')) return;
        try { await call('/api/owner/roblox/games/' + encodeURIComponent(game) + '/keys/' + k.id + '/revoke', 'POST', {}); st.kit.toast('Key revoked.'); refresh(); } catch (ex) { st.kit.toast(ex.message, true); }
      } }, 'Revoke')))));
  });
  refresh();
}

/* ---------- start ---------- */
function render() {
  const host = st.host; if (!host || !host.isConnected) return;
  host.textContent = '';
  const root = el('div', { class: 'od' }); host.append(root);
  const r = route();
  if (r.view === 'inbox') viewInbox(root, r.game); else if (r.view === 'report') viewReport(root, r.game, r.id); else if (r.view === 'keys') viewKeys(root, r.game); else viewGames(root);
}
window.KLOwner = {
  async mount(host, kit) {
    st.host = host; st.kit = kit; host.textContent = '';
    host.append(el('p', { class: 'od-notice' }, 'Loading…'));
    try { st.csrf = (await kit.api('/api/owner/session')).csrf; }
    catch (e) { host.textContent = ''; host.append(el('p', { class: 'od-notice od-bad', role: 'alert' }, e.status === 401 || e.status === 403 ? 'This section is only for the site owner.' : 'Could not start the dashboard: ' + e.message)); return; }
    render();
  }
};
})();
