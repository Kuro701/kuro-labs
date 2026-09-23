// Cloudflare Worker entry point for kuro-labs.
//
// The site is still static — this Worker only intercepts /api/sales-count
// and hands everything else straight to the ASSETS binding, so normal page
// serving (html_handling, the themed 404, etc.) behaves exactly as before.
//
// GUMROAD_ACCESS_TOKEN is a secret set in the Cloudflare dashboard
// (Workers & Pages -> kuro-labs -> Settings -> Variables and secrets).
// It is never logged, never echoed back, and never written to a file here.

const CACHE_TTL_SECONDS = 600; // 10 min: feels live, doesn't hammer Gumroad's API

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === '/api/sales-count') {
      return handleSalesCount(request, env, ctx);
    }

    return env.ASSETS.fetch(request);
  },
};

async function handleSalesCount(request, env, ctx) {
  const cache = caches.default;
  const cacheKey = new Request(new URL('/api/sales-count', request.url).toString(), request);

  const cached = await cache.match(cacheKey);
  if (cached) return cached;

  if (!env.GUMROAD_ACCESS_TOKEN) {
    return jsonResponse({ ok: false, error: 'not configured' }, 500);
  }

  let counts = {};
  try {
    const res = await fetch('https://api.gumroad.com/v2/products', {
      headers: { Authorization: `Bearer ${env.GUMROAD_ACCESS_TOKEN}` },
    });
    if (!res.ok) throw new Error('gumroad api ' + res.status);
    const data = await res.json();
    const products = Array.isArray(data.products) ? data.products : [];

    for (const p of products) {
      const permalink = extractPermalink(p);
      if (!permalink) continue;
      if (typeof p.sales_count !== 'number') continue;
      counts[permalink.toLowerCase()] = p.sales_count;
    }
  } catch (err) {
    // Fail soft — no numbers is better than a broken page, and this
    // message never includes the token or any raw upstream response.
    return jsonResponse({ ok: false, error: 'unavailable' }, 502);
  }

  const body = jsonResponse({ ok: true, counts, updated: new Date().toISOString() }, 200, CACHE_TTL_SECONDS);
  ctx.waitUntil(cache.put(cacheKey, body.clone()));
  return body;
}

// Gumroad's own field for this has been reported under a couple of names
// depending on API version (custom_permalink vs. deriving it from the
// product's URL) — this checks both so a naming quirk doesn't just return
// zero counts silently.
function extractPermalink(product) {
  if (product.custom_permalink) return String(product.custom_permalink);
  const link = product.short_url || product.url;
  if (!link) return null;
  const match = String(link).match(/\/l\/([^/?#]+)/);
  return match ? match[1] : null;
}

function jsonResponse(obj, status, cacheSeconds) {
  const headers = { 'content-type': 'application/json; charset=utf-8' };
  if (cacheSeconds) headers['cache-control'] = 'public, max-age=' + cacheSeconds;
  return new Response(JSON.stringify(obj), { status, headers });
}
