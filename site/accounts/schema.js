'use strict';
/* The database (Cloudflare D1 = SQLite). Created automatically the first time the Worker needs it, so setting up
 * only means creating an empty D1 database and binding it as DB. Every statement is idempotent (IF NOT EXISTS).
 * To change the schema later, append an entry to MIGRATIONS with a higher number: each runs once. Times are ms since epoch.
 *
 * What is stored about a person (see the privacy note): username, login identifiers (Discord id and/or email), the
 * record that they accepted the rules and are 18+, their saves and stats. Never: passwords, birth date, IP addresses.
 */
const MIGRATIONS = [
  { n: 1, sql: [
    `CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL, username_lower TEXT NOT NULL UNIQUE, discord_id TEXT UNIQUE, email TEXT, email_key TEXT UNIQUE, status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended','banned')), is_admin INTEGER NOT NULL DEFAULT 0, hide_lb INTEGER NOT NULL DEFAULT 0, rules_version INTEGER NOT NULL, accepted_at INTEGER NOT NULL, created_at INTEGER NOT NULL, last_login_at INTEGER NOT NULL, username_changed_at INTEGER NOT NULL DEFAULT 0, inactive_warned_at INTEGER)`,
    `CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, last_auth_at INTEGER NOT NULL)`,
    `CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id)`,
    `CREATE INDEX IF NOT EXISTS sessions_exp ON sessions(expires_at)`,
    `CREATE TABLE IF NOT EXISTS pending (id_hash TEXT PRIMARY KEY, kind TEXT NOT NULL, discord_id TEXT, email TEXT, email_key TEXT, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS codes (email_key TEXT NOT NULL, purpose TEXT NOT NULL, email TEXT NOT NULL, code_hash TEXT NOT NULL, user_id INTEGER, expires_at INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, sent_at INTEGER NOT NULL, PRIMARY KEY (email_key, purpose))`,
    `CREATE TABLE IF NOT EXISTS oauth (state_hash TEXT PRIMARY KEY, purpose TEXT NOT NULL, user_id INTEGER, return_to TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS saves (user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, game TEXT NOT NULL, data TEXT NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (user_id, game))`,
    `CREATE TABLE IF NOT EXISTS stats (user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, game TEXT NOT NULL, played INTEGER NOT NULL DEFAULT 0, won INTEGER NOT NULL DEFAULT 0, best_turns INTEGER, updated_at INTEGER NOT NULL, PRIMARY KEY (user_id, game))`,
    `CREATE TABLE IF NOT EXISTS reports (id INTEGER PRIMARY KEY AUTOINCREMENT, reporter_id INTEGER REFERENCES users(id) ON DELETE SET NULL, target_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, reason TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open', created_at INTEGER NOT NULL, handled_at INTEGER, handled_by INTEGER, note TEXT)`,
    `CREATE TABLE IF NOT EXISTS ban_list (identifier_hash TEXT PRIMARY KEY, created_at INTEGER NOT NULL, reason TEXT)`,
    `CREATE TABLE IF NOT EXISTS admin_log (id INTEGER PRIMARY KEY AUTOINCREMENT, admin_id INTEGER, action TEXT NOT NULL, target TEXT, detail TEXT, created_at INTEGER NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS rate (key TEXT PRIMARY KEY, window_start INTEGER NOT NULL, count INTEGER NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)`
  ] }
];

const ready = new WeakMap();      // db object -> promise (once per Worker instance)

async function ensureSchema(db) {
  if (ready.has(db)) return ready.get(db);
  const p = (async () => {
    await db.prepare('CREATE TABLE IF NOT EXISTS schema_version (n INTEGER NOT NULL)').run();
    const row = await db.prepare('SELECT MAX(n) AS n FROM schema_version').first();
    const have = (row && row.n) || 0;
    for (const m of MIGRATIONS) {
      if (m.n <= have) continue;
      await db.batch(m.sql.map(s => db.prepare(s)).concat([db.prepare('INSERT INTO schema_version (n) VALUES (?)').bind(m.n)]));
    }
  })();
  ready.set(db, p);
  p.catch(() => ready.delete(db));           // try again next request if it failed
  return p;
}

module.exports = { MIGRATIONS, ensureSchema };
