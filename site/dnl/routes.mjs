// Dragons & Ladders — HTTP routes, called from site/worker.js for anything under /api/dnl/.
//
//   POST /api/dnl/room             create a room                -> {code}
//   GET  /api/dnl/room/CODE        is there such a room?        -> {code, phase, players, max, joinable}  |  404
//   GET  /api/dnl/room/CODE/ws     WebSocket (see do.mjs for the messages)
//
// The code is the only "key" to a room, exactly like Mytheder's private rooms: 5 characters, typed in
// any case, with O/I/L accepted for 0/1/1.
import logic from './logic.js';

const json = (obj, status = 200) => new Response(JSON.stringify(obj), {
  status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }
});

const roomStub = (env, code) => env.DNL_ROOMS.get(env.DNL_ROOMS.idFromName('room:' + code));

// Returns a Response, or null when the path is not ours.
export async function handleDnl(request, env) {
  const url = new URL(request.url);
  const parts = url.pathname.split('/').filter(Boolean);       // ['api','dnl','room', CODE?, 'ws'?]
  if (parts[0] !== 'api' || parts[1] !== 'dnl') return null;
  if (!env.DNL_ROOMS) return json({ error: 'unavailable' }, 503);

  try {
    if (parts[2] !== 'room') return json({ error: 'not_found' }, 404);

    if (parts.length === 3) {
      if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
      for (let i = 0; i < 8; i++) {                           // a code that is already taken is simply retried
        const code = logic.newCode();
        const r = await roomStub(env, code).fetch('https://dnl.internal/init', { method: 'POST', body: JSON.stringify({ code }) });
        if (r.status === 200) return json({ code });
        if (r.status !== 409) return json({ error: 'server' }, 500);
      }
      return json({ error: 'busy' }, 503);
    }

    const code = logic.normalizeCode(parts[3]);
    if (!logic.isValidCode(code)) return json({ error: 'bad_code' }, 400);

    if (parts.length === 4) {
      if (request.method !== 'GET') return json({ error: 'method_not_allowed' }, 405);
      const r = await roomStub(env, code).fetch('https://dnl.internal/info');
      return new Response(r.body, { status: r.status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
    }

    if (parts.length === 5 && parts[4] === 'ws') {
      if (request.headers.get('Upgrade') !== 'websocket') return json({ error: 'expected_websocket' }, 426);
      const origin = request.headers.get('Origin');          // only pages from this site may open the socket
      if (origin) {
        let ok = false;
        try { ok = new URL(origin).host === url.host; } catch (e) { ok = false; }
        if (!ok) return json({ error: 'forbidden' }, 403);
      }
      return roomStub(env, code).fetch(request);                // the room reads the last path segment ("ws")
    }

    return json({ error: 'not_found' }, 404);
  } catch (err) {
    return json({ error: 'server' }, 500);                    // never leak internals
  }
}
