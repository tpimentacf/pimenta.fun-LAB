# geo-origin

A Cloudflare Worker that **demonstrates Load Balancer origin steering** — it
serves an **EU server** or a **US server** response depending on the visitor's
location, with a header/query override, and reports the chosen pool in the
`X-Served-By` response header.

Live at: `https://www.pimenta.fun/load-balancer/geo-origin/`

## Steering logic

1. **Override** — `?region=eu|us` or request header `x-region: eu|us`
   (this is the equivalent of a Load Balancer *custom rule*).
2. **Geo** — otherwise decided from `request.cf.continent`
   (`EU`/`AF` → EU-West pool, everything else → US-East pool).

## Response headers

| Header | Example |
|---|---|
| `X-Served-By` | `EU server` / `US server` |
| `X-LB-Pool` | `eu-west-pool` / `us-east-pool` |
| `X-LB-Steering` | `geo (visitor location)` / `header/param override` |

## Formats

- HTML page (default) with a "Served by" banner, the decision signals, and the
  live `X-Served-By` header.
- `?format=json` (or `Accept: application/json`) → JSON with the decision and
  `request.cf` details (CORS-enabled).

## Why a Worker (and how it maps to a real LB)

A real setup uses a Cloudflare **Load Balancer** with two **pools** (EU-West,
US-East), **Geo** steering, and a **custom rule** for the `x-region` header. Two
real origins in different regions would each stamp their own `X-Served-By`
header. This Worker simulates that decision at the edge using `request.cf` so
the behaviour is demonstrable on a single origin. See the
[Load Balancer guide](https://www.pimenta.fun/load-balancer-guide/).

## Deploy

```bash
cd workers/geo-origin
wrangler deploy
```

Route: `www.pimenta.fun/load-balancer/geo-origin*`.

## Test

```bash
curl -sI https://www.pimenta.fun/load-balancer/geo-origin/                 # X-Served-By by your location
curl -sI https://www.pimenta.fun/load-balancer/geo-origin/ -H "x-region: eu"  # forced EU
curl -sI "https://www.pimenta.fun/load-balancer/geo-origin/?region=us"     # forced US
curl -s  "https://www.pimenta.fun/load-balancer/geo-origin/?format=json"   # JSON decision
```
