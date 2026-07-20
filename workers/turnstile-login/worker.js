/**
 * Cloudflare Worker: Turnstile-protected login demo.
 *
 * GET  /turnstile/secure-login   -> renders a login page with the Turnstile
 *                                   widget injected into the form.
 * POST /turnstile/secure-login   -> runs the FULL verification pipeline from the
 *                                   Injection & Verification Worker guide, then
 *                                   checks demo credentials. On success it serves
 *                                   a page dumping every Turnstile siteverify
 *                                   field, all Bot Management data, and all
 *                                   request signals (request.cf + headers).
 *
 * Verification pipeline (same as the guide):
 *   1. Pre-flight edge signals (blocked ASNs, Bot Management score floor).
 *   2. Extract cf-turnstile-response (urlencoded / multipart / JSON).
 *   3. Replay check (optional KV, keyed by sha256(token)).
 *   4. siteverify with secret + remoteip + STABLE idempotency_key = sha256(token).
 *   5. Validate the FULL outcome: hostname / action / cdata / challenge_ts
 *      freshness / ephemeral_id abuse counter.
 *   6. Only then check credentials and render the data page.
 *
 * Config (vars):
 *   TURNSTILE_SITEKEY      site key (public)   default: test key 1x00..AA (pass)
 *   TURNSTILE_SECRET       secret [wrangler secret put] default: test secret (pass)
 *   DEMO_USERNAME          expected username   default: tpimentacf@gmail.com
 *   DEMO_PASSWORD          expected password   default: 1z1muef2   (DEMO ONLY)
 *   EXPECTED_HOSTNAMES, EXPECTED_ACTION, EXPECTED_CDATA, MAX_TOKEN_AGE_SECONDS,
 *   BLOCKED_ASNS, MIN_BOT_SCORE, EPHEMERAL_ID_MAX_USES, EPHEMERAL_ID_WINDOW,
 *   FAIL_OPEN  — same semantics as the turnstile-injector Worker.
 *
 * Bindings (optional):
 *   TOKEN_REPLAY           KV namespace for single-use + ephemeral_id counters.
 *
 * NOTE: hardcoding credentials is for a lab demo only. Never do this in a real
 * app — use a proper identity provider and hashed secrets.
 */

const SITEVERIFY_URL =
  "https://challenges.cloudflare.com/turnstile/v0/siteverify";

// Cloudflare Turnstile test keys (always pass) so the demo works out of the box.
const TEST_SITEKEY = "1x00000000000000000000AA";
const TEST_SECRET = "1x0000000000000000000000000000000AA";

export default {
  async fetch(request, env, ctx) {
    const sitekey = env.TURNSTILE_SITEKEY || TEST_SITEKEY;

    if (request.method.toUpperCase() === "POST") {
      return handleLogin(request, env, ctx, sitekey);
    }
    return htmlResponse(loginPage(sitekey, null), 200);
  },
};

async function handleLogin(request, env, ctx, sitekey) {
  const cf = request.cf || {};
  const clientIp = request.headers.get("CF-Connecting-IP") || "";

  // ---- 1. Pre-flight edge signals -----------------------------------------
  const blockedAsns = parseList(env.BLOCKED_ASNS);
  if (blockedAsns.length && cf.asn != null && blockedAsns.includes(String(cf.asn))) {
    return htmlResponse(loginPage(sitekey, "Blocked network (ASN)."), 403);
  }
  const minBotScore = toInt(env.MIN_BOT_SCORE);
  const botScore = cf.botManagement && cf.botManagement.score;
  if (minBotScore && typeof botScore === "number" && botScore < minBotScore) {
    return htmlResponse(loginPage(sitekey, "Blocked (bot score too low)."), 403);
  }

  // ---- 2. Parse the submission --------------------------------------------
  const { token, username, password } = await parseSubmission(request);
  if (!token) {
    return htmlResponse(loginPage(sitekey, "Missing Turnstile token — solve the widget."), 403);
  }

  const tokenHash = await sha256Hex(token);

  // ---- 3. Replay check -----------------------------------------------------
  if (env.TOKEN_REPLAY) {
    const seen = await env.TOKEN_REPLAY.get(`t:${tokenHash}`);
    if (seen) {
      return htmlResponse(loginPage(sitekey, "Token already used (replay detected)."), 403);
    }
  }

  // ---- 4. siteverify (stable idempotency key = real single-use) -----------
  const secret = env.TURNSTILE_SECRET || TEST_SECRET;
  const form = new FormData();
  form.append("secret", secret);
  form.append("response", token);
  if (clientIp) form.append("remoteip", clientIp);
  form.append("idempotency_key", tokenHash);

  let outcome;
  try {
    const verifyResp = await fetch(SITEVERIFY_URL, { method: "POST", body: form });
    outcome = await verifyResp.json();
  } catch (err) {
    if (String(env.FAIL_OPEN).toLowerCase() === "true") {
      outcome = { success: true, "failed-open": true };
    } else {
      return htmlResponse(loginPage(sitekey, "Turnstile verification request failed."), 502);
    }
  }

  if (!outcome.success) {
    const codes = (outcome["error-codes"] || []).join(", ") || "verification failed";
    return htmlResponse(loginPage(sitekey, "Turnstile verification failed: " + codes), 403);
  }

  // ---- 5. Validate the FULL outcome ---------------------------------------
  const reasons = [];
  const expectedHosts = parseList(env.EXPECTED_HOSTNAMES);
  if (expectedHosts.length && !expectedHosts.includes(outcome.hostname)) reasons.push("hostname-mismatch");
  if (env.EXPECTED_ACTION && outcome.action !== env.EXPECTED_ACTION) reasons.push("action-mismatch");
  if (env.EXPECTED_CDATA && outcome.cdata !== env.EXPECTED_CDATA) reasons.push("cdata-mismatch");

  const maxAge = toInt(env.MAX_TOKEN_AGE_SECONDS) || 300;
  if (outcome.challenge_ts) {
    const ageSec = (Date.now() - Date.parse(outcome.challenge_ts)) / 1000;
    if (!Number.isFinite(ageSec) || ageSec > maxAge || ageSec < -60) reasons.push("token-stale");
  }
  if (reasons.length) {
    return htmlResponse(loginPage(sitekey, "Turnstile outcome rejected: " + reasons.join(", ")), 403);
  }

  // Ephemeral-id abuse counter (optional).
  const ephemeralId = outcome.metadata && outcome.metadata.ephemeral_id;
  const epMax = toInt(env.EPHEMERAL_ID_MAX_USES);
  if (env.TOKEN_REPLAY && ephemeralId && epMax) {
    const windowSec = toInt(env.EPHEMERAL_ID_WINDOW) || 3600;
    const key = `e:${ephemeralId}`;
    const count = (toInt(await env.TOKEN_REPLAY.get(key)) || 0) + 1;
    ctx.waitUntil(env.TOKEN_REPLAY.put(key, String(count), { expirationTtl: windowSec }));
    if (count > epMax) {
      return htmlResponse(loginPage(sitekey, "Device rate limit exceeded."), 429);
    }
  }

  // Mark token spent so it can never be replayed.
  if (env.TOKEN_REPLAY) {
    ctx.waitUntil(env.TOKEN_REPLAY.put(`t:${tokenHash}`, "1", { expirationTtl: maxAge + 60 }));
  }

  // ---- 6. Credentials ------------------------------------------------------
  const expectedUser = env.DEMO_USERNAME || "tpimentacf@gmail.com";
  const expectedPass = env.DEMO_PASSWORD || "1z1muef2";
  if (username !== expectedUser || password !== expectedPass) {
    return htmlResponse(
      loginPage(sitekey, "Turnstile passed \u2713 \u2014 but the email or password is incorrect."),
      401
    );
  }

  // ---- Success: dump everything -------------------------------------------
  return htmlResponse(resultPage(username, outcome, request), 200);
}

/** Read token + credentials from urlencoded / multipart / JSON bodies. */
async function parseSubmission(request) {
  const ct = (request.headers.get("content-type") || "").toLowerCase();
  try {
    if (ct.includes("application/json")) {
      const d = await request.json();
      return {
        token: d["cf-turnstile-response"] || d.token || "",
        username: d.username || d.email || "",
        password: d.password || "",
      };
    }
    const f = await request.formData();
    return {
      token: f.get("cf-turnstile-response") || "",
      username: f.get("username") || f.get("email") || "",
      password: f.get("password") || "",
    };
  } catch (_) {
    return { token: "", username: "", password: "" };
  }
}

/* ------------------------------------------------------------------ pages -- */

function shell(title, bodyHtml) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>${escapeHtml(title)}</title>
<link rel="stylesheet" href="/assets/lab.css" />
<script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>
<style>
  .kvt { width: 100%; border-collapse: collapse; font-size: 0.82rem; margin: 6px 0 0; }
  .kvt th, .kvt td { text-align: left; padding: 7px 10px; border-bottom: 1px solid var(--border); vertical-align: top; }
  .kvt thead th { color: var(--accent); font-size: 0.68rem; text-transform: uppercase; letter-spacing: 0.5px; }
  .kvt td:first-child { color: #9cc0ff; font-family: ui-monospace, Menlo, monospace; white-space: nowrap; }
  .kvt td.v { font-family: ui-monospace, Menlo, monospace; color: #d7e2f7; word-break: break-all; }
  .kvt tbody tr:last-child td { border-bottom: none; }
  .panel h2 { margin-top: 0; font-size: 1.05rem; }
  .panel .sub { color: var(--muted); font-size: 0.85rem; margin: -2px 0 12px; }
  pre.raw { background: var(--panel2); border: 1px solid var(--border); border-radius: 12px; padding: 12px 14px;
    overflow-x: auto; font-size: 0.78rem; color: #d7e2f7; white-space: pre-wrap; word-break: break-word; }
  form.login label { display:block; margin: 12px 0 5px; color: var(--muted); font-size: 0.82rem; }
  form.login input { width: 100%; }
  .ok-badge { display:inline-block; background: rgba(54,211,153,0.15); color: var(--green);
    border: 1px solid rgba(54,211,153,0.5); border-radius: 999px; padding: 3px 12px; font-size: 0.78rem; }
</style>
</head>
<body>
  <header class="lab">
    <div class="brand">pimenta<span>.fun</span> lab</div>
    <nav>
      <a href="https://www.pimenta.fun">Home</a>
      <a href="https://www.pimenta.fun/#tests">Tests</a>
    </nav>
  </header>
  <main class="lab">
${bodyHtml}
    <section class="disclaimer"><div class="box">
      <b>Disclaimer:</b> All information provided on this page was developed by Pimenta.fun LAB.
      Please consult the official documentation for the most accurate and up-to-date information.
      We are not responsible for any issues, damages, or data loss that may occur from using this information.
      <span class="risk">USE AT YOUR OWN RISK.</span>
    </div></section>
  </main>
  <footer class="lab">
    <span>&copy; 2026 pimenta.fun &mdash; Security Lab &middot; built by TPimenta LAB</span>
    <a href="https://www.pimenta.fun/turnstile/injection-worker/">About this Worker</a>
  </footer>
</body>
</html>`;
}

function loginPage(sitekey, message) {
  const banner = message
    ? `<div class="warn">${escapeHtml(message)}</div>`
    : `<div class="note">Sign in to see every Turnstile field, all Bot Management data, and the full set of
        request signals the edge sees for your session. Verification runs server-side exactly as described in the
        <a style="color:var(--accent)" href="https://www.pimenta.fun/turnstile/injection-worker/">Injection &amp;
        Verification Worker</a> guide.</div>`;
  return shell(
    "Turnstile Secure Login — Pimenta Lab",
    `    <div class="crumb"><a href="https://www.pimenta.fun/#tests">Tests</a> / Turnstile / Secure Login</div>
    <span class="tag">Turnstile</span>
    <h1>Turnstile <span class="grad">Secure Login</span></h1>
    <p class="lead">A login gated by a server-side Turnstile check plus the full anti-bypass pipeline.</p>
    ${banner}
    <form class="panel login" method="POST" action="">
      <label for="username">Email</label>
      <input id="username" name="username" type="email" autocomplete="username" placeholder="you@example.com" required />
      <label for="password">Password</label>
      <input id="password" name="password" type="password" autocomplete="current-password" placeholder="••••••••" required />
      <div class="cf-turnstile" data-sitekey="${escapeHtml(sitekey)}" data-theme="dark" style="margin:16px 0;"></div>
      <button class="btn" type="submit">Sign in</button>
    </form>
    <p class="muted-small" style="color:var(--muted);font-size:0.8rem;">The Turnstile widget adds a hidden
      <code class="inline">cf-turnstile-response</code> token to this form; the Worker verifies it at
      <code class="inline">/siteverify</code> before checking credentials. Test sitekey shown always passes.</p>`
  );
}

function resultPage(username, outcome, request) {
  const cf = request.cf || {};
  const bm = cf.botManagement || {};

  // request.cf without the botManagement object (shown separately).
  const cfSignals = {};
  for (const k of Object.keys(cf)) {
    if (k === "botManagement") continue;
    cfSignals[k] = cf[k];
  }

  const headers = {};
  for (const [k, v] of request.headers.entries()) headers[k] = v;

  return shell(
    "Signed in — Turnstile & request signals — Pimenta Lab",
    `    <div class="crumb"><a href="https://www.pimenta.fun/#tests">Tests</a> / Turnstile / Secure Login / Result</div>
    <span class="tag">Turnstile</span>
    <h1>Signed in <span class="grad">successfully</span></h1>
    <p class="lead"><span class="ok-badge">Turnstile verified &amp; credentials accepted</span></p>
    <div class="note">Authenticated as <b>${escapeHtml(username)}</b> at ${escapeHtml(new Date().toISOString())}.
      Below is every value the Worker used or observed for this request.</div>

    <section class="panel">
      <h2>Turnstile siteverify outcome</h2>
      <p class="sub">The complete JSON returned by <code class="inline">/siteverify</code> for your token.</p>
      ${kvTable(flatten(outcome))}
      <p class="cap" style="margin-top:14px;color:var(--muted);font-size:0.72rem;text-transform:uppercase;letter-spacing:0.5px;">raw</p>
      <pre class="raw">${escapeHtml(JSON.stringify(outcome, null, 2))}</pre>
    </section>

    <section class="panel">
      <h2>Bot Management</h2>
      <p class="sub"><code class="inline">request.cf.botManagement</code> &mdash; requires a Bot Management entitlement on the zone.</p>
      ${Object.keys(bm).length ? kvTable(flatten(bm)) : '<div class="warn">No botManagement data on request.cf (Bot Management not enabled on this zone).</div>'}
    </section>

    <section class="panel">
      <h2>Request signals (request.cf)</h2>
      <p class="sub">Geo, network, and TLS metadata the edge attached to this request.</p>
      ${kvTable(flatten(cfSignals))}
    </section>

    <section class="panel">
      <h2>Request headers</h2>
      <p class="sub">Every header the Worker received (including CF-injected ones).</p>
      ${kvTable(headers)}
    </section>

    <p style="margin-top:18px;"><a class="btn ghost" href="">&larr; Back to the login</a></p>`
  );
}

/* ------------------------------------------------------------- helpers ----- */

// Flatten one level of nested objects/arrays into dotted keys for the table.
function flatten(obj, prefix) {
  const out = {};
  for (const k of Object.keys(obj || {})) {
    const key = prefix ? `${prefix}.${k}` : k;
    const val = obj[k];
    if (val && typeof val === "object" && !Array.isArray(val)) {
      Object.assign(out, flatten(val, key));
    } else if (Array.isArray(val)) {
      out[key] = val.length ? JSON.stringify(val) : "[]";
    } else {
      out[key] = val;
    }
  }
  return out;
}

function kvTable(obj) {
  const keys = Object.keys(obj);
  if (!keys.length) return '<div class="muted-small" style="color:var(--muted)">(empty)</div>';
  const rows = keys
    .map(
      (k) =>
        `<tr><td>${escapeHtml(k)}</td><td class="v">${escapeHtml(
          obj[k] === null || obj[k] === undefined ? "\u2014" : String(obj[k])
        )}</td></tr>`
    )
    .join("");
  return `<table class="kvt"><thead><tr><th>Field</th><th>Value</th></tr></thead><tbody>${rows}</tbody></table>`;
}

function htmlResponse(html, status) {
  return new Response(html, {
    status: status || 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

async function sha256Hex(input) {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function parseList(value) {
  return (value || "").split(",").map((v) => v.trim()).filter(Boolean);
}

function toInt(value) {
  const n = parseInt(value, 10);
  return Number.isFinite(n) ? n : 0;
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
