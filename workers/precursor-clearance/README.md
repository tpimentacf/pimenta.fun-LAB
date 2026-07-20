# precursor-clearance

A Cloudflare Worker that fronts the **precursor-lab** page and reports whether
the visitor's `cf_clearance` cookie is present **on the actual page request**.

## Why a Worker?

`cf_clearance` is an **`HttpOnly`** cookie: the browser sends it on every
request, but page JavaScript can never read it via `document.cookie`. The only
way to know if it is present is to read the request `Cookie` header
**server-side** — which is exactly what a Worker on the route can do, without
the page making any separate/external request.

## How it works

It serves two routes:

1. `www.pimenta.fun/precursor-lab*` — the HTML page. The Worker `fetch()`es the
   origin page, adds `X-CF-Clearance: present|absent` / `X-CF-Clearance-Len`
   headers, and uses `HTMLRewriter` to inject
   `<script>window.__cfClearance = {present, len}</script>` into `<head>` so the
   state is available on the very first page load.
2. `www.pimenta.fun/precursor-clearance` — a dedicated JSON check endpoint
   answered **directly** by the Worker (no origin fetch). It returns
   `{ present, len }` plus the same headers. Because it is a separate path and
   is answered by the Worker, the page can `fetch()` it via XHR without being
   blocked by the page's interactive challenge.

The precursor-lab page reads `window.__cfClearance` on load and calls
`/precursor-clearance` from its "Check clearance now" button; it falls back to
`document.cookie` (which normally can't see the cookie) when the Worker is not
deployed.

## Route / order (important)

Cloudflare evaluates WAF/challenge rules **before** Workers. If a challenge
protects the page, an XHR/`fetch()` to the **page path** returns `403`
(`cf-mitigated: challenge`) — a challenge can't be solved by a background fetch.
That is why the check endpoint lives on a **separate path**.

Scope any challenge to the page path only, e.g.:

```
(starts_with(http.request.uri.path, "/precursor-lab"))
```

Make sure it does **not** match `/precursor-clearance`, otherwise the check
endpoint would be challenged too and the button would still see a `403`.

## Deploy

```bash
cd workers/precursor-clearance
npx wrangler deploy
```

Verify the check endpoint (not challenged; a request without a passed challenge
has no cf_clearance):

```bash
curl -s https://www.pimenta.fun/precursor-clearance
# {"present":false,"len":0}

curl -s https://www.pimenta.fun/precursor-clearance -H 'Cookie: cf_clearance=abc123'
# {"present":true,"len":6}
```

## Notes / limitations

- `cf_clearance` is only issued **after** a real browser passes the
  interstitial / managed challenge; automated requests won't have it.
- The Worker never logs or exposes the cookie value — only presence and length.
- Keep the route pattern (`www.pimenta.fun/precursor-lab*`) in sync with where
  the page is served.

Docs: https://developers.cloudflare.com/workers/runtime-apis/html-rewriter/
