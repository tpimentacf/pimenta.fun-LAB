/**
 * rate-limit — Pimenta Lab
 *
 * Enforces a rate limit using the native Workers Rate Limiting binding
 * (env.WORKER_RL.limit({ key })) and returns HTTP 429 once the threshold is
 * exceeded. Allowed requests fall through to the origin so the lab page loads.
 *
 * Powers https://www.pimenta.fun/ratelimiting/worker-rl/
 *
 * Binding config lives in wrangler.toml ([[ratelimits]] name = "WORKER_RL",
 * simple = { limit = 5, period = 60 }). Requires Wrangler >= 4.36.0.
 *
 * LAB CHOICE: we key on CF-Connecting-IP + path so a single tester can trip the
 * limit and see the 429. In production, prefer a stable identifier (API key,
 * user/tenant ID) over IP — many users can share one IP. Counters are local to
 * each Cloudflare data center (colo).
 */

const LIMIT = 5;       // keep in sync with wrangler.toml simple.limit
const PERIOD = 60;     // keep in sync with wrangler.toml simple.period (10 or 60)

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // If the binding is missing (not yet configured), fail open so the page
    // still loads rather than erroring.
    if (!env.WORKER_RL || typeof env.WORKER_RL.limit !== "function") {
      return fetch(request);
    }

    const ip = request.headers.get("CF-Connecting-IP") || "unknown";
    const key = ip + ":" + url.pathname;

    const { success } = await env.WORKER_RL.limit({ key });

    if (!success) {
      return new Response(
        "429 Too Many Requests — limit is " + LIMIT + " requests / " + PERIOD +
          "s per IP for " + url.pathname + ". Wait and retry.",
        {
          status: 429,
          headers: {
            "content-type": "text/plain; charset=utf-8",
            "retry-after": String(PERIOD),
            "cache-control": "no-store",
            "x-ratelimit-limit": String(LIMIT),
            "x-ratelimit-key": key,
          },
        }
      );
    }

    // Allowed — pass through to the origin (or next Worker/CDN).
    return fetch(request);
  },
};
