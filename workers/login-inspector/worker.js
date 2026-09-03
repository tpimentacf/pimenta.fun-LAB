/**
 * login-inspector — Pimenta Lab
 *
 * A tiny "inspecting login" Worker. It serves a themed login form, accepts
 * the posted username/password, compares them against credentials stored as
 * Worker *secrets*, and replies with a full result page:
 *
 *   GET  /login-inspector        -> themed login form
 *   POST /login-inspector/login  -> parses the username/password field, shows
 *                                   what was posted, and renders either:
 *         success: "Login Success" + the Cloudflare data (source IP, edge POP
 *                  ("colo"), ASN, country/city, TLS/HTTP, Ray ID, headers, and
 *                  the complete request.cf object)
 *         failure: "Login is not valid" (+ what was posted, masked password)
 *
 * Credentials are provided as secrets so they are never committed to Git:
 *   LOGIN_USER     (e.g. tpimentacf@gmail.com)
 *   LOGIN_PASSWORD (e.g. 1z1muef2)
 *
 * Route (suggested): www.pimenta.fun/login-inspector*
 *
 * Lab purposes only — it is meant to demo request inspection, not to be a
 * production authentication system.
 */

// Credentials can be provided as encrypted Worker secrets (recommended),
// falling back to a built-in default for a zero-config lab.
const FALLBACK_USER = "tpimentacf@gmail.com";
const FALLBACK_PASSWORD = "1z1muef2";

function esc(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function mask(s) {
  const n = (s || "").length;
  return n ? "•".repeat(Math.min(n, 12)) : "";
}

function summarizeCf(cf) {
  if (!cf) return {};
  try {
    return JSON.parse(JSON.stringify(cf));
  } catch (_) {
    return { note: "request.cf present but not serializable" };
  }
}

function headersToObject(headers) {
  const out = {};
  const iter = typeof headers.entries === "function" ? headers.entries() : [];
  for (const [k, v] of iter) {
    const key = k.toLowerCase();
    out[key === "cookie" ? "cookie (redacted)" : key] = key === "cookie" ? "[redacted]" : v;
  }
  return out;
}

function page({ title, lead = "", body }) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${esc(title)}</title>
  <link rel="stylesheet" href="/assets/lab.css">
  <style>
    .card { max-width: 480px; margin: 0 auto; }
    .banner { text-align: center; margin: 18px 0 26px; }
    .banner .tag { margin-bottom: 18px; }
    .banner h1 { margin-bottom: 6px; font-size: clamp(2rem, 6vw, 3rem); }
    .banner p.lead { margin-bottom: 0; }
    .panel p:last-child { margin-bottom: 0; }
    .kv { margin: 10px 0 0; display: grid; grid-template-columns: 140px 1fr; gap: 8px 14px; font-size: 0.9rem; }
    .kv b { color: var(--muted); font-weight: 500; }
    .kv span { color: var(--text); word-break: break-word; }
    pre.json { margin-top: 14px; max-height: 420px; overflow: auto; }
    .actions { display: flex; gap: 12px; flex-wrap: wrap; margin-top: 18px; }
  </style>
</head>
<body>
  <header class="lab">
    <div class="brand">pimenta<span>.fun</span></div>
    <nav><a href="https://www.pimenta.fun/login-inspector">Login Inspector</a></nav>
  </header>
  <main class="lab">
    <div class="crumb"><a href="https://www.pimenta.fun">Home</a> / login-inspector</div>
    ${body}
  </main>
  <div class="disclaimer"><div class="box">
    <span class="risk">Lab demo.</span> Inspect what a login POST sends and which
    Cloudflare edge data is available. Not a production authentication flow.
  </div></div>
</body>
</html>`;
}

function kvRow(k, v) {
  return `<b>${esc(k)}</b><span>${v}</span>`;
}

function dataSections(request) {
  const cf = summarizeCf(request.cf);
  const ip = request.headers.get("cf-connecting-ip") || "unavailable";
  const ray = request.headers.get("cf-ray") || "";
  const geoParts = [cf.city, cf.region, cf.country].filter(Boolean).join(", ");

  const lines = [
    kvRow("Source IP (CF-Connecting-IP)", esc(ip)),
    kvRow("Edge POP (colo)", esc(cf.colo || "")),
    kvRow("Ray ID", esc(ray)),
    kvRow("ASN", cf.asn ? esc(`AS${cf.asn}`) : ""),
    kvRow("Location", esc(geoParts)),
    kvRow("Coordinates", cf.latitude && cf.longitude ? esc(`${cf.latitude}, ${cf.longitude}`) : ""),
    kvRow("TLS version / cipher", esc([cf.tlsVersion, cf.tlsCipher].filter(Boolean).join(" / "))),
    kvRow("HTTP version", esc(cf.httpProtocol || "")),
    kvRow("Client trust score (bot)", cf.clientTrustScore !== undefined ? esc(String(cf.clientTrustScore)) : ""),
    kvRow("WARP detected", cf.warp ? `<span style="color:var(--green)">yes</span>` : "no"),
  ];

  return `${lines.join("")}
  <h2>HTTP request headers</h2>
  <pre class="json">${esc(JSON.stringify(headersToObject(request.headers), null, 2))}</pre>
  <h2>request.cf</h2>
  <pre class="json">${esc(JSON.stringify(cf, null, 2))}</pre>`;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "GET") {
      return new Response(
        page({
          title: "Login Inspector",
          body: `
      <div class="card">
        <div class="banner">
          <span class="tag">Auth + Cloudflare data</span>
          <h1>Login <span class="grad">Inspector</span></h1>
          <p class="lead">Submit a username/password and inspect the POST data and the Cloudflare edge info.</p>
        </div>
        <div class="panel">
          <form method="post" action="/login-inspector/login">
            <label for="username">Username</label>
            <input id="username" name="username" type="email" autocomplete="username" required>
            <label for="password">Password</label>
            <input id="password" name="password" type="password" autocomplete="current-password" required>
            <div class="actions">
              <button class="btn" type="submit">Sign in</button>
            </div>
          </form>
          <p style="margin-top:14px; font-size:0.85rem;">
            Any wrong credential returns <b>Login is not valid</b>. Correct credentials show <b>Login Success</b> plus the Cloudflare edge data.
          </p>
        </div>
      </div>`,
        }),
        {
          headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
        }
      );
    }

    if (request.method === "POST" && url.pathname === "/login-inspector/login") {
      let username = "";
      let password = "";
      try {
        const form = await request.formData();
        username = (form.get("username") || "").trim();
        password = form.get("password") || "";
      } catch (_) {
        // fall through with empty values -> invalid
      }

      const user = env.LOGIN_USER || FALLBACK_USER;
      const pass = env.LOGIN_PASSWORD || FALLBACK_PASSWORD;
      const validated = username === user && password === pass;

      const posted = `
        <div class="kv">
          ${kvRow("username", esc(username))}
          ${kvRow("password (masked)", esc(mask(password)))}
        </div>`;

      if (!validated) {
        return new Response(
          page({
            title: "Login is not valid",
            body: `
        <div class="card">
          <div class="panel warn">
            <h1 style="font-size:1.9rem; margin-bottom:10px;">Login is not valid</h1>
            <p class="lead">The submitted credentials do not match the expected admin login.</p>
            <h2>What was posted</h2>
            ${posted}
            <div class="actions">
              <a class="btn ghost" href="/login-inspector">Try again</a>
            </div>
          </div>
        </div>`,
          }),
          { status: 401, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } }
        );
      }

      return new Response(
        page({
          title: "Login Success",
          body: `
        <div class="card">
          <div class="panel">
            <span class="tag">Access granted</span>
            <h1 style="font-size:1.9rem; margin-bottom:8px;">Login Success</h1>
            <p class="lead">Valid credentials. Below is the data Cloudflare exposes for this request.</p>
            ${posted}
          </div>
          <div class="panel">
            <h2>Cloudflare data</h2>
            ${dataSections(request)}
          </div>
          <div class="actions">
            <a class="btn ghost" href="/login-inspector">Back to login</a>
            <a class="btn" href="/login-inspector">Test again</a>
          </div>
        </div>`,
        }),
        { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } }
      );
    }

    if (request.method !== "GET" && request.method !== "POST") {
      return new Response("Method Not Allowed", { status: 405 });
    }

    return new Response("Not Found", { status: 404 });
  },
};
