/**
 * mtls-inspector — Pimenta Lab
 *
 * A single-page mTLS / SSL-TLS inspector served AT THE EDGE for a hostname that
 * has Cloudflare mTLS (client certificates) enabled — e.g. mtls.pimenta.fun.
 *
 * A purely static HTML file cannot read any of this: the client certificate,
 * the negotiated TLS version/cipher, the JA3/JA4 fingerprints and the rest of
 * the `request.cf` object only exist at the Cloudflare edge (or as CF-injected
 * request headers the browser's JavaScript is not allowed to see). This Worker
 * therefore renders a self-contained HTML page with EVERY value filled in
 * server-side, and also exposes the same data as JSON.
 *
 * What it prints
 *   1. Client certificate  — the full `request.cf.tlsClientAuth` object
 *      (presented / verified / revoked, subject & issuer DN, serial, SKI,
 *      SHA-1 / SHA-256 fingerprints, notBefore / notAfter, ...), a computed
 *      verification banner and a days-until-expiry countdown.
 *   2. cf-client-cert-* headers — the values from the "mTLS client certificate
 *      headers" Managed Transform, if enabled.
 *   3. TLS / SSL connection — tlsVersion, tlsCipher, SNI, httpProtocol,
 *      clientTcpRtt, TLS ClientHello length, client random, JA3 / JA4.
 *   4. All of request.cf — the complete Cloudflare edge object (geo, ASN,
 *      colo, bot management, ...).
 *   5. All request headers — including the CF-injected ones.
 *
 * Endpoints
 *   GET  <route>                 -> HTML page (self-contained, dark lab theme)
 *   GET  <route>?format=json     -> application/json with the full payload
 *   GET  <route>?format=raw      -> alias of ?format=json (pretty-printed)
 *
 * Suggested route (see wrangler.toml):
 *   mtls.pimenta.fun/cert-info*  -> this Worker
 *
 * IMPORTANT — so the inspector can actually report status:
 *   - The hostname must be ASSOCIATED for mTLS (SSL/TLS -> Client Certificates,
 *     or API Shield -> mTLS) so Cloudflare REQUESTS a client certificate during
 *     the handshake. Otherwise `tlsClientAuth` stays empty and the browser is
 *     never prompted for a cert.
 *   - Do NOT hard-block this path with a `not cf.tls_client_auth.cert_verified`
 *     WAF rule, or the page returns 403 before it can tell you "no cert
 *     presented". Skip/allow this path, or run the rule in Log mode.
 *   - Enable the "mTLS client certificate headers" Managed Transform to also
 *     populate the cf-client-cert-* headers section.
 */

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

const esc = (s) =>
  String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

function headersToObject(headers) {
  const out = {};
  for (const [k, v] of headers.entries()) out[k] = v;
  return out;
}

function cloneCf(cf) {
  if (!cf) return {};
  try {
    return JSON.parse(JSON.stringify(cf));
  } catch (_) {
    return {};
  }
}

/** Build the whole data payload from the edge request. */
function buildData(request) {
  const url = new URL(request.url);
  const cf = cloneCf(request.cf);
  const tca = cf.tlsClientAuth || {};
  const headers = headersToObject(request.headers);

  const clientCertHeaders = {};
  for (const k of Object.keys(headers)) {
    if (k.toLowerCase().startsWith("cf-client-cert")) clientCertHeaders[k] = headers[k];
  }

  const presented = tca.certPresented === "1";
  const verified = tca.certVerified === "SUCCESS";
  const revoked = tca.certRevoked === "1";

  // Days until expiry (best-effort parse of certNotAfter).
  let daysToExpiry = null;
  if (tca.certNotAfter) {
    const t = Date.parse(tca.certNotAfter);
    if (!Number.isNaN(t)) daysToExpiry = Math.round((t - Date.now()) / 86400000);
  }

  const tls = {
    tlsVersion: cf.tlsVersion || null,
    tlsCipher: cf.tlsCipher || null,
    sni: url.hostname,
    httpProtocol: cf.httpProtocol || null,
    clientTcpRtt: cf.clientTcpRtt != null ? cf.clientTcpRtt : null,
    tlsClientHelloLength: cf.tlsClientHelloLength || null,
    tlsClientRandom: cf.tlsClientRandom || null,
    tlsClientExtensionsSha1: cf.tlsClientExtensionsSha1 || null,
    ja3Hash: (cf.botManagement && cf.botManagement.ja3Hash) || cf.ja3Hash || null,
    ja4: (cf.botManagement && cf.botManagement.ja4) || cf.ja4 || null,
  };

  return {
    serverTime: new Date().toISOString(),
    url: request.url,
    host: url.hostname,
    clientIp: headers["cf-connecting-ip"] || null,
    ray: headers["cf-ray"] || null,
    mtlsEnabledForHostname: Object.keys(tca).length > 0,
    status: {
      presented,
      verified,
      revoked,
      certVerified: tca.certVerified || "NONE",
    },
    daysToExpiry,
    clientCertificate: tca,
    clientCertHeaders,
    tls,
    cf,
    headers,
  };
}

/* ---------------------------------------------------------------- rendering */

function rowsFromObject(obj, mono) {
  const keys = Object.keys(obj || {});
  if (keys.length === 0) {
    return `<tr><td colspan="2" class="empty">(none)</td></tr>`;
  }
  return keys
    .map((k) => {
      let v = obj[k];
      if (v && typeof v === "object") v = JSON.stringify(v);
      const cls = mono ? ' class="mono"' : "";
      return `<tr><th>${esc(k)}</th><td${cls}>${esc(v == null ? "—" : v)}</td></tr>`;
    })
    .join("\n");
}

function labelledRows(pairs) {
  return pairs
    .map(
      ([label, value]) =>
        `<tr><th>${esc(label)}</th><td class="mono">${esc(value == null || value === "" ? "—" : value)}</td></tr>`
    )
    .join("\n");
}

function banner(status, daysToExpiry) {
  if (status.revoked) {
    return `<div class="banner rev"><span class="ic">&#9760;</span><div>
      <b>Client certificate REVOKED</b>
      <span class="s">The presented certificate is on the CRL / marked revoked.</span></div></div>`;
  }
  if (status.verified) {
    let extra = "";
    if (daysToExpiry != null) {
      extra =
        daysToExpiry < 0
          ? ` &middot; expired ${Math.abs(daysToExpiry)} day(s) ago`
          : ` &middot; expires in ${daysToExpiry} day(s)`;
    }
    return `<div class="banner ok"><span class="ic">&#10003;</span><div>
      <b>Client certificate VERIFIED</b>
      <span class="s">Cloudflare validated this client certificate against the associated CA${extra}.</span></div></div>`;
  }
  if (status.presented) {
    return `<div class="banner warn"><span class="ic">&#9888;</span><div>
      <b>Client certificate PRESENTED but NOT verified</b>
      <span class="s">Result: <code>${esc(status.certVerified)}</code> — the cert was sent but failed validation (wrong CA, expired, or chain issue).</span></div></div>`;
  }
  return `<div class="banner none"><span class="ic">&#9679;</span><div>
    <b>No client certificate presented</b>
    <span class="s">The browser/client did not send a certificate. If the hostname is mTLS-associated the browser is prompted; a plain <code>curl</code> sends none.</span></div></div>`;
}

function htmlView(data, route) {
  const cfJson = esc(JSON.stringify(data.cf, null, 2));
  const headersJson = esc(JSON.stringify(data.headers, null, 2));

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<meta name="robots" content="noindex" />
<title>mTLS &amp; SSL/TLS Inspector &mdash; ${esc(data.host)}</title>
<style>
  :root{--bg:#0b1020;--panel:#131a30;--panel2:#0f1528;--accent:#f6821f;--accent2:#ff6b6b;
    --green:#36d399;--blue:#5b8def;--text:#e8edf7;--muted:#9aa6c0;--border:#233056;
    --mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
    background:radial-gradient(1100px 500px at 20% -10%,#1b2547 0%,var(--bg) 55%);color:var(--text);
    min-height:100vh;line-height:1.6}
  main{max-width:940px;margin:0 auto;padding:40px 6vw 80px}
  .tag{display:inline-block;background:rgba(246,130,31,.12);color:var(--accent);
    border:1px solid rgba(246,130,31,.4);padding:4px 12px;border-radius:999px;font-size:.72rem;
    font-weight:700;text-transform:uppercase;letter-spacing:.5px;margin-bottom:14px}
  h1{font-size:clamp(1.6rem,4vw,2.3rem);line-height:1.15;margin-bottom:10px}
  h1 .grad{background:linear-gradient(90deg,var(--accent),var(--accent2));-webkit-background-clip:text;
    background-clip:text;-webkit-text-fill-color:transparent}
  h2{font-size:1.15rem;margin:34px 0 12px;padding-top:16px;border-top:1px solid var(--border)}
  p{color:var(--muted);margin-bottom:12px}
  code{font-family:var(--mono);background:#1b2547;padding:2px 6px;border-radius:5px;font-size:.85em;color:#d7e2f7}
  .lead{color:var(--text);font-size:1rem;margin-bottom:18px}
  .banner{display:flex;gap:12px;align-items:flex-start;border:1px solid var(--border);border-radius:12px;
    padding:16px 18px;margin:8px 0 4px;background:var(--panel)}
  .banner .ic{font-size:1.4rem;line-height:1.2}
  .banner b{display:block;font-size:1.05rem;color:var(--text)}
  .banner .s{color:var(--muted);font-size:.86rem}
  .banner.ok{border-color:rgba(54,211,153,.55);background:rgba(54,211,153,.08)}
  .banner.ok .ic{color:var(--green)}
  .banner.warn{border-color:rgba(246,130,31,.55);background:rgba(246,130,31,.08)}
  .banner.warn .ic{color:var(--accent)}
  .banner.none{border-color:var(--border);background:var(--panel2)}
  .banner.none .ic{color:var(--muted)}
  .banner.rev{border-color:rgba(255,107,107,.6);background:rgba(255,107,107,.09)}
  .banner.rev .ic{color:var(--accent2)}
  .quick{display:flex;flex-wrap:wrap;gap:10px;margin:14px 0 4px}
  .chip{font-size:.78rem;padding:6px 12px;border-radius:999px;border:1px solid var(--border);
    background:var(--panel2);color:var(--muted)}
  .chip b{color:var(--text)}
  .chip.g{color:var(--green);border-color:rgba(54,211,153,.5)}
  .chip.r{color:var(--accent2);border-color:rgba(255,107,107,.5)}
  table{width:100%;border-collapse:collapse;font-size:.86rem;margin:6px 0 4px}
  th,td{text-align:left;padding:9px 12px;border-bottom:1px solid var(--border);vertical-align:top}
  tbody th{color:var(--muted);font-weight:600;white-space:nowrap;width:230px}
  td.mono,.mono{font-family:var(--mono);color:#d7e2f7;word-break:break-all}
  td.empty,.empty{color:var(--muted);text-align:center}
  pre{background:var(--panel2);border:1px solid var(--border);border-radius:10px;padding:14px 16px;
    overflow-x:auto;font-size:.8rem;color:#d7e2f7;white-space:pre-wrap;word-break:break-word;margin:6px 0}
  .btnrow{display:flex;gap:10px;flex-wrap:wrap;margin:16px 0 0}
  .btn{display:inline-block;background:var(--accent);color:#1a1205;border:none;padding:10px 16px;
    border-radius:9px;font-weight:700;font-size:.9rem;cursor:pointer;text-decoration:none;font-family:inherit}
  .btn.ghost{background:transparent;color:var(--accent);border:1px solid var(--accent)}
  .note{background:rgba(91,141,239,.1);border:1px solid rgba(91,141,239,.35);color:#bcd3ff;border-radius:12px;
    padding:12px 15px;font-size:.85rem;margin:14px 0}
  footer{border-top:1px solid var(--border);margin-top:34px;padding-top:16px;color:var(--muted);font-size:.8rem}
  footer a{color:var(--accent);text-decoration:none}
  .muted{color:var(--muted)}
</style>
</head>
<body>
<main>
  <span class="tag">mTLS &middot; SSL/TLS Inspector</span>
  <h1>Client Certificate &amp; <span class="grad">TLS</span> Inspector</h1>
  <p class="lead">Everything the Cloudflare edge sees about <b>your connection to <code>${esc(
    data.host
  )}</code></b> — the client certificate, the negotiated TLS parameters, and the full <code>request.cf</code> object. Rendered server-side at the edge (a static file cannot read any of this).</p>

  ${banner(data.status, data.daysToExpiry)}

  <div class="quick">
    <span class="chip ${data.status.presented ? "g" : ""}">presented: <b>${data.status.presented ? "yes" : "no"}</b></span>
    <span class="chip ${data.status.verified ? "g" : "r"}">verified: <b>${esc(data.status.certVerified)}</b></span>
    <span class="chip ${data.status.revoked ? "r" : ""}">revoked: <b>${data.status.revoked ? "yes" : "no"}</b></span>
    <span class="chip">mTLS on host: <b>${data.mtlsEnabledForHostname ? "yes" : "no"}</b></span>
    ${data.ray ? `<span class="chip">ray: <b>${esc(data.ray)}</b></span>` : ""}
    ${data.clientIp ? `<span class="chip">ip: <b>${esc(data.clientIp)}</b></span>` : ""}
  </div>

  ${
    !data.mtlsEnabledForHostname
      ? `<div class="note"><b>Note:</b> <code>request.cf.tlsClientAuth</code> is empty, which means this hostname is not currently associated for mTLS (Cloudflare is not requesting a client certificate during the handshake). Associate the hostname under <em>SSL/TLS &rarr; Client Certificates</em> (or API Shield &rarr; mTLS) to see certificate details.</div>`
      : ""
  }

  <h2>1 &middot; Client certificate <span class="muted" style="font-size:.7rem">request.cf.tlsClientAuth</span></h2>
  <table><tbody>
    ${labelledRows([
      ["Presented", data.clientCertificate.certPresented],
      ["Verified", data.clientCertificate.certVerified],
      ["Revoked", data.clientCertificate.certRevoked],
      ["Subject DN", data.clientCertificate.certSubjectDN],
      ["Issuer DN", data.clientCertificate.certIssuerDN],
      ["Serial", data.clientCertificate.certSerial],
      ["Issuer Serial", data.clientCertificate.certIssuerSerial],
      ["SHA-256 fingerprint", data.clientCertificate.certFingerprintSHA256],
      ["SHA-1 fingerprint", data.clientCertificate.certFingerprintSHA1],
      ["Not before", data.clientCertificate.certNotBefore],
      ["Not after", data.clientCertificate.certNotAfter],
      ["Days to expiry", data.daysToExpiry],
      ["SKI", data.clientCertificate.certSKI],
      ["Issuer SKI", data.clientCertificate.certIssuerSKI],
      ["Subject DN (RFC2253)", data.clientCertificate.certSubjectDNRFC2253],
      ["Issuer DN (RFC2253)", data.clientCertificate.certIssuerDNRFC2253],
      ["Subject DN (legacy)", data.clientCertificate.certSubjectDNLegacy],
      ["Issuer DN (legacy)", data.clientCertificate.certIssuerDNLegacy],
    ])}
  </tbody></table>
  <p class="muted" style="font-size:.8rem">Raw object (every field Cloudflare exposed):</p>
  <table><tbody>${rowsFromObject(data.clientCertificate, true)}</tbody></table>

  <h2>2 &middot; cf-client-cert-* headers <span class="muted" style="font-size:.7rem">Managed Transform</span></h2>
  <table><tbody>${rowsFromObject(data.clientCertHeaders, true)}</tbody></table>

  <h2>3 &middot; TLS / SSL connection</h2>
  <table><tbody>
    ${labelledRows([
      ["TLS version", data.tls.tlsVersion],
      ["Cipher suite", data.tls.tlsCipher],
      ["SNI (host)", data.tls.sni],
      ["HTTP protocol", data.tls.httpProtocol],
      ["Client TCP RTT (ms)", data.tls.clientTcpRtt],
      ["ClientHello length", data.tls.tlsClientHelloLength],
      ["Client random", data.tls.tlsClientRandom],
      ["Client extensions SHA-1", data.tls.tlsClientExtensionsSha1],
      ["JA3 hash", data.tls.ja3Hash],
      ["JA4", data.tls.ja4],
    ])}
  </tbody></table>

  <h2>4 &middot; All of request.cf <span class="muted" style="font-size:.7rem">Cloudflare edge object</span></h2>
  <pre>${cfJson}</pre>

  <h2>5 &middot; All request headers</h2>
  <pre>${headersJson}</pre>

  <div class="btnrow">
    <a class="btn" href="${esc(route)}?format=json">Download JSON</a>
    <a class="btn ghost" href="${esc(route)}">&#8635; Refresh</a>
    <a class="btn ghost" href="https://www.pimenta.fun/mtls-guide/">mTLS guide</a>
  </div>

  <div class="note"><b>Test from the CLI</b> (replace with your CA-signed client cert):
<pre># no cert -> "No client certificate presented"
curl -s "https://${esc(data.host)}${esc(new URL(route, "https://" + data.host).pathname)}?format=json" | jq .status

# with a client cert -> verified: SUCCESS
curl -s --cert client.crt --key client.key \\
  "https://${esc(data.host)}${esc(new URL(route, "https://" + data.host).pathname)}?format=json" | jq .status</pre></div>

  <footer>
    Served at the edge by <code>mtls-inspector</code> &middot; ${esc(data.serverTime)} &middot;
    <a href="https://www.pimenta.fun/#tests">pimenta.fun lab</a>
  </footer>
</main>
</body>
</html>`;
}

async function handle(request) {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS });
  }
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("Method Not Allowed", { status: 405, headers: CORS });
  }

  const url = new URL(request.url);
  const data = buildData(request);
  const format = url.searchParams.get("format");

  if (format === "json" || format === "raw") {
    return new Response(JSON.stringify(data, null, 2), {
      headers: {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
        ...CORS,
      },
    });
  }

  return new Response(htmlView(data, url.pathname), {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      ...CORS,
    },
  });
}

export default {
  async fetch(request) {
    return handle(request);
  },
};
