# rate-limit Worker

Enforces a rate limit using the native **Workers Rate Limiting binding** and
returns **HTTP 429** once the threshold is exceeded. Allowed requests fall
through to the origin so the page still loads.

Powers the **Rate Limit by Worker** lab at
<https://www.pimenta.fun/ratelimiting/worker-rl/>.

## Files

| File            | Purpose                                              |
| --------------- | ---------------------------------------------------- |
| `worker.js`     | The Worker — calls `env.WORKER_RL.limit({ key })`.   |
| `wrangler.toml` | Binding (`[[ratelimits]]`) + route config.           |

## How it works

1. The binding `WORKER_RL` is declared in `wrangler.toml` with
   `simple = { limit = 5, period = 60 }` (5 requests per 60s).
2. On each request the Worker builds a **key** (`CF-Connecting-IP : path`) and
   calls `await env.WORKER_RL.limit({ key })`.
3. If `success === false`, it returns `429`. Otherwise it `fetch(request)`s the
   origin.

Counters are **local to each Cloudflare data center (colo)** — the limit is per
colo, per key. The API is fast (no added latency) but eventually consistent, so
treat it as protective, not as exact accounting.

### Key choice

This lab keys on **IP + path** so a single tester trips the limit and sees the
429. In production, prefer a **stable identifier** (API key, user/tenant ID,
route) over IP — many users can share one IP (mobile networks, proxies).

## Requirements

- **Wrangler >= 4.36.0** (the Rate Limiting binding is not available earlier).

## Deploy — step by step

```bash
cd workers/rate-limit
npx wrangler --version          # must be >= 4.36.0
npx wrangler login              # once
npx wrangler deploy
```

What the deploy does:

1. Uploads `worker.js`.
2. Registers the `WORKER_RL` rate limiting binding (`namespace_id = "1001"`,
   limit 5 / 60s).
3. Binds the route `www.pimenta.fun/ratelimiting/worker-rl*` to the Worker, so
   requests to the lab path run through it. (Edit `zone_name` for your zone, or
   remove the route and use the `*.workers.dev` URL for testing.)

### Verify

```bash
for i in $(seq 1 8); do
  curl -s -o /dev/null -w "%{http_code}\n" https://www.pimenta.fun/ratelimiting/worker-rl/
done
# Expect: 200 200 200 200 200 429 429 429
```

Or open the lab page and click **Burst 10** — requests past the 5th return 429.

## Tuning

- Change `simple.limit` / `simple.period` in `wrangler.toml` (period must be
  `10` or `60`), then `wrangler deploy`.
- Keep the `LIMIT` / `PERIOD` constants in `worker.js` in sync (used only for the
  429 message text).
- Use a unique `namespace_id` per independent limiter; reuse the same id across
  Workers to **share** a counter.

## Monitoring

Rate limiting bindings are not shown in the dashboard. Observe 429s via
[Workers Logs / Traces](https://developers.cloudflare.com/workers/observability/)
or emit a data point to
[Analytics Engine](https://developers.cloudflare.com/analytics/analytics-engine/)
when `limit()` returns `{ success: false }`.

Docs:
<https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/>
