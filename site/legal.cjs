'use strict';
/* The text of /rules/ and /privacy/. Generated into the site by build-site.cjs.
 * The version numbers, dates and the "accounts are open" switch live in site/accounts/config.js so the pages and the
 * server always agree. If you change what the site stores or how long it keeps it, change this text in the same commit. */
const cfg = require('./accounts/config.js');

const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const niceDate = iso => new Date(iso + 'T12:00:00Z').toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
const mail = `<a href="mailto:${esc(cfg.CONTACT_EMAIL)}">${esc(cfg.CONTACT_EMAIL)}</a>`;
const R = cfg.RETENTION;

const head = (eye, title, lead) => `<div class="kl-page-head"><div class="kl-eye">${eye}</div><h1>${title}</h1><p>${lead}</p></div>`;
const notOpen = what => cfg.ACCOUNTS_OPEN ? '' : `<p class="kl-callout"><strong>Accounts are not open yet.</strong> ${what}</p>`;

function rulesPage() {
  return `<div class="kl-wrap kl-legal">
${head('Kuro Labs / Rules', 'Community rules.', `How we keep the games and rooms pleasant for everyone. Version ${cfg.RULES_VERSION}, ${niceDate(cfg.RULES_DATE)}.`)}
${notOpen('These rules already apply to online rooms, and they will apply to every account when accounts open. When you register, you agree to them and confirm that you are 18 or older.')}
<section><h2>The short version</h2>
<p>Be decent to other people, do not cheat, and remember that anyone who breaks these rules can be removed. That is all of it. The details are below so that nobody has to guess.</p></section>
<section><h2>The rules</h2>
<ol class="kl-rules">
<li><strong>You are 18 or older.</strong> Accounts are for adults. If we find out an account belongs to someone under 18, we delete it.</li>
<li><strong>Be decent to other players.</strong> No harassment, threats, or targeting people.</li>
<li><strong>No hate.</strong> No slurs and no racist, sexist or otherwise discriminatory content, in usernames, room nicknames or anywhere else on the site.</li>
<li><strong>No sexual content involving minors, ever,</strong> and nothing else that is illegal.</li>
<li><strong>Do not pretend to be someone else,</strong> including Kuro Labs, staff or other players.</li>
<li><strong>No cheating.</strong> Do not exploit bugs or tamper with scores. Results that count for a leaderboard come from the game server; a result that was tampered with will be removed.</li>
<li><strong>One person, one account.</strong> Do not use extra accounts to boost a leaderboard or to get around a ban.</li>
<li><strong>Do not attack the site or other players' accounts.</strong> No spam, no scraping of login data, no attempts to break in.</li>
<li><strong>We can act.</strong> We may rename a user, remove scores, suspend or ban an account, or delete it, if it breaks these rules.</li>
<li><strong>You can leave at any time.</strong> You can delete your own account whenever you like, and it really deletes your data (see the <a href="/privacy/">privacy note</a>).</li>
</ol></section>
<section><h2>What happens if someone breaks them</h2>
<p>Depending on what happened we may warn, rename, remove scores from, suspend or ban an account. If an account is banned we keep a one-way scrambled fingerprint of the login it used, so the same person cannot simply register again; the privacy note explains this. If you think we made a mistake, email ${mail} and we will look at it again.</p></section>
<section><h2>Reporting a player</h2>
<p>When accounts are open, every public username has a report button. In an online room the host can remove people from the lobby. For anything else, email ${mail} with the username or room code and what happened.</p></section>
<section><h2>Changes</h2>
<p>If these rules change in a way that matters, the version number above goes up, and everyone with an account is shown the new rules once and has to accept them before continuing.</p></section>
<section><h2>Credits</h2>
<p>The username filter uses the English and Czech word lists from the <a href="https://github.com/LDNOOBW/List-of-Dirty-Naughty-Obscene-and-Otherwise-Bad-Words">LDNOOBW project</a> (licence CC BY 4.0) and the disposable-email list from <a href="https://github.com/disposable-email-domains/disposable-email-domains">disposable-email-domains</a> (CC0).</p></section>
</div>`;
}

function privacyPage() {
  return `<div class="kl-wrap kl-legal">
${head('Kuro Labs / Privacy', 'Privacy note.', `What kurolabs.net does with your data, in plain language. Version ${cfg.PRIVACY_VERSION}, ${niceDate(cfg.PRIVACY_DATE)}.`)}
<section><h2>The short version</h2>
<p>You only give us data if you make an account or play online. We keep very little of it, we never sell it, and you can delete an account and all its data yourself at any time.</p></section>
<section><h2>Who runs this</h2>
<p>Kuro Labs is run by <strong>${esc(cfg.OPERATOR)}</strong>. For anything about privacy or your data, email ${mail}.</p></section>
<section><h2>You don't need an account</h2>
<p>You can play every game as a guest.</p>
<ul>
<li><strong>Playing on your own device</strong> gives us nothing. Your progress is saved in your own browser on your own device and never sent to us.</li>
<li><strong>Playing online in a room</strong> (Dragons &amp; Ladders): you type a nickname, which is shown to the other players in that room. The game server holds the nickname, a random seat number and the game position while the room exists, so the game can carry on if someone's connection drops. The room and everything in it is deleted about 2 hours after the last move, or straight away when the last person leaves, and 30 minutes after it was created if nobody joins. We ask for nothing else.</li>
</ul></section>
<section><h2>If you make an account</h2>
${notOpen('This section describes how they will work when they open.')}
<p><strong>What we store</strong></p>
<ul>
<li><strong>Your username</strong>, which you choose. It is shown publicly (for example on leaderboards).</li>
<li><strong>How you log in:</strong> if you use Discord, your Discord user ID (a number). We do not store your Discord name, avatar or email. If you use email login, your email address.</li>
<li><strong>That you agreed to the rules and confirmed you are 18 or older,</strong> which version of the rules, and when.</li>
<li><strong>Your game data:</strong> saved progress and settings, and scores or stats from games that count for the leaderboard.</li>
<li><strong>Simple account facts:</strong> when you signed up and when you last logged in.</li>
</ul>
<p><strong>What we do not store:</strong> passwords (we do not use any), your date of birth, your ID, or your IP address. To stop abuse we count how often a connection asks for a login code, using a one-way scrambled value that cannot be turned back into an address, and we delete it within two days.</p>
<p><strong>Why we keep it.</strong> To run your account and your games: to let you log in, to remember your progress, to run online rooms, to show the leaderboard, and to keep the community safe under the <a href="/rules/">rules</a>. We use it for nothing else. There is no advertising, no tracking of what you do on other sites, and no selling or renting of data.</p></section>
<section><h2>Who else handles your data</h2>
<p>We use a few services to run the site. They handle data only to do their job for us.</p>
<ul>
<li><strong>Cloudflare</strong> hosts the website, runs the online game rooms, and stores the account database.</li>
<li><strong>Resend</strong> sends the login code to your email address (email login only).</li>
<li><strong>Discord</strong> handles the login if you choose Discord. We only receive your Discord ID from them. What Discord does with your data is covered by Discord's own privacy policy.</li>
<li><strong>Cloudflare Turnstile</strong> checks that a person, not a bot, is asking for a login code (email login only). It is only loaded when you choose email login.</li>
</ul>
<p><strong>Data leaving the EU.</strong> Cloudflare, Resend and Discord are American companies, so your data may be processed in the United States. All three are certified under the EU-U.S. Data Privacy Framework, the agreement under which the EU allows personal data to be sent to certified US companies, and each also uses the EU's Standard Contractual Clauses (standard legal terms that bind them to EU-level protection) as a second safeguard. Cloudflare's and Resend's data-processing terms with us apply automatically when we use their services.</p>
<p>We do not give your data to anyone else, except if the law makes us.</p></section>
<section><h2>Cookies and browser storage</h2>
<p>We use <strong>one cookie</strong>, which keeps you logged in (once accounts exist), plus short-lived cookies during a login. They are needed for the login to work, so, as Czech data-protection guidance allows for strictly necessary cookies, there is no cookie-consent banner. Games also save things in your browser's own storage, for the same reason: your progress, your sound setting, the name you last typed and, in an online room, your seat so you can rejoin after a dropped connection or a page reload. We use <strong>no</strong> analytics cookies and <strong>no</strong> advertising cookies. If that ever changes, we will ask for your consent first.</p></section>
<section><h2>How long we keep things</h2>
<ul>
<li><strong>Your account and game data:</strong> until you delete your account, or until it has been unused for <strong>${R.INACTIVE_ACCOUNT_MONTHS} months</strong>. Before an unused account is deleted we email a warning ${R.INACTIVE_WARNING_DAYS} days ahead where we have an email address for it.</li>
<li><strong>Online game rooms:</strong> about 2 hours after the last move, or straight away when the last person leaves.</li>
<li><strong>Login codes:</strong> ${cfg.CODE_MINUTES} minutes. <strong>Unfinished sign-ups:</strong> ${cfg.PENDING_MINUTES} minutes.</li>
<li><strong>Login sessions:</strong> ${cfg.SESSION_DAYS} days of inactivity, or until you log out.</li>
<li><strong>Reports about a user:</strong> until we have dealt with them, then ${R.HANDLED_REPORT_MONTHS} months, or until the account is deleted.</li>
<li><strong>Moderation log</strong> (what an administrator did, and to which username): ${R.ADMIN_LOG_MONTHS} months.</li>
<li><strong>Backups:</strong> we keep backup copies for up to <strong>30 days</strong>, so deleted data can remain in a backup for up to that long before it disappears.</li>
<li><strong>Ban records</strong> (see below): up to ${R.BAN_HASH_YEARS} years, then removed unless the ban is renewed.</li>
</ul></section>
<section><h2>Deleting your account and getting your data</h2>
<p>Both are buttons in your account settings.</p>
<ul>
<li><strong>Delete my account</strong> removes your username, login details, saves, stats and leaderboard entries. It is a real deletion, not a hidden flag. You need to have logged in recently and type your username to confirm.</li>
<li><strong>Download my data</strong> gives you a file of everything we hold about you.</li>
</ul></section>
<section><h2>Bans</h2>
<p>If we ban an account for breaking the rules, we keep <strong>a one-way scrambled fingerprint (a hash)</strong> of the Discord ID or email used, and nothing else. It lets us stop the same person coming straight back. It cannot be turned back into your email or ID. We keep it even if the account is deleted, for up to ${R.BAN_HASH_YEARS} years. People who leave by choice, without being banned, leave nothing behind.</p></section>
<section><h2>Who can use accounts</h2>
<p>Accounts are for people <strong>18 or older</strong>. When you register you confirm this. If we find out an account belongs to someone under 18, we delete it. The kids' game on this site is guest-only and never collects personal data.</p></section>
<section><h2>Your rights</h2>
<p>Under EU data-protection law (GDPR) you have the right to see your data, correct it, delete it, take a copy, and object to how it is used. Most of that you can do yourself in your account settings; for anything else email ${mail} and we will answer within a month. If you think we have handled your data wrongly, you can complain to the Czech data-protection authority, the <a href="https://uoou.gov.cz/">Úřad pro ochranu osobních údajů</a>, or to the authority in your own country.</p></section>
<section><h2>Changes</h2>
<p>If this note changes in a way that matters, we will tell logged-in users when they next visit, and the date and version at the top will change.</p></section>
</div>`;
}

module.exports = { rulesPage, privacyPage };
