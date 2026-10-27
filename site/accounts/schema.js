'use strict';
/* The database (Cloudflare D1 = SQLite). Created automatically the first time the Worker needs it, so setting up
 * only means creating an empty D1 database and binding it as DB. Every statement is idempotent (IF NOT EXISTS).
 * To change the schema later, append an entry to MIGRATIONS with a higher number: each runs once. Times are ms since epoch.
 *
 * What is stored about a person (see the privacy note): username, login identifiers (Discord id and/or email), the
 * record that they accepted the rules and are 18+, their saves and stats. Passwords only as a salted one-way hash (pw_hash). Never: the password itself, birth date, IP addresses.
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
  ] },
  { n: 2, sql: [
    `ALTER TABLE users ADD COLUMN pw_hash TEXT`,
    `ALTER TABLE users ADD COLUMN pw_changed_at INTEGER`
  ] },
  // Roblox game bug reports (site/reports/reports.js). Games are registered rows; each game has its own submission keys (stored only as hashes).
  { n: 3, sql: [
    `CREATE TABLE IF NOT EXISTS roblox_games (game_key TEXT PRIMARY KEY, name TEXT NOT NULL, created_at INTEGER NOT NULL)`,
    `INSERT OR IGNORE INTO roblox_games (game_key, name, created_at) VALUES ('jetbreak', 'JetBreak', CAST(strftime('%s','now') AS INTEGER) * 1000)`,
    `CREATE TABLE IF NOT EXISTS roblox_game_keys (id INTEGER PRIMARY KEY AUTOINCREMENT, game_key TEXT NOT NULL REFERENCES roblox_games(game_key) ON DELETE CASCADE, key_hash TEXT NOT NULL UNIQUE, label TEXT, created_at INTEGER NOT NULL, created_by INTEGER REFERENCES users(id) ON DELETE SET NULL, revoked_at INTEGER, last_used_at INTEGER)`,
    `CREATE INDEX IF NOT EXISTS roblox_game_keys_game ON roblox_game_keys(game_key)`,
    `CREATE TABLE IF NOT EXISTS roblox_reports (id TEXT PRIMARY KEY, game_key TEXT NOT NULL REFERENCES roblox_games(game_key) ON DELETE CASCADE, submission_id TEXT NOT NULL, payload_hash TEXT NOT NULL, build_version TEXT NOT NULL, description TEXT NOT NULL, steps TEXT, expected TEXT, actual TEXT, context TEXT, status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new','investigating','fixed','closed')), owner_notes TEXT NOT NULL DEFAULT '', fixed_in_version TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL, updated_by_name TEXT, UNIQUE (game_key, submission_id))`,
    `CREATE INDEX IF NOT EXISTS roblox_reports_inbox ON roblox_reports(game_key, status, created_at DESC)`,
    `CREATE TABLE IF NOT EXISTS roblox_report_events (id INTEGER PRIMARY KEY AUTOINCREMENT, report_id TEXT NOT NULL REFERENCES roblox_reports(id) ON DELETE CASCADE, actor_id INTEGER REFERENCES users(id) ON DELETE SET NULL, actor_name TEXT, detail TEXT NOT NULL, created_at INTEGER NOT NULL)`,
    `CREATE INDEX IF NOT EXISTS roblox_report_events_report ON roblox_report_events(report_id, id)`
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
