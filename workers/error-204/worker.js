// 204 No Content responder
// --------------------------------------------------------------------------
// A static file can only be served with a 200 + body, so this Worker fronts the
// /error/error204 route and answers every request with a bodyless
// `204 No Content` response.
//
// A 204 tells the client "request succeeded, there is intentionally nothing to
// return" — useful for maintenance toggles, health/uptime probes, silencing
// beacons/telemetry, and CORS pre-flight-style acknowledgements.
//
// Per RFC 9110 a 204 response MUST NOT carry a message body, so we pass `null`
// as the body and let the runtime omit Content-Length.
//
// Bind to a route in wrangler.toml, e.g.:
//   www.pimenta.fun/error/error204*
// --------------------------------------------------------------------------

export default {
  async fetch(request) {
    return new Response(null, {
      status: 204,
      statusText: "No Content",
      headers: {
        // Never cache the (empty) result so the status is always fresh.
        "Cache-Control": "no-store",
        // Small marker so it's obvious this came from the lab Worker.
        "X-Pimenta-Lab": "error-204",
      },
    });
  },
};
