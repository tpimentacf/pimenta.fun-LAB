# turnstile-login

A self-contained Cloudflare Worker that serves a **Turnstile-protected login
demo** and, on a successful sign-in, dumps every signal the edge saw for the
request.

It is the companion demo for the
[Injection & Verification Worker](https://www.pimenta.fun/turnstile/injection-worker/)
and shows **both halves of that technique on one page**:

- **Injection** — the login HTML it serves contains **no Turnstile markup**. The
  Worker streams it through `HTMLRewriter` and injects the `api.js` script into
  `<head>` and the `cf-turnstile` widget into the `<form>` — exactly like the
  injector Worker fronting an origin, except here the "origin" is this Worker.
  View source and you won't find the widget; it's added at the edge.
- **Verification** — on submit it runs the full server-side pipeline before
  accepting the login.

- `GET  /turnstile/secure-login` → builds a widget-less login page (email +
  password), then HTMLRewriter-injects the script + widget, and posts back to
  the same path.
- `POST /turnstile/secure-login` → runs the **full verification pipeline** from
  the [Injection & Verification Worker](https://www.pimenta.fun/turnstile/injection-worker/)
  guide, then checks the demo credentials. On success it renders a page listing:
  - every Turnstile `/siteverify` field (+ the raw JSON),
  - all Bot Management data (`request.cf.botManagement`),
  - all other `request.cf.*` signals (geo / network / TLS),
  - every request header.

The password is **never** echoed back.

Guide / write-up: <https://www.pimenta.fun/turnstile/injection-worker/>

## Verification pipeline

Pre-flight edge signals (blocked ASNs, bot-score floor) → extract
`cf-turnstile-response` (urlencoded / multipart / JSON) → replay check → 
`/siteverify` with `secret` + `remoteip` + stable `idempotency_key = sha256(token)`
→ validate the **full** outcome (`hostname`, `action`, `cdata`, `challenge_ts`
freshness, ephemeral-id cap) → only then check credentials → render the data
page. Any failure returns the login page with an explanatory banner (`4xx`).

## Configure

Public vars live in `wrangler.toml` `[vars]`. The **secret** does not:

```bash
# production
npx wrangler secret put TURNSTILE_SECRET

# local dev
cp .dev.vars.example .dev.vars   # then edit TURNSTILE_SECRET / DEMO_PASSWORD
```

Zero-config: with nothing set, the Worker falls back to the Cloudflare **test
keys** (always pass) and the default demo credentials, so it runs immediately.

Key vars (see `wrangler.toml` for the full list): `TURNSTILE_SITEKEY`,
`TURNSTILE_SECRET` (secret), `INJECT_SELECTOR` (widget target, default `form`),
`DEMO_USERNAME`, `DEMO_PASSWORD`, plus the optional
hardening knobs `EXPECTED_HOSTNAMES`, `EXPECTED_ACTION`, `EXPECTED_CDATA`,
`MAX_TOKEN_AGE_SECONDS`, `BLOCKED_ASNS`, `MIN_BOT_SCORE`,
`EPHEMERAL_ID_MAX_USES`, `EPHEMERAL_ID_WINDOW`, `FAIL_OPEN`, and the
`TOKEN_REPLAY` KV binding.

## Deploy

```bash
cd workers/turnstile-login
npx wrangler deploy
```

Then uncomment and edit the `[[routes]]` block so the Worker answers
`www.pimenta.fun/turnstile/secure-login*` on the `pimenta.fun` zone.

## Test locally

```bash
cd workers/turnstile-login && npx wrangler dev --port 8787
# open http://localhost:8787/turnstile/secure-login and solve the widget
```

Turnstile **test keys**: sitekey `1x00000000000000000000AA` always passes;
secret `1x0000000000000000000000000000000AA` always passes,
`2x0000000000000000000000000000000AA` always fails.

## Notes

- **Lab only.** Hardcoded demo credentials are a teaching convenience — never
  ship hardcoded creds; use an identity provider and hashed secrets.
- Bot Management data is real on the `pimenta.fun` zone; on zones without the
  entitlement `request.cf.botManagement` is absent and that section says so.
- The widget is injected at the edge and is only UI — the **server-side
  `/siteverify` check** is what actually gates the login. Never skip it.
- Never commit `.dev.vars` (holds the real secret) — it is git-ignored.

Docs: <https://developers.cloudflare.com/turnstile/> ·
<https://developers.cloudflare.com/workers/runtime-apis/request/#incomingrequestcfproperties>
