# turnstile-injector

A Cloudflare Worker that sits in front of an origin and:

1. **Injects** the Turnstile widget into HTML on the fly with `HTMLRewriter`
   (the API script into `<head>`, a `<div class="cf-turnstile">` into every
   `<form>` / `INJECT_SELECTOR`) — **no origin code changes**.
2. **Verifies** the Turnstile token server-side at `/siteverify` before any
   gated request (`VERIFY_METHODS`, default `POST`) is allowed to reach origin.
3. Layers **multi-signal anti-bypass** checks so a farmed/replayed token alone
   isn't enough.

Guide / write-up: <https://www.pimenta.fun/turnstile/injection-worker/>

## How it works

- **GET / non-mutating** → proxy to origin, and if the response is `text/html`,
  stream it through `HTMLRewriter` to inject the script + widget. Non-HTML
  passes through untouched. Optional Turnstile-scoped CSP via `ADD_CSP`.
- **POST / mutating** → pre-flight edge signals (blocked ASNs, bot-score floor)
  → extract `cf-turnstile-response` (urlencoded / multipart / JSON) → replay
  check → `/siteverify` with `secret` + `remoteip` + stable
  `idempotency_key = sha256(token)` → validate the **full** outcome
  (`hostname`, `action`, `cdata`, `challenge_ts` freshness, ephemeral-id cap) →
  forward the original request only if everything passes; otherwise `403`.

## Configure

Public vars live in `wrangler.toml` `[vars]`. The **secret** does not:

```bash
# production
npx wrangler secret put TURNSTILE_SECRET

# local dev
cp .dev.vars.example .dev.vars   # then edit TURNSTILE_SECRET
```

See `wrangler.toml` for every optional hardening var (`EXPECTED_HOSTNAMES`,
`EXPECTED_ACTION`, `MAX_TOKEN_AGE_SECONDS`, `BLOCKED_ASNS`, `MIN_BOT_SCORE`,
`EPHEMERAL_ID_MAX_USES`, `ADD_CSP`, `FAIL_OPEN`, `TOKEN_REPLAY` KV).

## Deploy

```bash
cd workers/turnstile-injector
npx wrangler deploy
```

Then uncomment and edit the `[[routes]]` block so the Worker fronts your zone.
This is a **reference sample** — test on a staging host before routing a whole
production zone through it.

## Test locally

```bash
# Terminal 1 — mock origin
cd workers/turnstile-injector/test && python3 -m http.server 8080

# Terminal 2 — Worker (set ORIGIN_URL=http://localhost:8080)
cd workers/turnstile-injector && npx wrangler dev --port 8787

# Terminal 3 — pass/fail + hardening paths
cd workers/turnstile-injector/test && ./curl-tests.sh
```

Turnstile **test keys**: sitekey `1x00000000000000000000AA` always passes;
secret `1x0000000000000000000000000000000AA` always passes,
`2x0000000000000000000000000000000AA` always fails.

## Notes

- The widget is only UI — the **server-side `/siteverify` check** is what
  protects you. Never skip it.
- Only `text/html` responses are rewritten; assets/APIs are untouched.
- Make the route cover **every** form-handling path, or those submissions
  bypass verification.
- Never commit `.dev.vars` (it holds the real secret) — it is git-ignored.

Docs: <https://developers.cloudflare.com/turnstile/> ·
<https://developers.cloudflare.com/workers/runtime-apis/html-rewriter/>
