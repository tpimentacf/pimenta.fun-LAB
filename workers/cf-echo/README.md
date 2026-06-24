# cf-echo Worker

A tiny, dependency-free Cloudflare Worker that echoes the inbound request back
as JSON (or HTML), including:

- **Every request header** the edge sees — including the ones Cloudflare injects
  and that are **invisible to client-side JavaScript**: `CF-Connecting-IP`,
  `CF-Ray`, `CF-IPCountry`, `X-Forwarded-For`, `CF-Visitor`, etc.
- **The full `request.cf` object** — `country`, `city`, `colo`, `asn`,
  `asOrganization`, `httpProtocol`, `tlsVersion`, `tlsCipher`, `clientTcpRtt`,
  geolocation, and (where available) `botManagement`.

It powers the **CF Echo** lab page at <https://www.pimenta.fun/cf-echo/> and
complements the **Edge Inspector** page, which can only read the client-visible
`/cdn-cgi/trace` and response headers.

## Files

| File           | Purpose                                  |
| -------------- | ---------------------------------------- |
| `worker.js`    | The Worker (module syntax).              |
| `wrangler.toml`| Deploy config + route.                   |

## Deploy

```bash
cd workers/cf-echo
npx wrangler login          # once
npx wrangler deploy
```

By default `wrangler.toml` binds the route:

```
www.pimenta.fun/cf-echo/echo*  ->  cf-echo
```

so the lab page calls it same-origin at `/cf-echo/echo`. `workers_dev = true`
also gives you a `https://cf-echo.<subdomain>.workers.dev` preview URL — paste
that into the lab page's endpoint box if you'd rather not bind a route.

## API

```
GET  /cf-echo/echo                 -> application/json
GET  /cf-echo/echo?format=html     -> minimal HTML view
POST /cf-echo/echo                 -> JSON (echoes POST request headers too)
OPTIONS                            -> 204 (CORS preflight)
```

Response shape:

```json
{
  "method": "GET",
  "url": "https://www.pimenta.fun/cf-echo/echo",
  "path": "/cf-echo/echo",
  "http": "HTTP/3",
  "serverTime": "2026-06-24T15:30:00.000Z",
  "headers": { "cf-connecting-ip": "…", "cf-ray": "…", "cf-ipcountry": "PT", "…": "…" },
  "cf": { "country": "PT", "colo": "LIS", "asn": 1234, "tlsVersion": "TLSv1.3", "…": "…" }
}
```

CORS is open (`*`) so the page works whether the Worker is same-origin or on a
`workers.dev` host.
