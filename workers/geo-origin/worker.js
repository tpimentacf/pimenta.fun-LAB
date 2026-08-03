// Geo / header origin steering demo  (EU server vs US server)
// --------------------------------------------------------------------------
// Emulates a Cloudflare Load Balancer with two pools (EU-West, US-East) and a
// geo-steering policy, plus a header/query override (like an LB custom rule).
//
// Decision order:
//   1. explicit override  -> ?region=eu|us   OR   header  x-region: eu|us
//   2. otherwise geo       -> request.cf.continent  (EU/AF -> EU, else -> US)
//
// The chosen pool is reported in the response headers so it behaves like a
// real LB where each origin stamps its identity:
//   X-Served-By: EU server | US server
//   X-LB-Pool:   eu-west-pool | us-east-pool
//   X-LB-Steering: geo (visitor location) | header/param override
//
// Content negotiation: ?format=json or Accept: application/json -> JSON.
//
// Route (wrangler.toml):  www.pimenta.fun/load-balancer/geo-origin*
// --------------------------------------------------------------------------

const POOLS = {
  eu: { server: "EU server", pool: "eu-west-pool", loc: "Frankfurt / Amsterdam (EU-West)", flag: "EU", accent: "#5b8def" },
  us: { server: "US server", pool: "us-east-pool", loc: "Ashburn, VA (US-East)",           flag: "US", accent: "#36d399" },
};

function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function decide(request, url) {
  const cf = request.cf || {};
  const override = (url.searchParams.get("region") || request.headers.get("x-region") || "").toLowerCase();
  if (override === "eu" || override === "us") {
    return { region: override, steering: "header/param override" };
  }
  const continent = (cf.continent || "").toUpperCase();
  const region = (continent === "EU" || continent === "AF") ? "eu" : "us";
  return { region, steering: "geo (visitor location)" };
}

export default {
  async fetch(request) {
    const url = new URL(request.url);
    const cf = request.cf || {};
    const { region, steering } = decide(request, url);
    const pool = POOLS[region];

    const data = {
      servedBy: pool.server,
      pool: pool.pool,
      location: pool.loc,
      steering,
      you: {
        continent: cf.continent || null,
        country: cf.country || null,
        city: cf.city || null,
        colo: cf.colo || null,
      },
      cfRay: request.headers.get("cf-ray") || null,
      timestamp: new Date().toISOString(),
    };

    const headers = {
      "X-Served-By": pool.server,
      "X-LB-Pool": pool.pool,
      "X-LB-Steering": steering,
      "Cache-Control": "no-store",
    };

    const wantsJson = url.searchParams.get("format") === "json" ||
      (request.headers.get("accept") || "").includes("application/json");
    if (wantsJson) {
      return new Response(JSON.stringify(data, null, 2), {
        headers: { ...headers, "content-type": "application/json; charset=utf-8", "access-control-allow-origin": "*" },
      });
    }

    return new Response(renderHTML(data, pool, region), {
      headers: { ...headers, "content-type": "text/html; charset=utf-8" },
    });
  },
};

function renderHTML(d, pool, region) {
  const base = "/load-balancer/geo-origin/";
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Geo origin (EU / US) &mdash; Pimenta Lab</title>
  <meta name="description" content="Load Balancer demo: steered to an EU or US server by your location, overridable with a header or query parameter. Reported via the X-Served-By header." />
  <link rel="stylesheet" href="/assets/lab.css" />
  <style>
    .served { display:flex; align-items:center; gap:18px; background: var(--panel2); border:1px solid var(--border);
              border-left:6px solid ${pool.accent}; border-radius:14px; padding:20px 22px; }
    .served .flag { font-size:2rem; font-weight:800; color:${pool.accent}; letter-spacing:1px;
                    border:2px solid ${pool.accent}; border-radius:12px; padding:8px 12px; }
    .served .t { font-size:1.35rem; font-weight:800; } .served .s { color:var(--muted); font-size:0.9rem; }
    .kv { width:100%; border-collapse:collapse; font-size:0.85rem; margin-top:4px; }
    .kv th,.kv td { text-align:left; padding:9px 12px; border-bottom:1px solid var(--border); vertical-align:top; }
    .kv thead th { color:var(--accent); font-size:0.72rem; text-transform:uppercase; letter-spacing:0.5px; }
    .kv tbody td:first-child { font-family:ui-monospace,Menlo,monospace; color:#9cc0ff; white-space:nowrap; }
    .kv tbody td .val { font-family:ui-monospace,Menlo,monospace; color:#d7e2f7; word-break:break-word; }
    .kv tbody tr:last-child td { border-bottom:none; }
    .panel h2 { margin-top:0; font-size:1.1rem; }
    .row-actions { display:flex; gap:10px; flex-wrap:wrap; margin-top:14px; }
    .muted-small { color:var(--muted); font-size:0.8rem; }
    .btn.on { outline:2px solid var(--accent); }
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
    <div class="crumb"><a href="https://www.pimenta.fun/#tests">Tests</a> / Load Balancing / Geo origin (EU / US)</div>
    <span class="tag">Load Balancing</span>
    <h1>Geo origin <span class="grad">(EU / US)</span></h1>
    <p class="lead">This request was steered to one of two origins &mdash; an <strong>EU</strong> or <strong>US</strong>
      "server" &mdash; the same way a Cloudflare Load Balancer picks a pool. The choice is by your location, and you can
      override it with a header or query parameter.</p>

    <div class="served">
      <span class="flag">${esc(pool.flag)}</span>
      <div>
        <div class="t">Served by: ${esc(d.servedBy)}</div>
        <div class="s">${esc(d.location)} &middot; pool <code class="inline">${esc(d.pool)}</code> &middot; steering: ${esc(d.steering)}</div>
      </div>
    </div>

    <div class="row-actions">
      <a class="btn ghost ${region === "eu" ? "on" : ""}" href="${base}?region=eu">Force EU</a>
      <a class="btn ghost ${region === "us" ? "on" : ""}" href="${base}?region=us">Force US</a>
      <a class="btn" href="${base}">Auto (by location)</a>
      <a class="btn ghost" href="${base}?format=json">View JSON</a>
    </div>

    <div class="panel">
      <h2>Why you landed here</h2>
      <table class="kv">
        <thead><tr><th style="width:210px;">Signal</th><th>Value</th></tr></thead>
        <tbody>
          <tr><td>X-Served-By</td><td><span class="val">${esc(d.servedBy)}</span></td></tr>
          <tr><td>X-LB-Pool</td><td><span class="val">${esc(d.pool)}</span></td></tr>
          <tr><td>X-LB-Steering</td><td><span class="val">${esc(d.steering)}</span></td></tr>
          <tr><td>your continent</td><td><span class="val">${esc(d.you.continent)}</span></td></tr>
          <tr><td>your country</td><td><span class="val">${esc(d.you.country)}</span></td></tr>
          <tr><td>your city</td><td><span class="val">${esc(d.you.city)}</span></td></tr>
          <tr><td>edge colo</td><td><span class="val">${esc(d.you.colo)}</span></td></tr>
          <tr><td>cf-ray</td><td><span class="val">${esc(d.cfRay)}</span></td></tr>
        </tbody>
      </table>
      <p class="muted-small" id="hdr-note">Reading the live <code class="inline">X-Served-By</code> response header&hellip;</p>
    </div>

    <div class="panel">
      <h2>How this maps to a real Load Balancer</h2>
      <p>Here a single Worker simulates the steering decision using <code class="inline">request.cf</code>. In production
        you would create two <strong>pools</strong> (EU-West, US-East), set the load balancer's steering to <strong>Geo</strong>,
        and add a <strong>custom rule</strong> for the header override:</p>
      <pre># header override, evaluated before geo steering
if  http.request.headers["x-region"][0] == "eu"   then pool: eu-west-pool
if  http.request.headers["x-region"][0] == "us"   then pool: us-east-pool
# else: geo steering  (EU region -> eu-west-pool, NA -> us-east-pool)</pre>
      <p class="muted-small">Read the full walk-through in the
        <a href="https://www.pimenta.fun/load-balancer-guide/" style="color:var(--accent);">Load Balancer guide</a>.</p>
    </div>

    <p><a class="btn ghost" href="https://www.pimenta.fun/#tests">&larr; Back to tests</a></p>
  </main>

  <section class="disclaimer"><div class="box">
    <b>Disclaimer:</b> All information provided on this page was developed by Pimenta.fun LAB.
    Please consult the official documentation for the most accurate and up-to-date information.
    We are not responsible for any issues, damages, or data loss that may occur from using this information.
    <span class="risk">USE AT YOUR OWN RISK.</span>
  </div></section>
  <footer class="lab">
    <span>&copy; 2026 pimenta.fun &mdash; Security Lab &middot; built by TPimenta LAB</span>
    &nbsp;&middot;&nbsp;<a href="https://www.pimenta.fun/#tests">Back to tests</a>
  </footer>

  <script>
    // Read the actual response header from a same-origin fetch to prove it.
    fetch(location.href, { cache: "no-store" }).then(function(r){
      var sb = r.headers.get("x-served-by"), st = r.headers.get("x-lb-steering"), ray = r.headers.get("cf-ray");
      var el = document.getElementById("hdr-note");
      if (sb) el.innerHTML = "Live header \u2014 <code class=\\"inline\\">X-Served-By: " + sb + "</code>" +
        (st ? " &middot; <code class=\\"inline\\">X-LB-Steering: " + st + "</code>" : "") +
        (ray ? " &middot; cf-ray " + ray : "");
      else el.textContent = "(X-Served-By header not readable)";
    }).catch(function(e){ document.getElementById("hdr-note").textContent = "header read failed: " + e.message; });
  </script>
</body>
</html>`;
}
