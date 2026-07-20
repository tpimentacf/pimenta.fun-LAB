/**
 * Cloudflare Worker: fetch HTML from origin, inject Cloudflare Turnstile, and
 * verify the Turnstile token server-side with MULTI-SIGNAL anti-bypass checks
 * before letting form POSTs reach origin.
 *
 * Flow:
 *   GET (or non-mutating) requests:
 *     1. Proxy to origin.
 *     2. If HTML, stream through HTMLRewriter and inject:
 *          - the Turnstile API script into <head>
 *          - a Turnstile widget into any <form> (or INJECT_SELECTOR target)
 *            (widget carries data-action / data-cdata for server-side binding)
 *     3. Optionally tighten CSP so the widget can only load from Cloudflare.
 *     4. Non-HTML responses pass through untouched.
 *
 *   POST/PUT/PATCH/DELETE requests (form submissions):
 *     1. Pre-flight edge signals (fail fast, never hit siteverify or origin):
 *          - blocked hosting/solver ASNs   (request.cf.asn)
 *          - Bot Management score floor     (request.cf.botManagement.score)
 *     2. Extract the "cf-turnstile-response" token from the body.
 *     3. Replay check: reject tokens already spent (KV, keyed by sha256(token)).
 *     4. Verify against siteverify using secret + client IP + STABLE
 *        idempotency_key = sha256(token) (single-use, not a random UUID).
 *     5. Validate the full outcome, not just `success`:
 *          - hostname in EXPECTED_HOSTNAMES
 *          - action  == EXPECTED_ACTION
 *          - cdata   == EXPECTED_CDATA (optional)
 *          - challenge_ts freshness < MAX_TOKEN_AGE_SECONDS
 *          - ephemeral_id abuse counter (KV, optional, Enterprise)
 *     6. If all pass -> mark token spent, forward ORIGINAL request to origin.
 *        Otherwise -> 403, never hitting origin.
 *
 * Config (vars):
 *   TURNSTILE_SITEKEY      site key (public)              default: test key
 *   TURNSTILE_SECRET       secret key    [SECRET: `wrangler secret put`]
 *   ORIGIN_URL             (optional) origin host override
 *   INJECT_SELECTOR        (optional) widget selector, default "form"
 *   VERIFY_METHODS         (optional) comma list, default "POST"
 *   EXPECTED_HOSTNAMES     (optional) comma list; token hostname must match
 *   EXPECTED_ACTION        (optional) token action must equal this
 *   EXPECTED_CDATA         (optional) token cdata must equal this
 *   MAX_TOKEN_AGE_SECONDS  (optional) reject stale tokens, default 300
 *   BLOCKED_ASNS           (optional) comma list of ASNs to hard-block
 *   MIN_BOT_SCORE          (optional) 1-99; block below this (needs BM), e.g. 30
 *   EPHEMERAL_ID_MAX_USES  (optional) max solves per ephemeral_id per window
 *   EPHEMERAL_ID_WINDOW    (optional) window seconds for the counter, default 3600
 *   ADD_CSP                (optional) "true" to inject a Turnstile-scoped CSP
 *   FAIL_OPEN              (optional) "true" to allow through if siteverify errors
 *
 * Bindings (optional):
 *   TOKEN_REPLAY           KV namespace for single-use + ephemeral_id counters
 */

const SITEVERIFY_URL =
  "https://challenges.cloudflare.com/turnstile/v0/siteverify";

export default {
  async fetch(request, env, ctx) {
    const sitekey = env.TURNSTILE_SITEKEY || "1x00000000000000000000AA"; // test key fallback
    const injectSelector = env.INJECT_SELECTOR || "form";
    const verifyMethods = (env.VERIFY_METHODS || "POST")
      .split(",")
      .map((m) => m.trim().toUpperCase())
      .filter(Boolean);

    // ---- 1. Verify Turnstile on mutating requests before touching origin ----
    if (verifyMethods.includes(request.method.toUpperCase())) {
      return handleVerifiedSubmission(request, env, ctx);
    }

    // ---- 2. Otherwise proxy + inject ----
    const originResponse = await fetchOrigin(request, env);

    const contentType = originResponse.headers.get("content-type") || "";
    if (!contentType.includes("text/html")) {
      return originResponse;
    }

    const scriptTag =
      '<script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>';

    // Bind the widget to an action/cdata so the token can only be spent here.
    const actionAttr = env.EXPECTED_ACTION
      ? ` data-action="${escapeAttr(env.EXPECTED_ACTION)}"`
      : "";
    const cdataAttr = env.EXPECTED_CDATA
      ? ` data-cdata="${escapeAttr(env.EXPECTED_CDATA)}"`
      : "";
    const widgetHtml = `<div class="cf-turnstile" data-sitekey="${escapeAttr(
      sitekey
    )}"${actionAttr}${cdataAttr}></div>`;

    const rewriter = new HTMLRewriter()
      .on("head", {
        element(element) {
          element.append(scriptTag, { html: true });
        },
      })
      .on(injectSelector, {
        element(element) {
          element.prepend(widgetHtml, { html: true });
        },
      });

    const response = new Response(originResponse.body, originResponse);
    const transformed = rewriter.transform(response);

    if (String(env.ADD_CSP).toLowerCase() === "true") {
      return withTurnstileCsp(transformed);
    }
    return transformed;
  },
};

/**
 * Read the Turnstile token from the request body, run all anti-bypass signal
 * checks, verify it, and either forward the original request or reject.
 */
async function handleVerifiedSubmission(request, env, ctx) {
  const secret = env.TURNSTILE_SECRET;
  if (!secret) {
    return new Response("Server misconfigured: TURNSTILE_SECRET is not set.", {
      status: 500,
    });
  }

  const cf = request.cf || {};
  const clientIp = request.headers.get("CF-Connecting-IP") || "";

  // ---- Pre-flight edge signals: fail fast, cheap, before siteverify ----

  // (a) Hosting/solver ASN blocklist. Internal AppSec bypass analysis showed
  //     solver farms originate from hosting ASNs (26548, 43444, 214216, ...).
  const blockedAsns = parseList(env.BLOCKED_ASNS);
  if (blockedAsns.length && cf.asn != null && blockedAsns.includes(String(cf.asn))) {
    return challengeFailed("Blocked network (ASN).", 403, ["asn-blocked"], {
      asn: cf.asn,
      ip: clientIp,
    });
  }

  // (b) Bot Management score floor (requires BM entitlement). Score 1 == bot,
  //     99 == human. Note: a high score alone is not sufficient (see alkami
  //     BotScore=1 bypass) — this is a floor, Turnstile is still required.
  const minBotScore = toInt(env.MIN_BOT_SCORE);
  const botScore = cf.botManagement && cf.botManagement.score;
  if (minBotScore && typeof botScore === "number" && botScore < minBotScore) {
    return challengeFailed("Blocked (bot score).", 403, ["bot-score-low"], {
      score: botScore,
      ip: clientIp,
    });
  }

  // ---- Token extraction (clone so original body reaches origin intact) ----
  const token = await extractToken(request.clone());
  if (!token) {
    return challengeFailed("Missing Turnstile token.");
  }

  const tokenHash = await sha256Hex(token);

  // ---- Replay defense: reject any token we've already spent ----
  if (env.TOKEN_REPLAY) {
    const seen = await env.TOKEN_REPLAY.get(`t:${tokenHash}`);
    if (seen) {
      return challengeFailed("Token already used (replay).", 403, [
        "token-replayed",
      ]);
    }
  }

  // ---- siteverify with STABLE idempotency key (real single-use) ----
  const form = new FormData();
  form.append("secret", secret);
  form.append("response", token);
  if (clientIp) form.append("remoteip", clientIp); // enables tokenIP vs remoteIP checks
  form.append("idempotency_key", tokenHash);

  let outcome;
  try {
    const verifyResp = await fetch(SITEVERIFY_URL, { method: "POST", body: form });
    outcome = await verifyResp.json();
  } catch (err) {
    if (String(env.FAIL_OPEN).toLowerCase() === "true") {
      return fetchOrigin(request, env);
    }
    return challengeFailed("Turnstile verification request failed.", 502);
  }

  if (!outcome.success) {
    return challengeFailed("Turnstile verification failed.", 403, outcome["error-codes"]);
  }

  // ---- Validate the FULL outcome, not just success ----
  const reasons = [];

  const expectedHosts = parseList(env.EXPECTED_HOSTNAMES);
  if (expectedHosts.length && !expectedHosts.includes(outcome.hostname)) {
    reasons.push("hostname-mismatch");
  }

  if (env.EXPECTED_ACTION && outcome.action !== env.EXPECTED_ACTION) {
    reasons.push("action-mismatch");
  }

  if (env.EXPECTED_CDATA && outcome.cdata !== env.EXPECTED_CDATA) {
    reasons.push("cdata-mismatch");
  }

  const maxAge = toInt(env.MAX_TOKEN_AGE_SECONDS) || 300;
  if (outcome.challenge_ts) {
    const ageSec = (Date.now() - Date.parse(outcome.challenge_ts)) / 1000;
    if (!Number.isFinite(ageSec) || ageSec > maxAge || ageSec < -60) {
      reasons.push("token-stale");
    }
  }

  if (reasons.length) {
    return challengeFailed("Turnstile outcome rejected.", 403, reasons, {
      hostname: outcome.hostname,
      action: outcome.action,
      challenge_ts: outcome.challenge_ts,
      ip: clientIp,
    });
  }

  // ---- Ephemeral ID abuse counter (Enterprise; catches IP rotation) ----
  const ephemeralId = outcome.metadata && outcome.metadata.ephemeral_id;
  const epMax = toInt(env.EPHEMERAL_ID_MAX_USES);
  if (env.TOKEN_REPLAY && ephemeralId && epMax) {
    const window = toInt(env.EPHEMERAL_ID_WINDOW) || 3600;
    const key = `e:${ephemeralId}`;
    const count = (toInt(await env.TOKEN_REPLAY.get(key)) || 0) + 1;
    ctx.waitUntil(env.TOKEN_REPLAY.put(key, String(count), { expirationTtl: window }));
    if (count > epMax) {
      return challengeFailed("Device rate limit exceeded.", 429, [
        "ephemeral-id-throttled",
      ], { ephemeral_id: ephemeralId });
    }
  }

  // ---- Mark token spent so it can never be replayed ----
  if (env.TOKEN_REPLAY) {
    ctx.waitUntil(
      env.TOKEN_REPLAY.put(`t:${tokenHash}`, "1", { expirationTtl: maxAge + 60 })
    );
  }

  // Verified — forward the original (untouched) request to origin.
  return fetchOrigin(request, env);
}

/**
 * Pull "cf-turnstile-response" out of urlencoded or multipart form bodies,
 * or from a JSON body ({ "cf-turnstile-response": "..." }).
 */
async function extractToken(request) {
  const contentType = (request.headers.get("content-type") || "").toLowerCase();

  try {
    if (
      contentType.includes("application/x-www-form-urlencoded") ||
      contentType.includes("multipart/form-data")
    ) {
      const form = await request.formData();
      return form.get("cf-turnstile-response") || "";
    }

    if (contentType.includes("application/json")) {
      const data = await request.json();
      return data["cf-turnstile-response"] || data.token || "";
    }
  } catch (_) {
    // fall through
  }
  return "";
}

/** Proxy a request to origin (same URL, or ORIGIN_URL host override). */
function fetchOrigin(request, env) {
  if (!env.ORIGIN_URL) {
    return fetch(request);
  }
  const url = new URL(request.url);
  const origin = new URL(env.ORIGIN_URL);
  url.protocol = origin.protocol;
  url.hostname = origin.hostname;
  url.port = origin.port;
  return fetch(new Request(url.toString(), request));
}

/** Standard rejection response for a failed/absent challenge (also logs). */
function challengeFailed(message, status = 403, errorCodes, meta) {
  // console.log is captured by Workers Logs / Logpush for bypass analysis.
  console.log(
    JSON.stringify({ turnstile: "reject", message, errorCodes, ...meta })
  );
  const body = {
    error: message,
    ...(errorCodes ? { "error-codes": errorCodes } : {}),
  };
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** Append a Turnstile-scoped CSP so the widget can only load from Cloudflare. */
function withTurnstileCsp(response) {
  const headers = new Headers(response.headers);
  const add =
    "script-src 'self' 'unsafe-inline' https://challenges.cloudflare.com; " +
    "frame-src https://challenges.cloudflare.com;";
  const existing = headers.get("content-security-policy");
  headers.set(
    "content-security-policy",
    existing ? `${existing}; ${add}` : `default-src 'self'; ${add}`
  );
  return new Response(response.body, { ...response, headers });
}

/** sha256 hex of a string (used for stable idempotency + replay keys). */
async function sha256Hex(input) {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function parseList(value) {
  return (value || "")
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
}

function toInt(value) {
  const n = parseInt(value, 10);
  return Number.isFinite(n) ? n : 0;
}

function escapeAttr(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
