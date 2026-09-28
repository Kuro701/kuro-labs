'use strict';
/* kurolabs.net accounts: the numbers and switches in one place.
 * Plain CommonJS so the Worker, the site build (build-site.cjs) and the tests can all read it. */

module.exports = {
  // The rules people agree to when they register. Bump RULES_VERSION when the rules change in a way that matters:
  // every logged-in user is then asked to read and accept them again. The pages /rules/ and /privacy/ show these.
  RULES_VERSION: 2,
  RULES_DATE: '2026-09-27',
  PRIVACY_VERSION: 4,
  PRIVACY_DATE: '2026-09-27',

  // Build-time switch for the wording of the legal pages: while false they say accounts are "not open yet".
  // Flip to true when the dashboard steps are done and logins work, then run the site build.
  ACCOUNTS_OPEN: true,

  CONTACT_EMAIL: 'Kuro701@seznam.cz',
  OPERATOR: 'Jiří Fikejs, Zvole – Černíky, 252 45, Czech Republic',

  // Games that may keep a save, stats and a leaderboard on the server. The kids' game (Star Quest) is deliberately NOT here.
  SAVE_GAMES: ['dragons-and-ladders'],
  MAX_SAVE_BYTES: 16 * 1024,
  LEADERBOARD_SIZE: 50,           // rows shown on /leaderboard/

  MS: { MINUTE: 60000, HOUR: 3600000, DAY: 86400000 },
  SESSION_DAYS: 30,              // sliding: renewed when used
  FRESH_LOGIN_MINUTES: 10,       // "recent login" needed to delete an account
  PENDING_MINUTES: 15,           // sign-in done, agreement + username not yet
  CODE_MINUTES: 10,              // emailed login code lifetime
  CODE_ATTEMPTS: 5,
  CODE_RESEND_SECONDS: 60,
  EMAIL_PER_ADDRESS_PER_HOUR: 5,
  EMAIL_PER_IP_PER_HOUR: 20,
  EMAIL_PER_DAY_TOTAL: 90,       // the free Resend plan allows 100 emails a day; stay under it
  LOGIN_PER_IP_PER_15MIN: 30,    // password tries
  LOGIN_PER_NAME_PER_15MIN: 10,
  USERNAME_RENAME_DAYS: 30,
  REPORTS_PER_DAY: 5,

  RETENTION: {                   // must match the privacy page
    INACTIVE_ACCOUNT_MONTHS: 24,
    INACTIVE_WARNING_DAYS: 30,
    HANDLED_REPORT_MONTHS: 6,
    BAN_HASH_YEARS: 3,
    ADMIN_LOG_MONTHS: 12
  },

  // Names nobody may take (matched after folding look-alikes and dropping separators and digits).
  RESERVED_NAMES: ['admin', 'administrator', 'moderator', 'mod', 'staff', 'support', 'system', 'official', 'owner', 'root',
    'kuro', 'kurolabs', 'kuro701', 'cloe', 'mytheder', 'starquest', 'anonymous', 'guest', 'bot', 'server', 'null', 'undefined']
};
