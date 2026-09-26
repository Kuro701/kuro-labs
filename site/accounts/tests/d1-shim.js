'use strict';
/* A stand-in for Cloudflare D1 built on Node's built-in SQLite, for tests and the local dev server.
 * Same calls the Worker uses: prepare(sql).bind(...).first() / all() / run(), and batch([...]) (atomic).
 * Foreign keys are on, like D1. */
const { DatabaseSync } = require('node:sqlite');

class Statement {
  constructor(db, sql) { this.db = db; this.sql = sql; this.args = []; }
  bind(...args) { const s = new Statement(this.db, this.sql); s.args = args.map(a => (a === undefined ? null : a)); return s; }
  _exec(kind) {
    const st = this.db.prepare(this.sql);
    if (kind === 'first') return st.get(...this.args) || null;
    if (kind === 'all') return st.all(...this.args);
    const info = st.run(...this.args);
    return { changes: Number(info.changes), last_row_id: Number(info.lastInsertRowid) };
  }
  async first(col) { const r = this._exec('first'); return r && col ? r[col] : r; }
  async all() { return { results: this._exec('all'), success: true, meta: {} }; }
  async run() { const m = this._exec('run'); return { success: true, meta: m }; }
}
class D1Shim {
  constructor(path) { this.db = new DatabaseSync(path || ':memory:'); this.db.exec('PRAGMA foreign_keys = ON'); }
  prepare(sql) { return new Statement(this.db, sql); }
  async batch(stmts) {
    const out = [];
    this.db.exec('BEGIN');
    try { for (const s of stmts) { const sql = s.sql.trim().toUpperCase(); out.push(/^(SELECT|WITH|PRAGMA)/.test(sql) ? { results: s._exec('all'), success: true } : { success: true, meta: s._exec('run') }); } this.db.exec('COMMIT'); }
    catch (e) { this.db.exec('ROLLBACK'); throw e; }
    return out;
  }
  close() { this.db.close(); }
}
module.exports = { D1Shim };
