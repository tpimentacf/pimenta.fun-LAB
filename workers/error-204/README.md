# error-204

A tiny Cloudflare Worker that answers every request on
`https://www.pimenta.fun/error/error204/` with **`204 No Content`** — a
successful response that intentionally carries no body.

## Why a Worker?

A static HTML file is always served with `200 OK` plus its body. There is no way
for the file itself to change the HTTP status to `204`, so a Worker on the route
returns the bodyless response instead.

## What a 204 is for

- Maintenance / feature toggles that should succeed silently.
- Health and uptime probes (a cheap "I'm alive, nothing to say").
- Silencing analytics/telemetry beacons.
- Acknowledging a request where the client does not expect content.

Per [RFC 9110 §15.3.5](https://www.rfc-editor.org/rfc/rfc9110#status.204) a `204`
response MUST NOT include a message body, so the Worker passes `null` as the body.

## Deploy

```bash
cd workers/error-204
wrangler deploy
```

The route in `wrangler.toml` is `www.pimenta.fun/error/error204*`.

## Test

```bash
# Expect: HTTP/2 204, no body
curl -sI https://www.pimenta.fun/error/error204/

# Full exchange (note the empty body and X-Pimenta-Lab: error-204 header)
curl -sv https://www.pimenta.fun/error/error204/ -o /dev/null
```
