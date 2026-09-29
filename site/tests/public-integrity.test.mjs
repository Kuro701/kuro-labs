import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const publicDir = path.join(root, 'public');
const expectedRoutes = [
  '/', '/about/', '/account/', '/admin/', '/commissions/', '/contact/', '/games/',
  '/games/dragons-and-ladders/', '/games/dungeon-of-serenity/', '/games/dungeon-of-serenity/hive/',
  '/games/dungeon-of-serenity/ship/', '/games/dungeon-of-serenity/ship/armory/',
  '/games/dungeon-of-serenity/ship/briefing/', '/games/mytheder/', '/games/ordinals-and-months/',
  '/games/Project Indie Game/Prototype/game/', '/games/Project Indie Game/Prototype/MainMenu/',
  '/k-lab/', '/leaderboard/', '/privacy/', '/projects/', '/projects/cloe/', '/projects/jophiel/',
  '/projects/metatron/', '/projects/monkey-paw/', '/projects/mytheder/', '/projects/raphael/',
  '/projects/vretil/', '/rules/', '/shop/', '/shop/crescent-rose/', '/shop/gift-basket/',
  '/shop/predator-nanomask/'
];

const routeFile = route => path.join(publicDir, decodeURIComponent(route.replace(/^\//, '')), 'index.html');
for (const route of expectedRoutes) {
  const file = route === '/' ? path.join(publicDir, 'index.html') : routeFile(route);
  assert.ok(fs.existsSync(file), `missing route ${route}`);
}

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? walk(full) : [full];
  });
}

const htmlFiles = walk(publicDir).filter(file => file.endsWith('.html'));
const failures = [];
for (const file of htmlFiles) {
  const html = fs.readFileSync(file, 'utf8');
  // The standalone games contain alternative screen templates in JavaScript strings,
  // so repeated template ids are not simultaneous DOM ids. Check the generated site shell.
  if (html.includes('id="kl-techno"')) {
    const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map(match => match[1]);
    for (const id of new Set(ids)) if (ids.filter(value => value === id).length > 1) failures.push(`${file}: duplicate id ${id}`);
  }

  for (const match of html.matchAll(/\s(?:href|src)="([^"]+)"/g)) {
    const value = match[1].replace(/&amp;/g, '&');
    if (!value.startsWith('/') || value.startsWith('//') || value.startsWith('/api/') || value.includes('${')) continue;
    const clean = decodeURIComponent(value.split(/[?#]/)[0]);
    if (!clean || clean === '/') continue;
    let target = path.join(publicDir, clean.replace(/^\//, ''));
    if (clean.endsWith('/')) target = path.join(target, 'index.html');
    if (!fs.existsSync(target)) failures.push(`${file}: broken local reference ${value}`);
  }
}

assert.deepEqual(failures, [], failures.join('\n'));
for (const file of ['index.html', 'about/index.html', 'games/index.html', 'projects/index.html', 'shop/index.html', 'commissions/index.html', 'contact/index.html', 'account/index.html', 'admin/index.html', 'leaderboard/index.html', 'rules/index.html', 'privacy/index.html']) {
  const html = fs.readFileSync(path.join(publicDir, file), 'utf8');
  assert.match(html, /id="kl-account"/, `${file}: missing account mount`);
  assert.match(html, /purple\.css/, `${file}: missing redesign stylesheet`);
}
assert.match(fs.readFileSync(path.join(publicDir, 'account/index.html'), 'utf8'), /id="kl-account-page"/);
assert.match(fs.readFileSync(path.join(publicDir, 'admin/index.html'), 'utf8'), /id="kl-admin-page"/);
assert.match(fs.readFileSync(path.join(publicDir, 'leaderboard/index.html'), 'utf8'), /id="kl-leaderboard-page"/);

const shop = fs.readFileSync(path.join(publicDir, 'shop/index.html'), 'utf8');
for (const slug of ['crescent-rose-pcvr', 'Aesthetic-gift-basket', 'predator-nanomask']) assert.ok(shop.includes(`data-sold-slug="${slug}"`), `missing shop sales key ${slug}`);

console.log(`PASS: ${expectedRoutes.length} routes, ${htmlFiles.length} HTML files, local references, mounts and sales keys.`);
