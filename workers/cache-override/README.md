# cache-override

A Cloudflare Worker that forces a **3600&nbsp;second CDN edge TTL** whenever the
origin responds with a `Cache-Control: max-age=x` header, while preserving the
origin's browser TTL.

## Why the Cache API?

Cloudflare's `cf.cacheTtl` fetch option must be set **before** the request is
issued, but the origin's `Cache-Control` header can only be read **after** the
response arrives. Those requirements are mutually exclusive with a single
`fetch()`, so this Worker stores the response itself with `caches.default`
after inspecting it.

## How it works

1. Skip non-cacheable methods (only `GET` / `HEAD`).
2. `cache.match()` — return the cached response on a HIT.
3. On a MISS, `fetch(request)` the origin (no `cf` overrides).
4. Pass through non-2xx responses without caching.
5. Parse `max-age` from the origin `Cache-Control` with `/\bmax-age=(\d+)\b/`.
6. Clone the response, set `Cache-Control: public, s-maxage=3600, max-age=<origin>`,
   and `cache.put()` non-blocking via `ctx.waitUntil()`.

## Deploy

```bash
cd workers/cache-override
npx wrangler deploy
```

Verify:

```bash
curl -sI https://www.pimenta.fun/cache/cache-worker/ | grep -i cf-cache-status
# first request  -> MISS
# same PoP again -> HIT (within the s-maxage TTL)
```

## Notes / limitations

- `caches.default` does **not** propagate through Tiered Cache.
- The Cache API is **per data center** — each PoP warms independently.
- Always `response.clone()` before `cache.put()` (a body stream is consumed once).
- An origin `Vary` header adds those request headers to the cache key.

Docs: https://developers.cloudflare.com/workers/runtime-apis/cache/
