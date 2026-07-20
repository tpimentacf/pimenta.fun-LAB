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

1. Read the incoming request `Cookie` header and match `cf_clearance=...`.
2. `fetch(request)` the origin page as normal.
3. Add response headers `X-CF-Clearance: present|absent` and
   `X-CF-Clearance-Len: <n>` so a re-fetch of the actual page URL can read the
   per-request state.
4. For HTML responses, use `HTMLRewriter` to inject
   `<script>window.__cfClearance = {present, len}</script>` into `<head>` so the
   state is available on the very first page load.

The precursor-lab page reads `window.__cfClearance` on load and the
`X-CF-Clearance` header on each "Re-fetch this page" request; it falls back to
`document.cookie` (which normally can't see the cookie) when the Worker is not
deployed.

## Deploy

```bash
cd workers/precursor-clearance
npx wrangler deploy
```

Verify (a request without a passed challenge has no cf_clearance):

```bash
curl -sI https://www.pimenta.fun/precursor-lab/ | grep -i x-cf-clearance
# X-CF-Clearance: absent
# X-CF-Clearance-Len: 0

curl -sI https://www.pimenta.fun/precursor-lab/ -H 'Cookie: cf_clearance=abc123' | grep -i x-cf-clearance
# X-CF-Clearance: present
# X-CF-Clearance-Len: 6
```

## Notes / limitations

- `cf_clearance` is only issued **after** a real browser passes the
  interstitial / managed challenge; automated requests won't have it.
- The Worker never logs or exposes the cookie value — only presence and length.
- Keep the route pattern (`www.pimenta.fun/precursor-lab*`) in sync with where
  the page is served.

Docs: https://developers.cloudflare.com/workers/runtime-apis/html-rewriter/
