# login-inspector Worker

Serves a lab-themed login form and inspects both the submitted POST payload
(username/password) and the Cloudflare edge data for the request.

Endpoints (all under `/login-inspector`):

- `GET /login-inspector` — themed login form.
- `POST /login-inspector/login` — parses `username` + `password` from a
  `application/x-www-form-urlencoded` body. If they do not match the expected
  admin login it shows **“Login is not valid”**. If they match it shows
  **“Login Success”** and renders:
  - the posted fields (password masked);
  - Cloudflare data: source IP, edge POP (`colo`), Ray ID, ASN, city/region/
    country, coordinates, TLS version/cipher, HTTP version, WARP detection,
    all request headers, and the full `request.cf` object.

Expected credentials resolve in this order:

1. Worker **secrets** `LOGIN_USER` / `LOGIN_PASSWORD` (recommended);
2. Built-in fallbacks `tpimentacf@gmail.com` / `1z1muef2`.

The Worker is lab-only; use secrets if you reuse any real login material.

