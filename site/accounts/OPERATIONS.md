# Kuro Labs: privacy and safety operations (write-down, 2026-09-27)

For the operator (Jiří Fikejs). This is the "what do I do when..." sheet that sits behind the public /privacy/ and /rules/ pages.
Not legal advice. If something serious happens and you are unsure, ask a lawyer or the data-protection office (ÚOOÚ) early.

## 1. Key contacts
- Operator / contact for users: Kuro701@seznam.cz
- Data-protection authority (Czech): Úřad pro ochranu osobních údajů (ÚOOÚ), Pplk. Sochora 27, 170 00 Praha 7, https://uoou.gov.cz (has an online form for reporting a breach and for asking questions)
- Cloudflare / Resend / Discord support: through their dashboards.

## 2. If personal data leaks (breach)
The clock: you must report to the ÚOOÚ **within 72 hours of becoming aware**, unless the breach is unlikely to put people at risk. If it is likely to put them at HIGH risk (e.g. readable passwords, emails plus something sensitive), tell the affected users too, without delay.
1. **Contain**: change the leaked secret (Cloudflare API tokens, Resend key, Discord secret, Turnstile secret), log everyone out (`DELETE FROM sessions;` in the D1 console), fix the hole, deploy.
   - Do NOT change `APP_SECRET` / the stored app secret unless you must: it is the key for ban fingerprints and login-code hashes; changing it makes old bans stop matching and pending codes stop working. If you must, note the date in the breach register.
2. **Assess**: what was exposed (usernames, emails, Discord IDs, password hashes, saves), how many people, could it hurt them.
3. **Report** to the ÚOOÚ through their breach form (say what, when, how many people, what you did, contact address). If you do not have all facts inside 72 hours, report what you know and add the rest later.
4. **Tell users** if high risk: email through Resend and a notice on the site. Plain words: what happened, what data, what they should do (change password, watch for phishing).
5. **Write it in the breach register** (section 9), even if you decide it does not need reporting, with the reason.
Passwords are stored only as salted PBKDF2 hashes, and bans only as keyed hashes, so a database leak would expose usernames, emails/Discord IDs and saves but not readable passwords. Still ask people to change passwords.

## 3. When someone asks about their data (access, deletion, correction)
Deadline: answer **within one month** (can be extended by two more months for complex cases if you tell the person why).
1. **Check it is them.** Best: they use the buttons in /account/ (Download my data, Delete my account) which need a login. If they email instead: only act if the email comes from the address stored on the account, or they can show control of the Discord account; if unsure, ask them to log in and use the buttons. Never send data to an address that is not the account's.
2. **Access / copy**: point them to "Download my data", or send the same JSON export.
3. **Deletion**: they can delete themselves. If they email: /admin/ -> find user -> Delete. That deletes username, login details, password hash, saves, stats, and reports about them. Backups age out within 30 days (see 5). Bans stay as a hash by design (legitimate interest) unless you decide to lift the ban.
4. **Correction**: they can change name/email/password in /account/; otherwise do it by hand in the D1 console.
5. **Objection** (e.g. to ban fingerprint or logs): read what they say, decide, answer in writing with the reason.
6. Log every request in the request register (section 9): date, type, who, what you did.

## 4. Moderation (reports, bans, renames)
- Check /admin/ at least weekly once accounts are open. Answer reports even if only "looked, no action".
- Every admin action is written to the moderation log (kept 12 months, then deleted automatically).
- Someone who is banned can write to Kuro701@seznam.cz to appeal. Look again, answer, and lift the ban if it was a mistake (Unban button).
- Room nicknames go through the same bad-word filter as usernames; the host can remove players from the lobby. Guests cannot be reported; if a room code is abused, write it down and consider a block.
- Someone under 18 found with an account: delete the account (admin Delete) and log it in the request register. Do not keep the reason beyond "under age".

## 5. Backups and restores
- The account database is Cloudflare D1. Backups (Time Travel) keep 30 days on the paid plan and about 7 on the free plan. The privacy note says "up to 30 days", which is true either way.
- **Before restoring from a backup**, remember it will bring back accounts that were deleted after that backup. After a restore, go through the request register and delete those accounts again. Do this before reopening the site.
- Nobody but you should have dashboard access. Turn on two-factor login on Cloudflare, GitHub, Discord developer portal, Resend, and your email.

## 6. Outside services (processors) and their paperwork
| Service | What it does with data | Paperwork |
|---|---|---|
| Cloudflare | hosting, Durable Object rooms, D1 database, Turnstile bot check | Data Processing Addendum applies automatically under Cloudflare's terms (check it in the dashboard: Account -> Legal). Certified under the EU-U.S. Data Privacy Framework. |
| Resend | sends login-code emails | Data Processing Addendum is available in their legal pages; accept/save it once. DPF certified. |
| Discord | sign-in only; sends us just the Discord ID | Independent controller under its own policy. Not our processor. |
Save a PDF or screenshot of each accepted DPA into a folder called "legal" with the date. Re-check the Data Privacy Framework list at https://www.dataprivacyframework.gov/list once a year; if a company drops out, tell me and we adjust the privacy note.

## 7. One-time setup checklist for the services
- Discord developer app: privacy policy URL = https://kurolabs.net/privacy/ , terms URL = https://kurolabs.net/rules/ , redirect URL https://kurolabs.net/api/auth/discord/callback
- Resend: verify the kurolabs.net domain (SPF and DKIM records in Cloudflare DNS), and add a DMARC record (`v=DMARC1; p=none; rua=mailto:Kuro701@seznam.cz`) so login emails do not land in spam.
- Cloudflare Worker secrets must be type **Secret** (plain text variables are wiped on deploy).
- Turnstile: site key is public, secret key is a Secret.

## 8. Children, age, kids' game
- Accounts: 18+ by self-declared tick box (same gate as adult sites). Fine and common. We do not collect birth dates or ID.
- Star Quest and the kids' section are guest-only: no login button, no accounts, no personal data. **If you ever add accounts or leaderboards there, stop and re-do the privacy work first**: for children, consent of a parent is needed under 15 in Czechia, and the rules change.
- The account header button must not appear on the kids' pages.

## 9. Registers (keep as a plain text or spreadsheet file, private)
Breach register: date found | what happened | data/people | reported to ÚOOÚ? (date) | users told? | what was fixed.
Request register: date | who (username, not more) | type (access/delete/correct/object) | what you did | date answered.
Under-18 / ban appeals: date | username | outcome.

## 10. Record of processing (short version)
| Purpose | Data | Basis | Kept | Recipients |
|---|---|---|---|---|
| Account, login, progress | username, password hash, Discord ID and/or email, rules acceptance, dates | providing the service | until deletion or 24 months unused | Cloudflare, Resend (email only) |
| Online rooms | guest nickname, seat id, game state | providing the service | about 2 h after last move | Cloudflare |
| Leaderboards / stats | scores, wins | providing the service | with the account | Cloudflare |
| Abuse limits | keyed-hash counters of IP and email address | legitimate interest (security) | under 2 days | Cloudflare |
| Moderation | reports, moderation log | legitimate interest | 6 months after handled / 12 months | Cloudflare |
| Ban fingerprint | keyed hash of Discord ID / email | legitimate interest | up to 3 years | Cloudflare |
| Backups | copy of the above | legitimate interest (recovery) | up to 30 days | Cloudflare |

## 11. Keeping the paper true
- Any change to what is stored, for how long, who gets it, or new features (analytics, chat, leaderboards, a new login provider): change `site/legal.cjs` and `site/accounts/config.js` in the same commit, bump `PRIVACY_VERSION` (and `RULES_VERSION` for rules; that makes users accept again), rebuild and push.
- Read /privacy/ and /rules/ once a year against reality. Note the date here: last review 2026-09-27.
- Not covered here and worth doing when convenient: ask your accountant about the side income (you have HPP), and have a Czech lawyer glance over /rules/ and /privacy/ once before accounts open.
