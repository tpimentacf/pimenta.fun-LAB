// precursor-clearance — Pimenta Lab
// --------------------------------------------------------------------------
// cf_clearance is an HttpOnly cookie: the browser SENDS it on every request,
// but it is invisible to page JavaScript (document.cookie can never read it).
//
// This Worker reads the *incoming request's* Cookie header (which does include
// HttpOnly cookies), detects cf_clearance, and exposes it to the page WITHOUT
// the page having to hit the challenged page path. It serves two routes:
//
//   1. www.pimenta.fun/precursor-lab*        (the HTML page)
//      - fronts the origin page and injects a <script> in <head> setting
//        window.__cfClearance = {present, len} so the state is available on the
//        very first page load, and
//      - adds X-CF-Clearance / X-CF-Clearance-Len response headers.
//
//   2. www.pimenta.fun/precursor-clearance   (dedicated JSON check endpoint)
//      - answered DIRECTLY by the Worker (no origin fetch), so it is not behind
//        the page's interactive challenge and can be fetched by the page button
//        via XHR/fetch without a 403. Returns { present, len } as JSON plus the
//        same X-CF-Clearance headers.
//
// IMPORTANT (route/order): Cloudflare evaluates WAF/challenge rules BEFORE
// Workers. Make sure any challenge protecting the page is scoped to the page
// path (e.g. path starts with "/precursor-lab") and does NOT match
// "/precursor-clearance", otherwise the check endpoint would be challenged too.
// --------------------------------------------------------------------------

const CHECK_PATH = "/precursor-clearance";

function detectClearance(cookieHeader) {
  const m = (cookieHeader || "").match(/(?:^|;\s*)cf_clearance=([^;]*)/);
  return { present: !!m, len: m ? m[1].length : 0 };
}

function clearanceHeaders(clr, extra) {
  const h = new Headers(extra || {});
  h.set("X-CF-Clearance", clr.present ? "present" : "absent");
  h.set("X-CF-Clearance-Len", String(clr.len));
  h.append("Access-Control-Expose-Headers", "X-CF-Clearance, X-CF-Clearance-Len");
  return h;
}

// HTMLRewriter handler: append an inline script as the last child of <head>.
class HeadInjector {
  constructor(js) {
    this.js = js;
  }
  element(el) {
    el.append(`<script>${this.js}</script>`, { html: true });
  }
}

export default {
  async fetch(request) {
    const url = new URL(request.url);
    const clr = detectClearance(request.headers.get("cookie"));

    // Preflight for the check endpoint (cross-origin safety; harmless otherwise).
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
        },
      });
    }

    // 1) Dedicated, un-challenged check endpoint — answered directly.
    if (url.pathname === CHECK_PATH || url.pathname === CHECK_PATH + "/") {
      const headers = clearanceHeaders(clr, {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
        "Access-Control-Allow-Origin": "*",
      });
      return new Response(JSON.stringify(clr), { headers });
    }

    // 2) The HTML page — front the origin and inject the state.
    const originResponse = await fetch(request);
    const headers = clearanceHeaders(clr, originResponse.headers);
    const contentType = headers.get("content-type") || "";
    const base = new Response(originResponse.body, {
      status: originResponse.status,
      statusText: originResponse.statusText,
      headers,
    });

    if (!contentType.includes("text/html")) {
      return base;
    }

    const js = "window.__cfClearance=" + JSON.stringify(clr) + ";";
    return new HTMLRewriter().on("head", new HeadInjector(js)).transform(base);
  },
};
