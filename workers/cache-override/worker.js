// Cache Control Override via Workers
// --------------------------------------------------------------------------
// Forces a 3600s Cloudflare edge (CDN) TTL whenever the origin responds with a
// `Cache-Control: max-age=x` header, while preserving the origin's browser TTL.
//
// Why the Cache API instead of fetch(request, { cf: { cacheTtl } })?
//   `cf.cacheTtl` must be set BEFORE the fetch is issued, but the origin's
//   Cache-Control header can only be read AFTER the response arrives. Those two
//   requirements are mutually exclusive with a single fetch(), so we store the
//   response ourselves with caches.default after inspecting it.
//
// Bind to a route in wrangler.toml, e.g.:
//   www.pimenta.fun/cache/cache-worker*
// --------------------------------------------------------------------------

export default {
  async fetch(request, env, ctx) {
    // Step 1 — Skip non-cacheable HTTP methods.
    if (!["GET", "HEAD"].includes(request.method)) {
      return fetch(request);
    }

    const CLOUDFLARE_CDN_TTL = 3600; // 1 hour
    const cache = caches.default;
    const cacheKey = new Request(request.url, request);

    // Step 2 — Return cached response if available (cache HIT).
    const cachedResponse = await cache.match(cacheKey);
    if (cachedResponse) {
      return cachedResponse;
    }

    // Step 3 — Cache MISS: fetch from origin without cf overrides.
    const originResponse = await fetch(request);

    // Step 4 — Do not cache error responses.
    if (!originResponse.ok) {
      return originResponse;
    }

    // Step 5 — Read and parse the origin's Cache-Control header.
    const originCacheControl = originResponse.headers.get("Cache-Control") ?? "";
    const maxAgeMatch = originCacheControl.match(/\bmax-age=(\d+)\b/);

    if (maxAgeMatch) {
      const originMaxAge = parseInt(maxAgeMatch[1], 10);

      // Step 6a — Clone the response (origin Response is immutable).
      const response = new Response(originResponse.body, originResponse);

      // Step 6b — Override CDN TTL via s-maxage, preserve browser TTL.
      response.headers.set(
        "Cache-Control",
        `public, s-maxage=${CLOUDFLARE_CDN_TTL}, max-age=${originMaxAge}`
      );

      // Step 6c — Store non-blocking (don't delay the response).
      ctx.waitUntil(cache.put(cacheKey, response.clone()));

      return response;
    }

    // Step 6d — No max-age from origin: pass through without caching.
    return originResponse;
  },
};
