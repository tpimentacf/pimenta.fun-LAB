// precursor-clearance — Pimenta Lab
// --------------------------------------------------------------------------
// cf_clearance is an HttpOnly cookie: the browser SENDS it on every request,
// but it is invisible to page JavaScript (document.cookie can never read it).
//
// This Worker fronts the precursor-lab page, reads the *incoming request's*
// Cookie header (which does include HttpOnly cookies), detects cf_clearance,
// and exposes its presence to the page in two ways:
//
//   1. Response headers  X-CF-Clearance: present|absent  and  X-CF-Clearance-Len
//      — so a re-fetch of the actual page URL can read the state per request.
//   2. An injected <script> in <head> setting window.__cfClearance = {present,len}
//      — so the state is available on the very first page load.
//
// Detection therefore happens on the *actual page request*; the page makes no
// separate/external request to probe for the cookie.
//
// Bind to a route in wrangler.toml, e.g.:
//   www.pimenta.fun/precursor-lab*
// --------------------------------------------------------------------------

function detectClearance(cookieHeader) {
  const m = (cookieHeader || "").match(/(?:^|;\s*)cf_clearance=([^;]*)/);
  return { present: !!m, len: m ? m[1].length : 0 };
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
    const clr = detectClearance(request.headers.get("cookie"));

    // Fetch the origin page as usual (this Worker is on the route).
    const originResponse = await fetch(request);

    // Copy headers so we can add our own (origin Response headers are immutable).
    const headers = new Headers(originResponse.headers);
    headers.set("X-CF-Clearance", clr.present ? "present" : "absent");
    headers.set("X-CF-Clearance-Len", String(clr.len));
    // Harmless for same-origin; lets cross-origin readers see the headers too.
    headers.append("Access-Control-Expose-Headers", "X-CF-Clearance, X-CF-Clearance-Len");

    const contentType = headers.get("content-type") || "";
    const base = new Response(originResponse.body, {
      status: originResponse.status,
      statusText: originResponse.statusText,
      headers,
    });

    // Only rewrite HTML documents; pass everything else through untouched.
    if (!contentType.includes("text/html")) {
      return base;
    }

    const js = "window.__cfClearance=" + JSON.stringify(clr) + ";";
    return new HTMLRewriter().on("head", new HeadInjector(js)).transform(base);
  },
};
