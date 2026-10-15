#!/usr/bin/env node
// ---------------------------------------------------------------------------
// api-traffic.mjs — background traffic generator for the Pimenta API
//
// Sends random requests to EVERY endpoint of backend/server.js over time
// (default: 24 hours), so analytics, API Shield discovery, rate limiting,
// Security Events and Logpush have realistic, continuous traffic to work with.
//
//   * Random order, full coverage: endpoints are drawn from a shuffled
//     "deck" (each endpoint appears <weight> times). Every endpoint is hit
//     at least once per deck before the deck is reshuffled.
//   * Random timing: Poisson arrivals (exponential gaps) around an average
//     rate, shaped by a day/night curve (peak ~16:00, low ~04:00 local time).
//   * Real flows: logs in (or registers its own user), re-logs in before the
//     JWT expires or on 401, adds items before checkout, writes products back
//     with their current values (PUT is non-destructive).
//   * Occasional negative requests (404 product, missing token) if enabled.
//
// Zero dependencies — Node 18+ (global fetch).
//
// Usage:
//   node tools/api-traffic.mjs [flags]
//   node tools/api-traffic.mjs --rpm=6 --duration=24h
//   node tools/api-traffic.mjs --base=http://127.0.0.1:3000 --rpm=60 --duration=10m
//   nohup node tools/api-traffic.mjs > traffic.log 2>&1 &     # run all day
//
// Flags (env var in brackets):
//   --base=URL         API base URL                 [API_BASE]   https://api.pimenta.fun
//   --email=EMAIL      login user                   [API_EMAIL]  tpimentacf@gmail.com
//   --password=PASS    login password               [API_PASSWORD]
//   --token=JWT        use this Bearer token instead of logging in [API_TOKEN]
//   --api-key=VALUE    api_key header on every request [API_KEY] 12345
//   --rpm=N            average requests per minute (default 4 ~ 5,800/day)
//   --duration=T       how long to run: 30m, 6h, 24h, 0 = forever (default 24h)
//   --no-curve         flat rate instead of the day/night curve
//   --no-writes        only safe requests (GET + login); skips register,
//                      PUT, basket, checkout, feedback
//   --errors=P         share of intentional negative requests, 0-1 (default 0.05)
//   --timeout=MS       per-request timeout (default 10000)
//   --stats=T          print a summary every T (default 1h)
//   --json             one JSON object per request (for log shipping)
//   --dry-run          print the schedule without sending requests
//   --no-color         disable ANSI colours
//   --help, -h         show this help
//
// Stop with Ctrl+C (or SIGTERM): prints a per-endpoint summary and exits.
// ---------------------------------------------------------------------------

const argv = process.argv.slice(2);
if (argv.includes("--help") || argv.includes("-h")) {
  const src = await import("node:fs").then((fs) => fs.readFileSync(new URL(import.meta.url), "utf8"));
  console.log(src.split("\n").filter((l) => l.startsWith("//")).map((l) => l.slice(3)).join("\n"));
  process.exit(0);
}

const opt = (name, env, def) => {
  const a = argv.find((x) => x.startsWith(`--${name}=`));
  if (a) return a.slice(name.length + 3);
  if (env && process.env[env]) return process.env[env];
  return def;
};
const flag = (name) => argv.includes(`--${name}`);

function parseDuration(s) {
  if (s === "0" || s === 0) return 0;
  const m = String(s).trim().match(/^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)?$/i);
  if (!m) throw new Error(`invalid duration: ${s}`);
  const mult = { ms: 1, s: 1e3, m: 6e4, h: 36e5, d: 864e5 }[(m[2] || "s").toLowerCase()];
  return Math.round(Number(m[1]) * mult);
}

const BASE = opt("base", "API_BASE", "https://api.pimenta.fun").replace(/\/+$/, "");
const EMAIL = opt("email", "API_EMAIL", "tpimentacf@gmail.com");
const PASSWORD = opt("password", "API_PASSWORD", "1z1muef2");
const FIXED_TOKEN = opt("token", "API_TOKEN", "");
const API_KEY = opt("api-key", "API_KEY", "12345");
const RPM = Math.max(0.01, Number(opt("rpm", "TRAFFIC_RPM", "4")));
const DURATION = parseDuration(opt("duration", "TRAFFIC_DURATION", "24h"));
const CURVE = !flag("no-curve");
const WRITES = !flag("no-writes");
const ERROR_RATE = Math.min(1, Math.max(0, Number(opt("errors", null, "0.05"))));
const TIMEOUT = Number(opt("timeout", null, "10000"));
const STATS_EVERY = parseDuration(opt("stats", null, "1h"));
const JSON_OUT = flag("json");
const DRY = flag("dry-run");
const color = !flag("no-color") && process.stdout.isTTY && !JSON_OUT;
const C = color
  ? { g: "\x1b[32m", r: "\x1b[31m", y: "\x1b[33m", d: "\x1b[2m", b: "\x1b[1m", n: "\x1b[0m" }
  : { g: "", r: "", y: "", d: "", b: "", n: "" };

const USER_AGENTS = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_6) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Safari/605.1.15",
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148",
  "Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0",
  "PimentaShop/2.3 (Android 14; Pixel 8)",
  "pimenta-api-traffic/1.0 (+https://www.pimenta.fun)"
];
const SEARCH_TERMS = ["", "apple", "juice", "pepper", "shirt", "mug", "sticker", "green", "box", "lab", "xyz"];
const COMMENTS = ["Great service!", "Fast delivery", "Could be cheaper", "Love the lab", "Checkout was smooth",
  "Product as described", "Five stars", "Packaging could be better"];

// ---- helpers ---------------------------------------------------------------
const rand = (n) => Math.floor(Math.random() * n);
const pick = (a) => a[rand(a.length)];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fmtDur = (ms) => {
  const s = Math.round(ms / 1000), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  return h ? `${h}h${String(m).padStart(2, "0")}m` : m ? `${m}m${String(s % 60).padStart(2, "0")}s` : `${s}s`;
};

// Day/night multiplier: ~0.3 at 04:00, ~1.7 at 16:00, averages 1.0 over a day.
function curve(d = new Date()) {
  if (!CURVE) return 1;
  const h = d.getHours() + d.getMinutes() / 60;
  return 1 + 0.7 * Math.sin((2 * Math.PI * (h - 10)) / 24);
}
// Exponential inter-arrival gap for the current rate (Poisson process).
function nextGap() {
  const perMs = (RPM * curve()) / 60000;
  return Math.min(-Math.log(1 - Math.random()) / perMs, 30 * 60000);
}

// ---- state + HTTP ------------------------------------------------------------
const state = {
  token: FIXED_TOKEN || null,
  tokenAt: FIXED_TOKEN ? Date.now() : 0,
  tokenSource: FIXED_TOKEN ? "--token" : null,
  email: EMAIL,
  password: PASSWORD,
  userId: null,
  bid: 1,
  productIds: [],
  basketCount: 0
};
const stats = new Map(); // key -> { n, ok, err, ms, codes{} }
let total = 0;

async function http(method, path, { body, auth = false, token } = {}) {
  const headers = { Accept: "application/json", "User-Agent": pick(USER_AGENTS), api_key: API_KEY };
  const t = token !== undefined ? token : auth ? state.token : null;
  if (t) headers.Authorization = "Bearer " + t;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TIMEOUT);
  const t0 = Date.now();
  let status = 0, json = null, err = null, text = "";
  try {
    const res = await fetch(BASE + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: ac.signal });
    status = res.status;
    text = await res.text();
    try { json = JSON.parse(text); } catch (_) { /* HTML challenge page, etc. */ }
  } catch (e) {
    err = e.name === "AbortError" ? `timeout ${TIMEOUT}ms` : e.cause?.code || e.message;
  } finally {
    clearTimeout(timer);
  }
  return { method, path, status, json, err, ms: Date.now() - t0, challenged: /Just a moment|cf-chl/i.test(text) };
}

function record(key, r, expected) {
  total++;
  const s = stats.get(key) || { n: 0, ok: 0, err: 0, ms: 0, codes: {} };
  const ok = !r.err && expected.includes(r.status);
  s.n++; s.ms += r.ms; ok ? s.ok++ : s.err++;
  const code = r.err ? "ERR" : r.challenged ? `${r.status}*` : String(r.status);
  s.codes[code] = (s.codes[code] || 0) + 1;
  stats.set(key, s);
  const ts = new Date().toISOString();
  if (JSON_OUT) {
    console.log(JSON.stringify({ ts, endpoint: key, method: r.method, path: r.path, status: r.status, ms: r.ms, ok, err: r.err, challenged: r.challenged }));
  } else {
    const c = ok ? C.g : C.r;
    const note = r.err ? ` ${r.err}` : r.challenged ? " (Cloudflare challenge)" : !ok && r.json?.error ? ` ${r.json.error}` : "";
    console.log(`${C.d}${ts.slice(0, 19).replace("T", " ")}${C.n} ${c}${String(code).padStart(4)}${C.n} ${r.method.padEnd(6)} ${r.path.padEnd(38)} ${C.d}${String(r.ms).padStart(5)}ms${C.n}${c}${note}${C.n}`);
  }
  return ok;
}

// ---- auth ------------------------------------------------------------------
async function login(force = false) {
  if (FIXED_TOKEN && !force) return true;
  if (!force && state.token && Date.now() - state.tokenAt < 90 * 60000) return true;
  const r = await http("POST", "/rest/user/login", { body: { email: state.email, password: state.password } });
  record("POST /rest/user/login", r, [200]);
  if (r.status === 200 && r.json?.authentication?.token) {
    state.token = r.json.authentication.token;
    state.bid = r.json.authentication.bid || state.bid;
    state.tokenAt = Date.now();
    state.tokenSource = state.tokenSource || "login";
    return true;
  }
  if (!WRITES) return false;
  // Fall back to a dedicated traffic user (created once per run).
  const email = `traffic+${Date.now().toString(36)}@pimenta.fun`;
  const password = "Traffic-" + Math.random().toString(36).slice(2, 10);
  const reg = await http("POST", "/api/Users", { body: { email, password } });
  record("POST /api/Users", reg, [201]);
  if (reg.status !== 201) return false;
  state.email = email; state.password = password;
  const r2 = await http("POST", "/rest/user/login", { body: { email, password } });
  record("POST /rest/user/login", r2, [200]);
  if (r2.status !== 200) return false;
  state.token = r2.json.authentication.token;
  state.bid = r2.json.authentication.bid || state.bid;
  state.tokenAt = Date.now();
  state.tokenSource = "registered " + email;
  if (!JSON_OUT) console.log(`${C.y}Login as ${EMAIL} failed; using new traffic user ${email}${C.n}`);
  return true;
}

// Run an authenticated request; on 401 re-login once and retry.
async function authed(key, method, path, opts, expected) {
  if (!(await login())) { record(key, { method, path, status: 0, err: "no token", ms: 0 }, expected); return null; }
  let r = await http(method, path, { ...opts, auth: true });
  if (r.status === 401 && !FIXED_TOKEN) {
    await login(true);
    r = await http(method, path, { ...opts, auth: true });
  }
  record(key, r, expected);
  return r;
}

async function productId() {
  if (!state.productIds.length) {
    const r = await http("GET", "/api/Products");
    record("GET /api/Products", r, [200]);
    state.productIds = (r.json?.data || []).map((p) => p.id);
  }
  return state.productIds.length ? pick(state.productIds) : 1;
}

// ---- endpoint catalogue (all 16 routes) -------------------------------------
// weight = how many times the endpoint appears in each shuffled deck.
const ENDPOINTS = [
  { key: "GET /health", w: 3, run: async () => record("GET /health", await http("GET", "/health"), [200]) },
  { key: "GET /rest/admin/application-version", w: 1, run: async () =>
      record("GET /rest/admin/application-version", await http("GET", "/rest/admin/application-version"), [200]) },
  { key: "GET /api/Products", w: 6, run: async () => {
      const r = await http("GET", "/api/Products");
      record("GET /api/Products", r, [200]);
      if (r.json?.data) state.productIds = r.json.data.map((p) => p.id);
    } },
  { key: "GET /api/Products/:id", w: 6, run: async () => {
      const id = await productId();
      record("GET /api/Products/:id", await http("GET", `/api/Products/${id}`), [200]);
    } },
  { key: "GET /rest/products/search", w: 5, run: async () => {
      const q = encodeURIComponent(pick(SEARCH_TERMS));
      record("GET /rest/products/search", await http("GET", `/rest/products/search?q=${q}`), [200]);
    } },
  { key: "GET /api/Feedbacks", w: 3, run: async () => record("GET /api/Feedbacks", await http("GET", "/api/Feedbacks"), [200]) },
  { key: "POST /rest/user/login", w: 2, run: async () => { await login(true); } },
  { key: "GET /rest/user/whoami", w: 3, run: async () => {
      const r = await authed("GET /rest/user/whoami", "GET", "/rest/user/whoami", {}, [200]);
      if (r?.json?.user?.id) state.userId = r.json.user.id;
    } },
  { key: "GET /api/Users/:id", w: 2, run: async () => {
      const id = state.userId || 1;
      await authed("GET /api/Users/:id", "GET", `/api/Users/${id}`, {}, [200]);
    } },
  { key: "GET /rest/basket/:id", w: 3, run: async () =>
      authed("GET /rest/basket/:id", "GET", `/rest/basket/${state.bid}`, {}, [200]) },
  { key: "GET /api/Orders", w: 2, run: async () => authed("GET /api/Orders", "GET", "/api/Orders", {}, [200]) },

  // ---- writes (skipped with --no-writes) ----
  { key: "POST /api/Users", w: 1, write: true, run: async () => {
      const email = `visitor+${Date.now().toString(36)}${rand(1000)}@pimenta.fun`;
      record("POST /api/Users", await http("POST", "/api/Users", { body: { email, password: "Visitor-" + rand(1e6) } }), [201]);
    } },
  { key: "PUT /api/Products/:id", w: 1, write: true, run: async () => {
      // Read then write back the same values: exercises PUT without changing data.
      const id = await productId();
      const cur = await http("GET", `/api/Products/${id}`);
      record("GET /api/Products/:id", cur, [200]);
      const p = cur.json?.data;
      if (!p) return;
      await authed("PUT /api/Products/:id", "PUT", `/api/Products/${id}`,
        { body: { name: p.name, description: p.description, price: p.price, emoji: p.emoji } }, [200]);
    } },
  { key: "POST /api/BasketItems", w: 3, write: true, run: async () => {
      const id = await productId();
      const r = await authed("POST /api/BasketItems", "POST", "/api/BasketItems", { body: { ProductId: id, quantity: 1 + rand(3) } }, [201]);
      if (r?.status === 201) state.basketCount++;
    } },
  { key: "POST /rest/basket/:id/checkout", w: 1, write: true, run: async () => {
      if (!state.basketCount) {
        const id = await productId();
        const add = await authed("POST /api/BasketItems", "POST", "/api/BasketItems", { body: { ProductId: id, quantity: 1 } }, [201]);
        if (add?.status === 201) state.basketCount++;
      }
      const r = await authed("POST /rest/basket/:id/checkout", "POST", `/rest/basket/${state.bid}/checkout`, { body: {} }, [200, 400]);
      if (r?.status === 200 || r?.status === 400) state.basketCount = 0;
    } },
  { key: "POST /api/Feedbacks", w: 1, write: true, run: async () => {
      const useAuth = Math.random() < 0.5;
      const body = { comment: `${pick(COMMENTS)} (traffic bot)`, rating: 1 + rand(5) };
      if (useAuth) await authed("POST /api/Feedbacks", "POST", "/api/Feedbacks", { body }, [201]);
      else record("POST /api/Feedbacks", await http("POST", "/api/Feedbacks", { body }), [201]);
    } }
];

// Intentional negative traffic (expected 4xx).
const NEGATIVE = [
  { key: "NEG GET /api/Products/:id (404)", run: async () =>
      record("NEG GET /api/Products/:id (404)", await http("GET", `/api/Products/${90000 + rand(9999)}`), [404]) },
  { key: "NEG GET /rest/user/whoami (no token)", run: async () =>
      record("NEG GET /rest/user/whoami (no token)", await http("GET", "/rest/user/whoami", { token: null }), [401]) },
  { key: "NEG GET /rest/user/whoami (bad token)", run: async () =>
      record("NEG GET /rest/user/whoami (bad token)", await http("GET", "/rest/user/whoami", { token: "invalid.jwt.token" }), [401]) },
  { key: "NEG POST /rest/user/login (bad password)", run: async () =>
      record("NEG POST /rest/user/login (bad password)", await http("POST", "/rest/user/login", { body: { email: "nobody@pimenta.fun", password: "wrong" } }), [401]) },
  { key: "NEG GET /unknown (404)", run: async () =>
      record("NEG GET /unknown (404)", await http("GET", `/api/Unknown${rand(100)}`), [404]) }
];

const ACTIVE = ENDPOINTS.filter((e) => WRITES || !e.write);

// Shuffled deck: guarantees every endpoint is hit once per cycle, in random order.
let deck = [];
function draw() {
  if (Math.random() < ERROR_RATE) return pick(NEGATIVE);
  if (!deck.length) {
    deck = ACTIVE.flatMap((e) => Array(e.w).fill(e));
    for (let i = deck.length - 1; i > 0; i--) { const j = rand(i + 1); [deck[i], deck[j]] = [deck[j], deck[i]]; }
  }
  return deck.pop();
}

// ---- reporting ---------------------------------------------------------------
const started = Date.now();
function summary(final = false) {
  const keys = [...stats.keys()].sort();
  const lines = [];
  lines.push(`${C.b}${final ? "Final" : "Running"} summary${C.n} after ${fmtDur(Date.now() - started)} - ${total} requests, token: ${state.tokenSource || "none"}`);
  lines.push(`${"endpoint".padEnd(44)} ${"count".padStart(6)} ${"ok".padStart(6)} ${"fail".padStart(5)} ${"avg ms".padStart(7)}  status codes`);
  for (const k of keys) {
    const s = stats.get(k);
    const codes = Object.entries(s.codes).map(([c, n]) => `${c}x${n}`).join(" ");
    lines.push(`${k.padEnd(44)} ${String(s.n).padStart(6)} ${String(s.ok).padStart(6)} ${(s.err ? C.r : "") + String(s.err).padStart(5) + C.n} ${String(Math.round(s.ms / s.n)).padStart(7)}  ${codes}`);
  }
  const missing = ACTIVE.filter((e) => !stats.has(e.key)).map((e) => e.key);
  if (missing.length) lines.push(`${C.y}not hit yet: ${missing.join(", ")}${C.n}`);
  lines.push(`${C.d}* = Cloudflare challenge page instead of API JSON${C.n}`);
  if (JSON_OUT) {
    console.log(JSON.stringify({ summary: final ? "final" : "running", elapsedMs: Date.now() - started, total,
      endpoints: Object.fromEntries(keys.map((k) => [k, stats.get(k)])), missing }));
  } else console.log("\n" + lines.join("\n") + "\n");
}

let stopping = false;
function stop() {
  if (stopping) process.exit(0);
  stopping = true;
  summary(true);
  process.exit(0);
}
process.on("SIGINT", stop);
process.on("SIGTERM", stop);

// ---- main loop -----------------------------------------------------------------
async function main() {
  const perDay = Math.round(RPM * 60 * 24);
  if (!JSON_OUT) {
    console.log(`${C.b}Pimenta API traffic generator${C.n}`);
    console.log(`Target   : ${BASE}`);
    console.log(`Rate     : ~${RPM} req/min average (~${perDay.toLocaleString()}/day)${CURVE ? ", day/night curve (x0.3 at 04:00 .. x1.7 at 16:00)" : ", flat"}`);
    console.log(`Duration : ${DURATION ? fmtDur(DURATION) : "forever"}`);
    console.log(`Endpoints: ${ACTIVE.length} routes${WRITES ? "" : " (read-only, --no-writes)"}, negative share ${Math.round(ERROR_RATE * 100)}%`);
    console.log(`Header   : api_key=${API_KEY}`);
    console.log("-".repeat(78));
  }

  if (DRY) {
    let t = Date.now();
    for (let i = 0; i < 25; i++) {
      t += nextGap();
      const e = draw();
      console.log(`${new Date(t).toISOString().slice(11, 19)}  ${e.key}`);
    }
    return;
  }

  // The first deck already covers every endpoint in random order; after that
  // the deck is reshuffled and traffic continues at the random rate.
  await login();
  let nextStats = Date.now() + STATS_EVERY;
  while (!stopping) {
    if (DURATION && Date.now() - started >= DURATION) break;
    const e = draw();
    try { await e.run(); } catch (err) { console.error(`${C.r}[${e.key}] ${err.message}${C.n}`); }
    if (STATS_EVERY && Date.now() >= nextStats) { summary(); nextStats = Date.now() + STATS_EVERY; }
    await sleep(nextGap());
  }
  summary(true);
}

main().catch((e) => { console.error(e); process.exit(1); });
