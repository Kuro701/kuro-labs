'use strict';
/* =============================================================================
   Dungeon of Serenity -- MAIN MENU / SAVE-RECOVERY LOGIC (stub backend)
   =============================================================================
   This is the FRONT-END STUB Kuro picked for this pass: the full state machine
   for the main-menu flow he described (glowing Play vs. New Game, the recovery
   code box, the error state) works completely today, driven by localStorage
   standing in for the real save. No server exists yet. Swapping in the real
   backend later (the shared Ad Games Cloudflare Workers + D1 service, per
   ALIEN_DRONE_ROGUELITE.md's "Identity" section) means replacing the four
   functions in the "BACKEND STUB" section below with real fetch() calls --
   nothing in the state machine or the UI wiring needs to change, since they
   only ever call getActiveSave/setActiveSave/lookupCode/startNewGame.

   Kuro's spec, restated as the exact rules this file implements:
   - Layout is New Game button ABOVE Play button (this file doesn't lay out
     markup -- see menu_logic_harness.html -- but exposes the state each
     button needs).
   - If this browser already has a save ("remembers last gameplay"): Play
     glows (primary). New Game does not.
   - If not: New Game glows (primary) instead. Play does not (and is inert
     until a save exists, from New Game or a recovered code).
   - Below Play: a recovery-code box. Enter a code, submit ("click through").
     - Code matches real data -> that save becomes this browser's active
       save, Play now glows.
     - Code doesn't match anything -> on-screen error: "please contact my
       Discord account so I can sort it out," with a real link.
   ============================================================================= */

const DOS_STORAGE_KEY = 'dos_active_save';      // this browser's current save
const DOS_STUB_DB_KEY = 'dos_stub_recovery_db'; // fake "server" of issued codes, stub only
const DOS_DISCORD_URL = 'https://discord.gg/yhQGRDBEzM'; // same invite already used for Mytheder; swap if Kuro wants a dedicated one

/* ---------------------------------------------------------------------------
   BACKEND STUB -- the only section that needs to change when the real
   Workers+D1 identity service exists. Everything else in this file, and all
   UI code built against it, stays the same.
--------------------------------------------------------------------------- */
function getActiveSave(){
  try {
    const raw = localStorage.getItem(DOS_STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (e) { return null; }
}

function setActiveSave(save){
  try { localStorage.setItem(DOS_STORAGE_KEY, JSON.stringify(save)); } catch (e) {}
}

function clearActiveSave(){
  try { localStorage.removeItem(DOS_STORAGE_KEY); } catch (e) {}
}

// Fake "server" lookup. Real version: POST the code to the backend, get back
// the save row or a 404. Stub version: reads a fake table also kept in this
// same browser's localStorage, seeded with a couple of test codes below so
// the valid/invalid paths are both actually testable without a server.
function lookupCode(code){
  const db = _readStubDb();
  const key = _normalizeCode(code);
  return db[key] || null;
}

function _normalizeCode(code){
  return String(code || '').trim().toUpperCase();
}

function _readStubDb(){
  try {
    const raw = localStorage.getItem(DOS_STUB_DB_KEY);
    if (raw) return JSON.parse(raw);
  } catch (e) {}
  // Seed a couple of fixtures on first run so there's something valid to
  // test against. Real backend: this whole seeding block goes away.
  const seeded = {
    'TEST-CODE-1': { code: 'TEST-CODE-1', floor: 3, createdAt: Date.now() - 86400000 },
    'HIVE-SAVED-2': { code: 'HIVE-SAVED-2', floor: 1, createdAt: Date.now() - 3600000 },
  };
  try { localStorage.setItem(DOS_STUB_DB_KEY, JSON.stringify(seeded)); } catch (e) {}
  return seeded;
}

/* ---------------------------------------------------------------------------
   STATE MACHINE -- this part is backend-agnostic and is the part that
   survives the swap to a real server unchanged.
--------------------------------------------------------------------------- */

// Fresh save with no recovery code yet -- per the already-decided design
// (ALIEN_DRONE_ROGUELITE.md), the code isn't issued until the FIRST hive
// clear, not at game start, so New Game must not fabricate one.
function startNewGame(){
  const save = { code: null, floor: 0, createdAt: Date.now() };
  setActiveSave(save);
  return save;
}

// Attempt to recover a save from a typed-in code.
// Returns { ok: true, save } or { ok: false, error: 'not_found' }.
function tryRecoverCode(code){
  const found = lookupCode(code);
  if (!found) return { ok: false, error: 'not_found' };
  setActiveSave(found);
  return { ok: true, save: found };
}

// The single source of truth for what the menu should show. Call this on
// load and after every action; feed the result straight into the UI.
function getMenuState(){
  const save = getActiveSave();
  return {
    hasSave: !!save,
    save,
    playGlows: !!save,
    newGameGlows: !save,
  };
}

// Exposed for the harness page (and later, the real menu) to wire up without
// reaching into localStorage directly.
window.DOS_MENU = {
  DOS_DISCORD_URL,
  getMenuState,
  startNewGame,
  tryRecoverCode,
  clearActiveSave,
  // test-only helpers, not part of the real interface -- see harness page
  _debug_seedValidCode: 'TEST-CODE-1',
  _debug_readStubDb: _readStubDb,
};
