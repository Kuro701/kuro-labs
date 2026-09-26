# kurolabs.net accounts

Login with Discord or an emailed code, usernames, saves, reports, a small admin page and a nightly cleanup. Everything runs
inside the site's existing Cloudflare Worker: no new server. The pages are `/account/`, `/admin/`, `/rules/` and `/privacy/`;
the Log in button is in the site header and stays **hidden until the server says accounts are switched on**.

Games never touch this code directly. The kids' game (Star Quest) is not allowed to keep a save (`SAVE_GAMES` in `config.js`).

## What lives where

| File | What it is |
|---|---|
| `config.js` | Rules version, retention numbers, limits, reserved names, and `ACCOUNTS_OPEN` (the wording switch for the legal pages). |
| `accounts.js` | Every `/api/auth`, `/api/me`, `/api/save`, `/api/report`, `/api/admin` route, plus the nightly `runCleanup` and `recordGameResult` (for game servers). |
| `usernames.js` + `data/blocklist.json` | Username rules and the bad-word filter (English + Czech word lists, CC BY 4.0, credited in the file and on `/rules/`). Add your own words to `extra`. |
| `data/disposable.json` | Disposable email domains (CC0). |
| `schema.js` | The database tables. Created automatically the first time they are needed. |
| `../legal.cjs` | The text of `/rules/` and `/privacy/`. `../build-site.cjs` writes them. |
| `../../public/assets/account.js`, `account.css` | The Log in button, dialogs, `/account/` and `/admin/` pages. |
| `tests/` | Unit tests, whole-system tests against SQLite, and browser tests. |

## Setting it up (about 30 minutes, once)

Nothing is switched on until these are done, and the site keeps working exactly as before in the meantime.

1. **Database.** Cloudflare dashboard, *Storage & databases*, *D1 SQL database*, *Create*. Name it `kuro-labs`. Copy its **Database ID**.
   In `wrangler.jsonc` remove the `//` in front of the three `d1_databases` lines and paste the ID. (Or send the ID to Claude to do it.)
   The tables are created by the Worker on first use; there is nothing to run.
2. **Discord.** <https://discord.com/developers/applications>, *New Application* (call it Kuro Labs). *OAuth2*: copy the **Client ID**, *Reset Secret* and copy the **Client Secret**.
   Under *Redirects* add exactly `https://kurolabs.net/api/auth/discord/callback` (and `http://localhost:8787/api/auth/discord/callback` if you want to test locally against real Discord).
3. **Email sending (Resend).** Make a free account at resend.com. *Domains*, *Add domain* `kurolabs.net`, then add the DNS records it shows in Cloudflare (*DNS*, *Records*) and press *Verify*. *API keys*, *Create API key* (sending access), copy it.
   Emails go out from `Kuro Labs <login@kurolabs.net>` (change with the `MAIL_FROM` secret). The free plan allows 100 emails a day; the code stops at 90 and tells people to use Discord.
4. **Bot check (Turnstile).** Cloudflare dashboard, *Turnstile*, *Add widget*: name `kurolabs`, hostname `kurolabs.net`, mode *Managed*. Copy the **Site key** and **Secret key**.
5. **Secrets.** *Workers & Pages*, *kuro-labs*, *Settings*, *Variables and secrets*, *Add*, type **Secret** (secrets survive deploys, plain variables do not), one for each:
   `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET`, `RESEND_API_KEY`, `TURNSTILE_SECRET`, `TURNSTILE_SITEKEY`.
   Discord alone is enough for a first try (email login needs Resend and both Turnstile keys). `APP_SECRET` is optional: without it one is generated and kept in the database.
6. **Push.** The Log in button now appears on the live site.
7. **Try it.** Register your own account. Then make yourself the administrator: in the D1 console run
   `UPDATE users SET is_admin = 1, username = 'Kuro', username_lower = 'kuro' WHERE username_lower = 'the-name-you-registered-with';`
   ("kuro" is a reserved name, so only an administrator can hold it.) You will then see *Admin* in the account menu.
8. **Open it to everyone.** In `config.js` set `ACCOUNTS_OPEN: true`, run `node site/build-site.cjs`, push. That removes the "accounts are not open yet" notes from `/rules/` and `/privacy/`.
9. Optional extra lock on the admin page: put `/admin/*` behind Cloudflare Access (Zero Trust). The admin API already requires a logged-in administrator; Access would be a second door.

## Try it on your PC without any of that

```powershell
Set-Location -LiteralPath 'D:\Cowork\kuro-labs'
node .\site\build-site.cjs
node .\site\dnl\dev-server.mjs
```

Open <http://localhost:8787>. Accounts work with pretend Discord, email and bot check: emails are printed in the PowerShell window (and listed at `/__dev/mailbox`),
"Continue with Discord" opens a small pretend Discord page, and `/__dev/make-admin?u=NAME` makes a user an administrator. Everything is in memory unless you add `--db accounts.sqlite`.

## Tests

```powershell
node .\site\accounts\tests\usernames.test.js
node .\site\accounts\tests\accounts.test.js          # the whole system against an SQLite stand-in for D1
python .\site\accounts\tests\e2e_accounts.py          # real browsers: button, dialogs, account page, admin page (needs Python + playwright)
```

## How it behaves (the promises the privacy note makes)

- No passwords, no birth dates. Login is a Discord id and/or an email address; logins last 30 days and are stored only as a hash.
- IP addresses are never stored. The email limits use a keyed hash of the connection, deleted within 2 days.
- Registration needs both boxes ticked (rules, 18+) and is checked on the server. When `RULES_VERSION` goes up, everyone must accept again.
- Deleting an account needs a login from the last 10 minutes and the typed username, and really deletes everything (saves, stats, sessions). Leaving by choice leaves no trace.
- A ban stores only a hash of the Discord id and/or email, for 3 years; deleting the account does not lift it.
- Unused accounts: a warning email 30 days ahead where an email exists, then deletion, 24 months after the last login. Admins are never deleted.
- Emailed codes: 6 digits, 10 minutes, 5 tries, one per minute, 5 an hour per address, 90 a day in total.

## Not done yet

Leaderboards, and the games using saves and stats (the server-side function `recordGameResult` is there for the Dragons & Ladders rooms to call). Chat. Google login.
