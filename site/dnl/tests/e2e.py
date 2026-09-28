"""Browser tests for Dragons & Ladders: local mode regression + a real two-browser online game.
Run:  python site/dnl/tests/e2e.py   (starts site/dnl/dev-server.mjs --fast itself; needs playwright + chromium)"""
import asyncio, subprocess, sys, os, re, random, time, tempfile
from playwright.async_api import async_playwright

HERE = os.path.dirname(os.path.abspath(__file__))
PORT = 19000 + random.randint(0, 900)
BASE = f"http://127.0.0.1:{PORT}"
GAME = BASE + "/games/dragons-and-ladders/"
OUT = os.environ.get("E2E_SHOTS", os.path.join(tempfile.gettempdir(), "dnl-shots")); os.makedirs(OUT, exist_ok=True)   # screenshots land here
DICE = """window.__q=[];const _g=crypto.getRandomValues.bind(crypto);
crypto.getRandomValues=function(a){ if(window.__q.length&&a instanceof Uint32Array){a[0]=window.__q.shift()-1;return a;} return _g(a); };"""
errors = []
passed = 0
def ok(msg):
    global passed; passed += 1; print("ok -", msg)

async def wait_until(pred, timeout=20, step=0.1, what="condition"):
    t = time.time()
    while time.time() - t < timeout:
        if await pred(): return
        await asyncio.sleep(step)
    raise AssertionError("timed out waiting for " + what)

async def new_page(browser, url, **ctxopts):
    ctx = await browser.new_context(**ctxopts)
    pg = await ctx.new_page()
    pg.on("pageerror", lambda e: errors.append(f"pageerror: {e}"))
    pg.on("console", lambda m: errors.append(f"console {m.type}: {m.text}") if m.type == "error" else None)
    await pg.goto(url)
    return pg

async def state(pg): return await pg.evaluate("(()=>{const s=DNL.S();return {mode:s.mode,turn:s.turn,phase:s.phase,pos:s.players.map(p=>p.pos),names:s.players.map(p=>p.name),sixes:s.sixes}})()")
async def visible(pg, sel): return await pg.is_visible(sel)

async def autoplay(pages, timeout=120):
    """Click Roll whenever it is enabled on any page, until every page shows the winner dialog."""
    t = time.time()
    while time.time() - t < timeout:
        done = True
        for pg in pages:
            if not await pg.is_visible("#winner"):
                done = False
                if await pg.is_enabled("#roll"):
                    try: await pg.click("#roll", timeout=500)
                    except Exception: pass
        if done: return
        await asyncio.sleep(0.05)
    raise AssertionError("game did not finish in time")


async def sign_in(ctx, email, username):
    """Log a browser context in through the real account routes (email code read from the dev mailbox)."""
    H = {"origin": BASE}
    r = await ctx.request.post(BASE + "/api/auth/email/start", data={"email": email, "turnstileToken": "x", "purpose": "login"}, headers=H); assert r.ok, await r.text()
    box = await (await ctx.request.get(BASE + "/__dev/mailbox")).json()
    code = re.search(r"(\d{6})", [m for m in box if m["to"] == email][-1]["text"]).group(1)
    r = await ctx.request.post(BASE + "/api/auth/email/verify", data={"email": email, "code": code, "purpose": "login"}, headers=H); assert (await r.json())["next"] == "register"
    r = await ctx.request.post(BASE + "/api/auth/register", data={"agreedRules": True, "is18": True, "username": username, "password": "correct horse battery"}, headers=H); assert r.ok, await r.text()

async def new_ctx_page(browser, url, **ctxopts):
    ctx = await browser.new_context(**ctxopts); pg = await ctx.new_page()
    pg.on("pageerror", lambda e: errors.append(f"pageerror: {e}"))
    pg.on("console", lambda m: errors.append(f"console {m.type}: {m.text}") if m.type == "error" else None)
    return ctx, pg

async def main():
    server = subprocess.Popen(["node", os.path.join(HERE, "..", "dev-server.mjs"), "--fast", "--port", str(PORT)], stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    for _ in range(100):
        line = server.stdout.readline()
        if "dev server on" in line: break
    async with async_playwright() as p:
        exe = os.environ.get("CHROMIUM")          # optional: path to a Chromium binary; otherwise Playwright's own
        browser = await (p.chromium.launch(executable_path=exe) if exe else p.chromium.launch())
        try:
            # ---------- A. local mode still works (uses the shared engine) ----------
            ctx = await browser.new_context(viewport={"width": 1100, "height": 800}); await ctx.add_init_script(DICE)
            pg = await ctx.new_page(); pg.on("pageerror", lambda e: errors.append(f"pageerror: {e}"))
            pg.on("console", lambda m: errors.append(f"console {m.type}: {m.text}") if m.type == "error" else None)
            await pg.goto(GAME + "?fast=1&debug=1")
            assert await visible(pg, "#setup") and await visible(pg, "#localPane")
            await pg.select_option("#rows .row:nth-child(2) select", "h"); await pg.check("#six"); await pg.click("#go")
            async def ready(): await wait_until(lambda: pg.is_enabled("#roll"), 10, what="roll enabled")
            async def roll(v, setpos=None):
                await ready()
                if setpos is not None: await pg.evaluate(f"DNL.S().players[DNL.S().turn].pos={setpos}")
                await pg.evaluate(f"window.__q.push({v})"); await pg.click("#roll"); await asyncio.sleep(0.3)
                if not await visible(pg, "#winner"): await ready()
                return await state(pg)
            st = await roll(1, 7); assert st["pos"][0] == 33 and st["turn"] == 1, st; ok("local: ladder 7+1 -> 33")
            st = await roll(6, 44); assert st["pos"][1] == 9 and st["turn"] == 1 and st["sixes"] == 1, st; ok("local: dragon 44+6 -> 9, six gives another go")
            st = await roll(2, 99); assert st["pos"][1] == 99 and st["turn"] == 0, st; ok("local: overshoot stays on 99")
            await ready(); await pg.evaluate("DNL.S().players[DNL.S().turn].pos=99; window.__q.push(1)"); await pg.click("#roll")
            await wait_until(lambda: pg.is_visible("#winner"), 5, what="winner dialog")
            assert "Player 1 wins" in await pg.inner_text("#winTitle"); ok("local: exact finish wins")
            await pg.click("#again"); await asyncio.sleep(0.2); st = await state(pg); assert st["pos"] == [0, 0]; ok("local: play again")
            await pg.reload(); assert await visible(pg, "#resume"); await pg.click("#resume"); await asyncio.sleep(0.2)
            assert (await state(pg))["mode"] == "local"; ok("local: save and resume")
            await ctx.close()

            # reduced motion: jumps use the plain glide instead of the climb / slide, and still land on the right square
            rctx = await browser.new_context(viewport={"width": 1100, "height": 800}, reduced_motion="reduce"); await rctx.add_init_script(DICE)
            rp = await rctx.new_page(); rp.on("pageerror", lambda e: errors.append(f"pageerror: {e}"))
            await rp.goto(GAME + "?debug=1")
            await rp.select_option("#rows .row:nth-child(2) select", "h"); await rp.click("#go")
            async def rready(): await wait_until(lambda: rp.is_enabled("#roll"), 15, what="roll enabled (reduced motion)")
            await rready(); await rp.evaluate("DNL.S().players[0].pos=7; window.__q.push(1)"); await rp.click("#roll"); await asyncio.sleep(1.0); await rready()
            assert (await state(rp))["pos"][0] == 33
            await rp.evaluate("DNL.S().players[1].pos=44; window.__q.push(6)"); await rp.click("#roll"); await asyncio.sleep(1.5); await rready()
            assert (await state(rp))["pos"][1] == 9; ok("local: with reduced motion the jumps still work (plain glide)")
            await rctx.close()

            # every ladder and dragon on the board plays its climb / slide and ends on the right square (fast timings, real code path)
            actx = await browser.new_context(viewport={"width": 1100, "height": 800}); await actx.add_init_script(DICE)
            ap = await actx.new_page(); ap.on("pageerror", lambda e: errors.append(f"pageerror: {e}"))
            await ap.goto(GAME + "?fast=1&debug=1")
            await ap.select_option("#rows .row:nth-child(2) select", "h"); await ap.click("#go")
            jumps = await ap.evaluate("DNL.E.JUMPS")
            for j in jumps:
                await wait_until(lambda: ap.is_enabled("#roll"), 15, what="roll enabled")
                t = (await state(ap))["turn"]
                await ap.evaluate(f"DNL.S().players[{t}].pos={j['from']-1}; window.__q.push(1)"); await ap.click("#roll"); await asyncio.sleep(0.25)
                await wait_until(lambda: ap.is_enabled("#roll"), 15, what="after jump")
                assert (await state(ap))["pos"][t] == j["to"], (j, await state(ap))
            ok(f"local: all {len(jumps)} ladders and dragons animate and land on the right square")
            await actx.close()

            # ---------- B. online: two browsers ----------
            va, vb = {"width": 1280, "height": 860}, {"width": 390, "height": 844}
            A = await new_page(browser, GAME + "?fast=1&debug=1", viewport=va)
            await A.click("#modeSeg [data-mode=online]")
            await A.fill("#netName", "Ann"); await A.click("#netCreate")
            await wait_until(lambda: A.is_visible("#lobby"), 10, what="lobby for host")
            code = (await A.inner_text("#lobbyCode")).strip(); assert re.fullmatch(r"[0-9A-HJKMNP-TV-Z]{5}", code), code
            ok(f"online: host created room {code} and sees the lobby")
            assert await visible(A, "#startOnline") and await A.is_disabled("#startOnline")            # alone: cannot start
            await A.screenshot(path=f"{OUT}/lobby_host.png")

            B = await new_page(browser, GAME + f"?fast=1&debug=1&room={code.lower()}", viewport=vb, has_touch=True, is_mobile=True)
            assert await visible(B, "#onlinePane") and (await B.input_value("#netCode")) == code; ok("online: invite link opens the join screen with the code filled in")
            await B.fill("#netName", "Bob"); await B.click("#netJoin")
            await wait_until(lambda: B.is_visible("#lobby"), 10, what="lobby for guest")
            await wait_until(lambda: A.evaluate("document.querySelectorAll('#lobbyPlayers li').length===2"), 10, what="host sees 2 players")
            assert not await visible(B, "#startOnline") and not await visible(B, "#hostTools"); ok("online: guest joins; only the host has Start and Add bot")
            await B.screenshot(path=f"{OUT}/lobby_guest_phone.png")

            await A.click("#addBot"); await wait_until(lambda: B.evaluate("document.querySelectorAll('#lobbyPlayers li').length===3"), 10, what="bot added")
            await A.check("#netSix"); await wait_until(lambda: B.is_checked("#netSix"), 10, what="rule shared"); assert await B.is_disabled("#netSix")
            ok("online: host adds a bot and sets the six rule; the guest sees both")
            await A.click("#startOnline")
            await wait_until(lambda: B.evaluate("DNL.S().phase==='idle'&&DNL.S().players.length===3"), 10, what="game started for guest")
            await wait_until(lambda: A.evaluate("!document.querySelector('#lobby').offsetParent"), 10, what="lobby closed on host")
            ok("online: host starts, both screens switch to the board")
            await asyncio.sleep(1.0); await A.screenshot(path=f"{OUT}/game_host.png"); await B.screenshot(path=f"{OUT}/game_guest_phone.png")
            await autoplay([A, B])
            sa, sb = await state(A), await state(B)
            assert sa["pos"] == sb["pos"] and 100 in sa["pos"], (sa, sb)
            assert (await A.inner_text("#winTitle")) == (await B.inner_text("#winTitle")); ok("online: a whole game to a winner; both screens agree (" + (await A.inner_text("#winTitle")) + ")")
            await A.screenshot(path=f"{OUT}/win_host.png")
            assert await A.is_enabled("#again") and await B.is_disabled("#again") and "host" in (await B.inner_text("#again")).lower(); ok("online: only the host can start the rematch")

            await A.click("#again")
            await wait_until(lambda: B.is_visible("#lobby"), 10, what="both back in lobby")
            await wait_until(lambda: A.is_visible("#lobby"), 10, what="host back in lobby")
            assert (await state(B))["pos"] == [0, 0, 0]; ok("online: rematch returns everyone to the lobby")

            # dropped connection: B loses its socket, reconnects by itself, keeps its seat
            pid_before = await B.evaluate("DNL.Net.pid")
            await B.evaluate("DNL.Net.ws.close()")
            await wait_until(lambda: A.evaluate("DNL.S().players.some(p=>p.connected===false)"), 5, what="host sees B offline")
            await wait_until(lambda: A.evaluate("DNL.S().players.every(p=>p.connected!==false)"), 15, what="B reconnected")
            assert await B.evaluate("DNL.Net.pid") == pid_before and await B.evaluate("DNL.Net.joined"); ok("online: a dropped connection reconnects to the same seat")

            # the room object is thrown away by the platform, the game carries on from storage
            assert (await (await B.request.get(f"{BASE}/__dev/hibernate/{code}")).text()) == "ok"
            await A.click("#startOnline")
            await wait_until(lambda: B.evaluate("DNL.S().phase==='idle'"), 10, what="second game started after eviction")
            await autoplay([A, B]); assert 100 in (await state(A))["pos"]; ok("online: second game after the room object was evicted and restored")
            await A.click("#again"); await wait_until(lambda: A.is_visible("#lobby"), 10, what="lobby again")

            # leave / kick / rejoin
            await B.reload()                                                           # a reload keeps nothing in memory, only the saved seat
            await B.click("#modeSeg [data-mode=online]") if not await visible(B, "#onlinePane") else None
            await wait_until(lambda: B.is_visible("#netRejoin"), 10, what="rejoin button")
            await B.click("#netRejoin"); await wait_until(lambda: B.is_visible("#lobby"), 10, what="rejoined lobby")
            assert await B.evaluate("DNL.Net.pid") == pid_before; ok("online: after a page reload the saved seat can be taken back")
            await B.click("#leaveRoom"); await wait_until(lambda: B.is_visible("#setup"), 10, what="setup after leaving")
            await wait_until(lambda: A.evaluate("document.querySelectorAll('#lobbyPlayers li').length===2"), 10, what="host sees B gone")
            assert not await visible(B, "#netRejoin"); ok("online: leaving removes the seat and forgets it")
            await B.fill("#netName", "Bob"); await B.fill("#netCode", code); await B.click("#netJoin")
            await wait_until(lambda: B.is_visible("#lobby"), 10, what="B joins again")
            bobs = await A.evaluate("[...document.querySelectorAll('#lobbyPlayers li')].find(li=>li.textContent.includes('Bob'))?.querySelector('button')?.textContent")
            assert bobs and "Remove" in bobs
            await A.evaluate("[...document.querySelectorAll('#lobbyPlayers li')].find(li=>li.textContent.includes('Bob')).querySelector('button').click()")
            await wait_until(lambda: B.is_visible("#setup"), 10, what="kicked to setup")
            assert "removed" in (await B.inner_text("#netMsg")); ok("online: the host can remove a player, who is told why")

            # wrong code / full / bad input messages
            await B.fill("#netCode", "ZZZZZ"); await B.click("#netJoin"); await wait_until(lambda: B.evaluate("document.querySelector('#netMsg').textContent.includes('No room')"), 8, what="no room msg")
            await B.fill("#netCode", "12"); await B.click("#netJoin"); assert "does not look right" in await B.inner_text("#netMsg")
            ok("online: friendly messages for unknown and malformed codes")

            # ---------- C. logged-in players, and the host's tools in a running game ----------
            cx, X = await new_ctx_page(browser, GAME, viewport={"width": 1100, "height": 800}); cy, Y = await new_ctx_page(browser, GAME, viewport={"width": 1100, "height": 800}); cz, Z = await new_ctx_page(browser, GAME, viewport={"width": 1100, "height": 800})
            await sign_in(cx, "hostx@example.org", "HostXavier"); await sign_in(cy, "guesty@example.org", "GuestYara")
            for pg in (X, Y, Z): await pg.goto(GAME + "?debug=1")
            await X.click("#modeSeg [data-mode=online]")
            await wait_until(lambda: X.evaluate("document.querySelector('#netName').value==='HostXavier'"), 10, what="name prefilled from the account")
            await X.click("#netCreate"); await wait_until(lambda: X.is_visible("#lobby"), 10, what="host lobby")
            code = (await X.inner_text("#lobbyCode")).strip()
            await Y.click("#modeSeg [data-mode=online]"); await Y.fill("#netCode", code); await Y.click("#netJoin"); await wait_until(lambda: Y.is_visible("#lobby"), 10, what="Y in lobby")
            await Z.click("#modeSeg [data-mode=online]"); await Z.fill("#netName", "Zed"); await Z.fill("#netCode", code); await Z.click("#netJoin"); await wait_until(lambda: Z.is_visible("#lobby"), 10, what="Z in lobby")
            await wait_until(lambda: X.evaluate("document.querySelectorAll('#lobbyPlayers li').length===3"), 10, what="three in the lobby")
            assert "saved to your account" in await X.inner_text("#acctLine"), await X.inner_text("#acctLine")
            assert "guest" in (await Z.inner_text("#acctLine")).lower(); assert await Y.evaluate("document.querySelector('#netName').value") == "GuestYara"
            assert await X.is_visible("#closeRoom2") and not await Y.is_visible("#closeRoom2") and not await Y.is_visible("#closeRoom")
            ok("online: logged-in players get their name filled in and are told results are saved; guests are told to log in")
            await X.click("#startOnline"); await wait_until(lambda: X.evaluate("DNL.S().phase==='idle'"), 10, what="game started")
            await wait_until(lambda: X.is_visible("#closeRoom"), 5, what="host has Close room"); assert not await Y.is_visible("#closeRoom")
            rm = X.locator("#players li", has_text="Zed").locator("button"); await rm.wait_for(timeout=5000)
            assert await X.locator("#players li", has_text="GuestYara").locator("button").count() == 1 and await X.locator("#players li", has_text="HostXavier").locator("button").count() == 0
            assert await Y.locator("#players button").count() == 0                                # only the host gets Remove
            await rm.click(); assert "Sure" in await rm.inner_text(); await rm.click()
            await wait_until(lambda: Z.is_visible("#setup"), 10, what="Zed sent to setup"); assert "removed" in await Z.inner_text("#netMsg")
            await wait_until(lambda: X.evaluate("DNL.S().players.some(p=>p.name==='Zed'&&p.bot)"), 5, what="Zed's seat is now a bot")
            ok("online: in a running game the host removes a player after a second click; their seat becomes a bot")
            close = X.locator("#closeRoom"); await close.click(); assert "everyone" in await close.inner_text(); await close.click()
            await wait_until(lambda: Y.is_visible("#setup"), 10, what="Y told the room closed"); assert "closed" in await Y.inner_text("#netMsg")
            await wait_until(lambda: X.is_visible("#setup"), 10, what="host back at setup")
            ok("online: the host can close the room for everyone")
        finally:
            await browser.close()
    server.kill()
    print(f"\n{passed} browser tests passed")
    real = [e for e in errors if "Failed to load resource" not in e and "favicon" not in e]
    if real: print("BROWSER ERRORS:", *real, sep="\n  "); sys.exit(1)

asyncio.run(main())
