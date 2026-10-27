# Roblox bug reports and the owner dashboard

Players press **Settings > Report Bug** in a Roblox game. The game's server validates the text and sends it to this site. You read and manage the reports at **kurolabs.net/admin/** (tab **Roblox Games**) after logging in with your Discord account.

```
Roblox client form -> Roblox server (validates, cooldown) -> POST /api/roblox-reports -> D1 database -> /admin/ (owner only)
```

Everything runs inside the existing Worker and the existing `DB` D1 database. No new binding, no email service.

| Piece | Where |
|---|---|
| Submit endpoint, owner API, nightly retention | `site/reports/reports.js` |
| Tables (migration 3) | `site/accounts/schema.js` |
| Owner check (`isOwnerUser`) | `site/accounts/accounts.js` |
| Dashboard | `public/assets/owner-dashboard.js` and `.css`, tab wiring in `public/assets/account.js` |
| Limits and retention defaults | `site/accounts/config.js` (`ROBLOX_REPORTS`) |
| Tests | `site/reports/tests/reports.test.js` |

## 1. The contract for the Roblox developer

### Request

```
POST https://kurolabs.net/api/roblox-reports
Content-Type: application/json
X-JetBreak-Report-Key: <the game's submission key>
```

`X-Report-Key` is accepted as an identical alias (use it for future games so the header does not say JetBreak). The key identifies the game; it is not a login for anything else.

```json
{
  "schemaVersion": 1,
  "submissionId": "3f2b8c1e-5a47-4d0e-9c6b-1d2e3f4a5b6c",
  "gameKey": "jetbreak",
  "buildVersion": "0.4.2",
  "description": "required, 10-2000 characters",
  "steps": "optional, up to 2000 characters",
  "expected": "optional, up to 1000 characters",
  "actual": "optional, up to 1000 characters",
  "context": {
    "placeId": 0,
    "universeId": 0,
    "platform": "optional, up to 32 printable ASCII characters",
    "viewportWidth": 0,
    "viewportHeight": 0
  }
}
```

Rules (all enforced by the server):

- Body at most 40 KB, `Content-Type: application/json`, UTF-8 JSON object.
- `schemaVersion` must be `1`.
- `submissionId`: a GUID, generated **once per report** by the Roblox server and reused for every retry of that report. In Luau: `HttpService:GenerateGUID(false)` (no curly braces).
- `gameKey` must equal the game the key belongs to (`jetbreak`). A mismatch is refused with 403 even when the key is valid.
- `buildVersion`: 1-64 printable ASCII characters, the actual game build.
- Text fields are counted in characters (an emoji is one). Leading and trailing whitespace is trimmed; control characters are removed. Optional text fields may be omitted, `null` or empty.
- `context` is optional. Only the five fields above are accepted. IDs must be integers from 0 up; viewport sizes 0-20000. **Unknown fields anywhere are rejected**, so nothing else about the player can sneak in.
- Do not send player names, user IDs, inventory, chat or logs. The server has no field for them.

### Responses

| Status | Body | Meaning |
|---|---|---|
| 201 | `{"ok":true,"reportId":"rpt_..."}` | Report stored. |
| 200 | `{"ok":true,"reportId":"rpt_...","duplicate":true}` | Retry of a report already stored: same ID returned, nothing duplicated. Treat 200 and 201 both as success. |
| 400 | `{"ok":false,"error":"validation_failed","details":[{"field":"description","code":"too_short"}]}` | Invalid body. `details[].code` is one of `required`, `too_short`, `too_long`, `length`, `invalid_type`, `invalid_uuid`, `invalid_game_key`, `invalid_characters`, `invalid_value`, `out_of_range`, `unknown_field`. Also `invalid_json`, `unsupported_schema`. Do not retry. |
| 401 | `missing_key` or `invalid_key` | No key, unknown key, or revoked key. Do not retry. |
| 403 | `game_mismatch` | This key may not submit for that `gameKey`. |
| 405 | `method_not_allowed` | Only POST. |
| 408 / 413 / 415 | `request_timeout`, `payload_too_large`, `unsupported_media_type` | Body not delivered in 5 s, over 40 KB, or not JSON. |
| 409 | `submission_conflict` | That `submissionId` was already used for a **different** report. Generate a new ID only if it really is a new report. |
| 429 | `rate_limited` plus a `Retry-After` header (seconds) | Too many requests. Retry later with the same `submissionId`. |
| 5xx | `{"ok":false,"error":"server"}` | Temporary. Retry with the same `submissionId`. |

Every error has `{"ok":false,"error":"<stable code>","message":"..."}`. Never a stack trace.

### Roblox-side behaviour to implement

- **Per-player cooldown, enforced on the Roblox server:** one report per player per 60 seconds, at most 5 per hour. The site's own limits (60 per minute and 600 per hour per game key, 20 wrong-key attempts per 15 minutes per address) are only a safety net and are shared by all players.
- Validate lengths on the Roblox server before sending (same limits). The client form is not trusted.
- Retry only on network failure, 429 or 5xx: at most 3 tries, with backoff (and `Retry-After` for 429), always with the same `submissionId`. `HttpService` has no configurable timeout, so wrap the call in `pcall`.
- Keep the key in the experience's **Secrets** (Creator Hub) and read it with `HttpService:GetSecret(...)` from a server Script only. Never in a LocalScript, ReplicatedStorage, a ModuleScript the client can read, or Git. (Check Roblox's current Secrets documentation for the exact way to pass a secret into a request header; this site was not tested against a live Roblox server.)

## 2. Owner dashboard

- The **Admin** entry in the account menu and the **Roblox Games** tab appear only for the owner. The server decides: every `/api/owner/*` request needs a valid login whose **Discord user ID** equals `OWNER_DISCORD_ID`. Hiding the tab alone would protect nothing, and the check is repeated on every request.
- Any change needs the same-origin check **and** a CSRF token bound to the login session.
- Player text is rendered only as plain text. The dashboard code has no HTML-building paths, and a test enforces that.
- Reports: newest first, 25 per page, status filter (New, Investigating, Fixed, Closed), search over text, build, report ID and your notes. Each report shows description, steps, expected/actual, build, place and universe IDs, platform, viewport and submission time. You set the status, your private notes and an optional "fixed in version". The last change is recorded (who and when) and a short history lists what changed (notes themselves are not copied into the history).
- **Submission keys:** create, list and revoke per game. A new key is shown once; only a SHA-256 fingerprint is stored. A key can only submit. Creating or revoking a key is written to the admin log.

### Adding another Roblox game

Insert a row, then create its key from the dashboard:

```sql
INSERT INTO roblox_games (game_key, name, created_at) VALUES ('mygame', 'My Game', strftime('%s','now') * 1000);
```

(`game_key`: lowercase letters, digits and hyphens, up to 32 characters.) The game then appears in the list.

## 3. Configuration

No new Cloudflare binding. Existing ones are reused: `DB` (D1) and the Discord login secrets `DISCORD_CLIENT_ID` and `DISCORD_CLIENT_SECRET`.

| Name | Type | Required | Purpose |
|---|---|---|---|
| `OWNER_DISCORD_ID` | Secret (so deploys do not wipe it) | **Yes** | Your numeric Discord user ID (Discord: Settings > Advanced > Developer Mode, then right-click yourself > Copy User ID). Until it is set, nobody can open the dashboard. |
| `REPORT_RETENTION_DAYS` | Variable | No (default 180) | Fixed and Closed reports are deleted this many days after their last change. |
| `REPORT_RETENTION_OPEN_DAYS` | Variable | No (default 365) | New and Investigating reports are deleted this many days after submission. |

Set them in Cloudflare: Workers & Pages > kuro-labs > Settings > Variables and secrets. Never paste the Discord ID or any key into a chat or into Git.

The new tables are created automatically on the first request after deploy (migration 3 in `schema.js`), like the existing ones.

You must have logged in on the site with Discord (and, if you registered by email, linked Discord from the account page) so your account carries your Discord ID. Only an ID confirmed by Discord's login is ever stored.

## 4. Key setup and rotation

1. Open /admin/ > Roblox Games > JetBreak > **Submission keys** > name it (for example `production`) > **Create new key**. Copy it immediately.
2. In Roblox Creator Hub, add it to the experience's Secrets. Close the page.
3. **Rotate:** create a second key, put it in the Roblox Secrets, publish, check the old key's "last used" stops updating, then **Revoke** the old one. Revoking takes effect immediately.
4. If a key leaks: revoke it at once, create a new one.

## 5. Privacy and retention

Stored per report: the text the player wrote, the game build, place and universe IDs, platform string and viewport size, and the times. No player name, Roblox user ID, IP address, email or inventory. Submission rate limits for wrong keys use a keyed hash of the connection address that is deleted within 2 days, the same as the accounts system.

Deleted automatically by the nightly job (03:17 UTC): see the retention variables above, and revoked keys 30 days after revocation. The **privacy page** (`site/legal.cjs`) does not mention game bug reports yet; add a line before the game starts sending them. That needs a version bump of the privacy text, so it is not changed here.

## 6. Tests

```powershell
Set-Location -LiteralPath 'D:\Cowork\kuro-labs'
node .\site\reports\tests\reports.test.js        # this feature (12 tests)
node .\site\accounts\tests\accounts.test.js      # accounts, unchanged behaviour
node .\site\dnl\tests\worker-wiring.test.mjs     # the Worker routes
node .\site\tests\public-integrity.test.mjs      # generated pages
```

Try the dashboard locally with the dev server (`node .\site\dnl\dev-server.mjs`): log in with the pretend Discord at <http://localhost:8787/api/auth/discord> (enter `dev-123456789012345678`), register, then open `http://localhost:8787/__dev/make-owner?u=YOURNAME`, and go to /admin/.
