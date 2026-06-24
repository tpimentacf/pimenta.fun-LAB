/**
 * cf-echo — Pimenta Lab
 *
 * Echoes back the inbound request as the Cloudflare edge sees it:
 *   - every request header (including CF-injected ones like CF-Connecting-IP,
 *     CF-Ray, CF-IPCountry, X-Forwarded-For — none of which are visible to
 *     client-side JavaScript), and
 *   - the full `request.cf` object (country, colo, ASN, TLS cipher, bot score,
 *     geolocation, etc.).
 *
 * It powers https://www.pimenta.fun/cf-echo/ but is a generic, dependency-free
 * debugging endpoint you can route anywhere.
 *
 * Routes (suggested):
 *   www.pimenta.fun/cf-echo/echo*   -> this Worker
 *
 * Responses:
 *   GET  ?format=html   -> minimal HTML view (default when Accept: text/html
 *                          and no format param)
 *   GET/POST (default)  -> application/json  { method, url, http, headers, cf }
 *
 * CORS is open (GET, POST, OPTIONS) so the lab page can call it cross-origin if
 * you host the Worker on a different hostname (e.g. *.workers.dev).
 */

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function headersToObject(headers) {
  const out = {};
  for (const [k, v] of headers.entries()) out[k] = v;
  return out;
}

/** Pull a readable subset of request.cf, but also pass the whole thing through. */
function summarizeCf(cf) {
  if (!cf) return null;
  // request.cf is a plain object; clone what we can. botManagement and tls
  // client auth are nested objects — JSON.stringify handles them.
  try {
    return JSON.parse(JSON.stringify(cf));
  } catch (_) {
    return { note: "request.cf present but not serializable" };
  }
}

function buildPayload(request) {
  const url = new URL(request.url);
  return {
    method: request.method,
    url: request.url,
    path: url.pathname,
    http: (request.cf && request.cf.httpProtocol) || null,
    serverTime: new Date().toISOString(),
    headers: headersToObject(request.headers),
    cf: summarizeCf(request.cf),
  };
}

function htmlView(payload) {
  const esc = (s) =>
    String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const json = esc(JSON.stringify(payload, null, 2));
  return `<!DOCTYPE html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>cf-echo</title>
<style>body{font:14px ui-monospace,Menlo,monospace;background:#0b1020;color:#e8edf7;margin:0;padding:24px}
h1{font-size:1rem;color:#f6821f}pre{white-space:pre-wrap;word-break:break-word;background:#131a30;
border:1px solid #233056;border-radius:10px;padding:16px;overflow:auto}</style></head>
<body><h1>cf-echo — request.cf &amp; headers</h1><pre>${json}</pre></body></html>`;
}

async function handle(request) {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS });
  }

  const url = new URL(request.url);
  const payload = buildPayload(request);

  const wantsHtml =
    url.searchParams.get("format") === "html" ||
    (!url.searchParams.has("format") &&
      (request.headers.get("accept") || "").includes("text/html"));

  if (wantsHtml) {
    return new Response(htmlView(payload), {
      headers: { "content-type": "text/html; charset=utf-8", ...CORS },
    });
  }

  return new Response(JSON.stringify(payload, null, 2), {
    headers: { "content-type": "application/json; charset=utf-8", ...CORS },
  });
}

// Module-syntax Worker (wrangler default).
export default {
  async fetch(request) {
    return handle(request);
  },
};
