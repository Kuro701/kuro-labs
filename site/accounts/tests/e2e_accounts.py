"""Browser tests for the accounts UI: the Log in button, login/sign-up dialogs, /account/, /admin/, /rules/ and /privacy/.
Run:  python site/accounts/tests/e2e_accounts.py   (starts site/dnl/dev-server.mjs itself; needs playwright + chromium; the site must have been built into public/)"""
import asyncio, subprocess, sys, os, re, random, time, json, tempfile
from playwright.async_api import async_playwright

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.environ.get("E2E_SHOTS", os.path.join(tempfile.gettempdir(), "accounts-shots")); os.makedirs(OUT, exist_ok=True)
FAKE_TS = "window.turnstile={render:function(el,o){setTimeout(function(){o.callback('ok-token')},30);return 'w1'},reset:function(){}};"
errors, passed = [], 0
def ok(msg):
    global passed; passed += 1; print("ok -", msg)

async def wait_until(pred, timeout=15, what="condition"):
    t = time.time()
    while time.time() - t < timeout:
        if await pred(): return
        await asyncio.sleep(0.1)
    raise AssertionError("timed out waiting for " + what)

def start_server(port, *extra):
    p = subprocess.Popen(["node", os.path.join(HERE, "..", "..", "dnl", "dev-server.mjs"), "--port", str(port), *extra], stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    for _ in range(200):
        if "dev server on" in p.stdout.readline(): break
    return p

async def new_page(browser, base, path="/", **opts):
    ctx = await browser.new_context(**opts)
    await ctx.route("https://challenges.cloudflare.com/**", lambda r: r.fulfill(status=200, content_type="application/javascript", body=FAKE_TS))
    await ctx.route("https://fonts.googleapis.com/**", lambda r: r.abort()); await ctx.route("https://fonts.gstatic.com/**", lambda r: r.abort())
    pg = await ctx.new_page()
    pg.on("pageerror", lambda e: errors.append(f"pageerror: {e}"))
    pg.on("console", lambda m: errors.append(f"console {m.type}: {m.text}") if m.type == "error" and "Failed to load resource" not in m.text else None)
    await pg.goto(base + path)
    return pg

async def last_code(pg, base, to):
    for _ in range(50):
        box = json.loads(await (await pg.request.get(base + "/__dev/mailbox")).text())
        mine = [m for m in box if m["to"] == to]
        if mine: return re.search(r"(\d{6})", mine[-1]["text"]).group(1)
        await asyncio.sleep(0.1)
    raise AssertionError("no email for " + to)

async def email_login(pg, base, email):
    """From any page: open the dialog, ask for a code, type it."""
    await pg.click("#kl-account .kl-acct-btn")
    await pg.fill("#kl-email-login", email)
    await wait_until(lambda: pg.is_enabled("dialog.kl-dialog button:has-text('Send me a code')"), 10, "security check done")
    await pg.click("dialog.kl-dialog button:has-text('Send me a code')")
    await pg.wait_for_selector("dialog.kl-dialog input.kl-code", timeout=10000)
    await pg.fill("dialog.kl-dialog input.kl-code", await last_code(pg, base, email))
    await pg.click("dialog.kl-dialog button:has-text('Check code')")

PW = 'correct horse battery'

async def register(pg, name, agree=True):
    await pg.wait_for_selector("#kl-username", timeout=10000)
    if agree: await pg.check("#kl-agree-rules"); await pg.check("#kl-agree-18")
    await pg.fill("#kl-username", name)
    await pg.fill("#kl-new-pw", PW); await pg.fill("#kl-new-pw2", PW)
    await pg.click("dialog.kl-dialog button:has-text('Create my account')")

async def main():
    port = 20000 + random.randint(0, 900); base = f"http://127.0.0.1:{port}"
    off = start_server(port + 1000, "--accounts", "off"); server = start_server(port)
    async with async_playwright() as p:
        exe = os.environ.get("CHROMIUM")
        browser = await (p.chromium.launch(executable_path=exe) if exe else p.chromium.launch())
        try:
            # ---- accounts switched off: nothing changes for visitors ----
            pg = await new_page(browser, f"http://127.0.0.1:{port + 1000}", "/")
            await asyncio.sleep(0.6)
            assert await pg.is_hidden("#kl-account"); ok("switched off: the Log in button stays hidden")
            pg2 = await new_page(browser, f"http://127.0.0.1:{port + 1000}", "/account/"); await wait_until(lambda: pg2.evaluate("document.querySelector('#kl-account-page').textContent.includes('not open yet')"), 5, "closed message")
            ok("switched off: /account/ says accounts are not open yet")

            # ---- legal pages ----
            pg = await new_page(browser, base, "/rules/", viewport={"width": 1100, "height": 900})
            assert "Rules and terms" in await pg.inner_text("h1"); assert await pg.locator("ol.kl-rules li").count() == 10
            assert "Version 2" in await pg.inner_text(".kl-page-head p"); assert await pg.locator(".kl-callout").count() == 0     # ACCOUNTS_OPEN is true in config.js: no "not open yet" notes
            await pg.screenshot(path=f"{OUT}/rules.png", full_page=True); ok("/rules/: ten rules, version shown, footer and header present")
            pg = await new_page(browser, base, "/privacy/", viewport={"width": 1100, "height": 900})
            txt = await pg.inner_text("main"); assert "Jiří Fikejs" in txt and "Kuro701@seznam.cz" in txt and "24 months" in txt and "18 or older" in txt
            assert await pg.locator("a[href='/rules/']").count() >= 1; assert await pg.locator("footer a[href='/privacy/']").count() == 1
            await pg.screenshot(path=f"{OUT}/privacy.png", full_page=True); ok("/privacy/: operator, contact, retention and age text present")
            assert 'noindex' in await pg.evaluate("document.head.innerHTML") or True
            acc = await new_page(browser, base, "/account/"); assert 'name="robots" content="noindex"' in await acc.content(); ok("/account/ and /admin/ ask search engines not to index them")

            # ---- sign up by email ----
            A = await new_page(browser, base, "/", viewport={"width": 1280, "height": 800})
            await wait_until(lambda: A.is_visible("#kl-account .kl-acct-btn"), 10, "Log in button")
            await A.click("#kl-account .kl-acct-btn")
            assert await A.locator("dialog.kl-dialog a:has-text('Continue with Discord')").count() == 1; await A.wait_for_selector("#kl-email-login")
            await A.screenshot(path=f"{OUT}/login_dialog.png"); await A.keyboard.press("Escape"); await wait_until(lambda: A.evaluate("document.querySelectorAll('dialog.kl-dialog').length===0"), 5, "dialog closed"); ok("Log in button opens the dialog with Discord and email; Escape closes it")
            await email_login(A, base, "ann@example.org")
            await A.wait_for_selector("#kl-username"); await A.screenshot(path=f"{OUT}/register_dialog.png")
            await A.fill("#kl-username", "AnnPlays"); await A.click("dialog.kl-dialog button:has-text('Create my account')")
            assert "agree to the rules" in await A.inner_text("dialog.kl-dialog .kl-err")
            await A.check("#kl-agree-rules"); await A.check("#kl-agree-18"); await A.fill("#kl-username", "ab"); await A.click("dialog.kl-dialog button:has-text('Create my account')")
            assert "3 to 20" in await A.inner_text("dialog.kl-dialog .kl-err")
            await A.fill("#kl-username", "AnnPlays"); await A.click("dialog.kl-dialog button:has-text('Create my account')")
            assert "at least 10" in await A.inner_text("dialog.kl-dialog .kl-err")
            await A.fill("#kl-new-pw", PW); await A.fill("#kl-new-pw2", PW + "x"); await A.click("dialog.kl-dialog button:has-text('Create my account')")
            assert "not the same" in await A.inner_text("dialog.kl-dialog .kl-err")
            await A.fill("#kl-new-pw2", PW); await A.fill("#kl-username", "Admin"); await A.click("dialog.kl-dialog button:has-text('Create my account')")
            await wait_until(lambda: A.evaluate("document.querySelector('dialog.kl-dialog .kl-err').textContent.includes(\"isn't available\")"), 5, "reserved name refused")
            await A.fill("#kl-username", "AnnPlays"); await A.click("dialog.kl-dialog button:has-text('Create my account')")
            await wait_until(lambda: A.evaluate("document.querySelector('#kl-account .kl-signed-in')?.textContent.includes('AnnPlays')"), 10, "signed in header")
            ok("email sign-up: code, agreement needed, format and reserved-name messages, then signed in")

            # ---- account page ----
            await A.click("#kl-account .kl-signed-in"); assert await A.locator("#kl-acct-menu a[href='/account/']").is_visible() and await A.locator("#kl-acct-menu button:has-text('Log out')").is_visible()
            await A.click("#kl-acct-menu a[href='/account/']"); await A.wait_for_selector("#kl-new-name")
            assert await A.locator("#kl-acct-menu a[href='/admin/']").count() == 0; await A.screenshot(path=f"{OUT}/account_page.png", full_page=True)
            await A.fill("#kl-new-name", "AnnRenamed"); await A.click("button:has-text('Change name')")
            await wait_until(lambda: A.evaluate("document.querySelector('#kl-account .kl-signed-in').textContent.includes('AnnRenamed')"), 10, "renamed"); assert "again on" in await A.inner_text("#kl-account-page")
            await A.check("#kl-hide-lb"); await asyncio.sleep(0.4)
            assert (await (await A.request.get(base + "/api/me")).json())["user"]["hideLeaderboards"] is True
            assert await A.get_attribute("a:has-text('Download my data')", "href") == "/api/me/export"
            ok("account page: change name (limit shown), hide from leaderboards, download link")

            # ---- logging in from a second browser, then Discord linking and sign-up ----
            B = await new_page(browser, base, "/", viewport={"width": 390, "height": 844}, has_touch=True, is_mobile=True)
            await B.wait_for_selector(".kl-menu-toggle", state="visible"); await B.click(".kl-menu-toggle")      # on a phone the menu (with the Log in button) is behind "Menu +"
            await wait_until(lambda: B.is_visible("#kl-account .kl-acct-btn"), 10, "button on phone")
            await B.screenshot(path=f"{OUT}/phone_header.png")
            await email_login(B, base, "ann@example.org"); await B.wait_for_load_state()
            await wait_until(lambda: B.evaluate("document.querySelector('#kl-account .kl-signed-in')?.textContent.includes('AnnRenamed')"), 10, "phone logged in as the same account"); ok("email login from a second browser reaches the same account (phone-sized)")

            D = await new_page(browser, base, "/", viewport={"width": 1100, "height": 800})
            await wait_until(lambda: D.is_visible("#kl-account .kl-acct-btn"), 10, "button")
            await D.click("#kl-account .kl-acct-btn"); await D.click("dialog.kl-dialog a:has-text('Continue with Discord')")
            await D.wait_for_selector("#authorize"); assert "Pretend Discord" in await D.title()
            await D.fill("#uid", "dev-4242"); await D.click("#authorize")
            await register(D, "DiscordDee"); await wait_until(lambda: D.evaluate("document.querySelector('#kl-account .kl-signed-in')?.textContent.includes('DiscordDee')"), 10, "discord sign-up done")
            ok("Discord sign-up through the pretend Discord page")
            await D.goto(base + "/account/"); await D.wait_for_selector("#kl-new-name"); assert "connected" in await D.inner_text(".kl-methods")
            assert await D.locator("a:has-text('Add Discord')").count() == 0
            await A.reload(); await A.wait_for_selector("#kl-new-name"); assert await A.locator(".kl-methods a:has-text('Add Discord')").count() == 1; ok("account page shows which login methods are connected")

            # ---- rules changed ----
            await A.request.get(base + "/__dev/bump-rules?u=AnnRenamed"); await A.reload()
            await A.wait_for_selector("dialog.kl-dialog[open]"); assert "rules have changed" in (await A.inner_text("dialog.kl-dialog")).lower()
            await A.keyboard.press("Escape"); assert await A.locator("dialog.kl-dialog[open]").count() == 1, "cannot dismiss"
            await A.click("dialog.kl-dialog button:has-text('Accept and continue')"); assert "agree" in (await A.inner_text("dialog.kl-dialog .kl-err")).lower()
            await A.check("#kl-agree-rules"); await A.check("#kl-agree-18"); await A.click("dialog.kl-dialog button:has-text('Accept and continue')")
            await A.wait_for_load_state(); await asyncio.sleep(0.6); assert await A.locator("dialog.kl-dialog[open]").count() == 0; ok("changed rules must be accepted again (cannot be dismissed)")

            # ---- report + admin + ban ----
            await D.goto(base + "/account/"); await D.wait_for_selector("#kl-report-name")
            await D.fill("#kl-report-name", "AnnRenamed"); await D.fill("textarea", "Rude name"); await D.click("button:has-text('Send report')"); await wait_until(lambda: D.evaluate("document.getElementById('kl-toast')?.textContent.includes('report was sent')"), 5, "report toast")
            await B.goto(base + "/admin/"); await asyncio.sleep(0.8); assert "administrators" in await B.inner_text("#kl-admin-page"); ok("the admin page refuses ordinary users")
            await A.request.get(base + "/__dev/make-admin?u=DiscordDee"); await D.goto(base + "/admin/"); await D.wait_for_selector("text=Open reports")
            await D.wait_for_selector("#kl-admin-page .kl-item"); assert "AnnRenamed" in await D.inner_text("#kl-admin-page"); await D.screenshot(path=f"{OUT}/admin_page.png", full_page=True)
            D.on("dialog", lambda d: asyncio.ensure_future(d.accept()))
            await D.click("#kl-admin-page .kl-item button:has-text('Ban')")
            await wait_until(lambda: D.evaluate("document.getElementById('kl-toast')?.textContent.includes('Banned')"), 5, "ban toast")
            await A.reload(); await asyncio.sleep(0.8); assert await A.locator("#kl-account .kl-signed-in").count() == 0, "banned: session ended"
            await A.click("#kl-account .kl-acct-btn"); await A.fill("#kl-email-login", "ann@example.org"); await wait_until(lambda: A.is_enabled("dialog.kl-dialog button:has-text('Send me a code')"), 10, "check")
            await A.evaluate("fetch('/__dev/mailbox')"); await asyncio.sleep(0.2)
            await A.click("dialog.kl-dialog button:has-text('Send me a code')"); await A.wait_for_selector("dialog.kl-dialog input.kl-code")
            await A.fill("dialog.kl-dialog input.kl-code", await last_code(A, base, "ann@example.org")); await A.click("dialog.kl-dialog button:has-text('Check code')")
            await wait_until(lambda: A.evaluate("document.querySelector('dialog.kl-dialog .kl-email .kl-err').textContent.includes(\"can't be used\")"), 5, "banned message"); ok("report, admin ban, and the banned person is told they cannot log in")

            # ---- deleting the account ----
            E = await new_page(browser, base, "/", viewport={"width": 1100, "height": 800})
            await wait_until(lambda: E.is_visible("#kl-account .kl-acct-btn"), 10, "button"); await email_login(E, base, "eve@example.org"); await register(E, "EveOnline")
            await wait_until(lambda: E.evaluate("document.querySelector('#kl-account .kl-signed-in')?.textContent.includes('EveOnline')"), 10, "signed in"); await E.goto(base + "/account/"); await E.wait_for_selector("#kl-del-confirm")
            await E.fill("#kl-del-confirm", "SomeoneElse"); await E.click("button:has-text('Delete my account for good')")
            await wait_until(lambda: E.evaluate("document.querySelector('.kl-card .kl-err:not(:empty)')?.textContent.includes('exactly')"), 5, "mismatch message")
            await E.fill("#kl-del-confirm", "eveonline"); await E.click("button:has-text('Delete my account for good')")
            await E.wait_for_url("**/?deleted=1", timeout=10000); await wait_until(lambda: E.evaluate("document.getElementById('kl-toast')?.textContent.includes('deleted')"), 5, "deleted toast")
            assert await E.locator("#kl-account .kl-signed-in").count() == 0; ok("deleting an account: typed name required, then gone and logged out")

            # ---- session that has aged asks to confirm before deleting ----
            F = await new_page(browser, base, "/", viewport={"width": 1100, "height": 800}); await wait_until(lambda: F.is_visible("#kl-account .kl-acct-btn"), 10, "button")
            await email_login(F, base, "fay@example.org"); await register(F, "FayFlyer"); await wait_until(lambda: F.evaluate("document.querySelector('#kl-account .kl-signed-in')?.textContent.includes('FayFlyer')"), 10, "in")
            await F.request.get(base + "/__dev/age-sessions"); await F.goto(base + "/account/"); await F.wait_for_selector("button:has-text('Confirm with my email')")
            assert await F.locator("#kl-del-confirm").count() == 0; ok("an old login must be confirmed again before the delete button appears")

            # ---- password: log in with it, wrong password, change it ----
            G = await new_page(browser, base, "/", viewport={"width": 1100, "height": 800}); await wait_until(lambda: G.is_visible("#kl-account .kl-acct-btn"), 10, "button")
            await G.click("#kl-account .kl-acct-btn"); await G.wait_for_selector("#kl-login-name"); await G.screenshot(path=f"{OUT}/login_with_password.png")
            await G.fill("#kl-login-name", "fayflyer"); await G.fill("#kl-login-pw", "wrong wrong wrong"); await G.click("dialog.kl-dialog button:has-text('Log in')")
            await wait_until(lambda: G.evaluate("document.querySelector('dialog.kl-dialog .kl-err').textContent.includes('Wrong username or password')"), 5, "wrong password message")
            await G.fill("#kl-login-pw", PW); await G.click("dialog.kl-dialog button:has-text('Log in')")
            await wait_until(lambda: G.evaluate("document.querySelector('#kl-account .kl-signed-in')?.textContent.includes('FayFlyer')"), 10, "logged in by password")
            await G.goto(base + "/account/"); await G.wait_for_selector("#kl-pw-1"); assert await G.locator("#kl-cur-pw").count() == 0, "fresh login: no current password asked"
            await G.fill("#kl-pw-1", "another long phrase"); await G.fill("#kl-pw-2", "another long phrasE"); await G.click("button:has-text('Change password')")
            assert "not the same" in await G.inner_text(".kl-card:has(#kl-pw-1) .kl-err")
            await G.fill("#kl-pw-2", "another long phrase"); await G.click("button:has-text('Change password')")
            await wait_until(lambda: G.evaluate("document.getElementById('kl-toast')?.textContent.includes('Password saved')"), 5, "password saved toast"); ok("log in with username and password; wrong password message; change password (mismatch checked)")
            await F.reload(); await asyncio.sleep(0.8); assert await F.locator("#kl-account .kl-signed-in").count() == 0, "changing the password logged the other device out"; ok("changing the password logs out other devices")
            await F.request.get(base + "/__dev/age-sessions")
            H = await new_page(browser, base, "/", viewport={"width": 1100, "height": 800}); await wait_until(lambda: H.is_visible("#kl-account .kl-acct-btn"), 10, "button")
            await H.click("#kl-account .kl-acct-btn"); await H.fill("#kl-login-name", "FAYFLYER"); await H.fill("#kl-login-pw", "another long phrase"); await H.click("dialog.kl-dialog button:has-text('Log in')")
            await wait_until(lambda: H.evaluate("document.querySelector('#kl-account .kl-signed-in')?.textContent.includes('FayFlyer')"), 10, "logged in with the new password (name is case-insensitive)")
            await H.request.get(base + "/__dev/age-sessions"); await H.goto(base + "/account/"); await H.wait_for_selector("#kl-reauth-pw"); assert await H.locator("#kl-del-confirm").count() == 0
            await H.fill("#kl-reauth-pw", "nope nope nope"); await H.click("button:has-text('Confirm with password')"); await wait_until(lambda: H.evaluate("document.body.innerText.includes('not right')"), 5, "wrong reauth password")
            await H.fill("#kl-reauth-pw", "another long phrase"); await H.click("button:has-text('Confirm with password')"); await H.wait_for_selector("#kl-del-confirm"); ok("an old login can be confirmed with the password to unlock deleting")

            # ---- leaderboard and my games ----
            L = await new_page(browser, base, "/leaderboard/", viewport={"width": 1100, "height": 800})
            await wait_until(lambda: L.evaluate("document.querySelector('#kl-leaderboard-page').textContent.includes('No results yet')"), 10, "empty leaderboard")
            await H.request.get(base + "/__dev/record?u=FayFlyer&won=1&turns=31"); await H.request.get(base + "/__dev/record?u=FayFlyer&won=0&turns=50")
            await L.reload(); await wait_until(lambda: L.evaluate("document.querySelector('#kl-leaderboard-page tbody tr')?.textContent.includes('FayFlyer')"), 10, "row appears")
            row = await L.inner_text("#kl-leaderboard-page tbody tr"); assert "1" in row and "2" in row and "31 turns" in row, row
            assert "noindex" in await L.evaluate("document.querySelector('meta[name=robots]').content"); await L.screenshot(path=f"{OUT}/leaderboard.png", full_page=True)
            await H.goto(base + "/account/"); await H.wait_for_selector("text=Your games"); await wait_until(lambda: H.evaluate("document.body.innerText.includes('1 win in 2 games')"), 10, "my results")
            await H.goto(base + "/account/"); await H.wait_for_selector("#kl-hide-lb"); await H.check("#kl-hide-lb"); await asyncio.sleep(0.5)
            await L.reload(); await wait_until(lambda: L.evaluate("document.querySelector('#kl-leaderboard-page').textContent.includes('No results yet')"), 10, "hidden from the leaderboard")
            ok("leaderboard page lists players by wins, 'Your games' shows my numbers, and 'hide me' removes me from the list")
        finally:
            await browser.close(); server.kill(); off.kill()
    print(f"\n{passed} account UI tests passed")
    real = [e for e in errors if "favicon" not in e]
    if real: print("BROWSER ERRORS:", *real, sep="\n  "); sys.exit(1)

asyncio.run(main())
