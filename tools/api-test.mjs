#!/usr/bin/env node
// ---------------------------------------------------------------------------
// api-test.mjs — functional test runner for the Pimenta API (api.pimenta.fun)
//
// Unlike tools/smoke-test.sh (which only asserts HTTP status codes), this
// checks the actual JSON response *shapes* and runs the full flow:
//   login -> whoami -> update product -> add to basket -> checkout -> orders
// plus public endpoints and negative (auth / 404) cases. Reports per-request
// latency and exits non-zero if anything fails.
//
// Zero dependencies — uses Node's built-in global fetch (Node 18+).
//
// Usage:
//   node tools/api-test.mjs [BASE_URL] [EMAIL] [PASSWORD] [flags]
//   ./tools/api-test.mjs                         # defaults to api.pimenta.fun
//   ./tools/api-test.mjs http://127.0.0.1:3000   # test the local backend
//   ./tools/api-test.mjs --json                  # machine-readable output
//
// Flags:
//   --json            emit a JSON report instead of pretty lines
//   --verbose, -v     print a response-body snippet for every test
//   --no-color        disable ANSI colours
//   --timeout=MS      per-request timeout (default 10000)
//   --help, -h        show this help
//
// Exit code: 0 if all tests pass, 1 otherwise.
// ---------------------------------------------------------------------------

const argv = process.argv.slice(2);
if (argv.includes("--help") || argv.includes("-h")) {
  console.log(readHelp());
  process.exit(0);
}

const FLAGS = new Set(argv.filter((a) => a.startsWith("-")));
const POS = argv.filter((a) => !a.startsWith("-"));

const BASE = (POS[0] || process.env.API_BASE || "https://api.pimenta.fun").replace(/\/+$/, "");
const EMAIL = POS[1] || process.env.API_EMAIL || "admin@juice-sh.op";
const PASSWORD = POS[2] || process.env.API_PASSWORD || "admin123";
const JSON_OUT = FLAGS.has("--json");
const VERBOSE = FLAGS.has("--verbose") || FLAGS.has("-v");
const TIMEOUT = Number((argv.find((a) => a.startsWith("--timeout=")) || "").split("=")[1]) || 10000;
const useColor = !FLAGS.has("--no-color") && process.stdout.isTTY && !JSON_OUT;

const C = useColor
  ? { g: "\x1b[32m", r: "\x1b[31m", y: "\x1b[33m", d: "\x1b[2m", b: "\x1b[1m", n: "\x1b[0m" }
  : { g: "", r: "", y: "", d: "", b: "", n: "" };

const results = [];
const state = {}; // shared captures (token, ids, ...)

// ---- HTTP helper ----------------------------------------------------------
async function req(method, path, { token, body, headers = {} } = {}) {
  const url = BASE + path;
  const opts = { method, headers: { Accept: "application/json", ...headers } };
  if (token) opts.headers.Authorization = "Bearer " + token;
  if (body !== undefined) {
    opts.headers["Content-Type"] = "application/json";
    opts.body = JSON.stringify(body);
  }
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TIMEOUT);
  opts.signal = ac.signal;
  const t0 = Date.now();
  let status = 0, text = "", json = null, err = null, ctype = "";
  try {
    const res = await fetch(url, opts);
    status = res.status;
    ctype = res.headers.get("content-type") || "";
    text = await res.text();
    try { json = JSON.parse(text); } catch (_) { /* non-JSON */ }
  } catch (e) {
    err = e.name === "AbortError" ? `timeout after ${TIMEOUT}ms` : e.message;
  } finally {
    clearTimeout(timer);
  }
  return { method, path, url, status, ctype, text, json, ms: Date.now() - t0, err };
}

// ---- assertions (throw on failure) ----------------------------------------
function status(r, code) {
  if (r.err) throw new Error(`request error: ${r.err}`);
  if (r.status !== code) throw new Error(`status ${r.status}, want ${code}`);
}
function isJson(r) {
  if (r.json == null) throw new Error(`expected JSON, got ${r.ctype || "?"}: ${r.text.slice(0, 60)}`);
}
function get(obj, path) {
  return path.split(".").reduce((o, k) => (o == null ? undefined : o[k]), obj);
}
function field(r, path) {
  const v = get(r.json, path);
  if (v === undefined) throw new Error(`missing field "${path}"`);
  return v;
}
function eq(actual, expected, label) {
  if (actual !== expected) throw new Error(`${label}: got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);
}
function arr(r, path) {
  const v = field(r, path);
  if (!Array.isArray(v)) throw new Error(`"${path}" is not an array`);
  return v;
}

// ---- test runner ----------------------------------------------------------
async function check(name, method, path, opts, assertFn) {
  const r = await req(method, path, opts);
  let ok = true, reason = "";
  try { assertFn(r); } catch (e) { ok = false; reason = e.message; }
  const rec = { name, method, path, status: r.status, ms: r.ms, ok, reason, snippet: (r.text || "").replace(/\s+/g, " ").slice(0, 160) };
  results.push(rec);
  if (!JSON_OUT) print(rec);
  return r;
}

function print(rec) {
  const tag = rec.ok ? `${C.g} PASS ${C.n}` : `${C.r} FAIL ${C.n}`;
  const line = `${tag} ${rec.method.padEnd(4)} ${rec.path.padEnd(34)} ${C.d}${String(rec.status).padStart(3)}  ${String(rec.ms).padStart(4)}ms${C.n}`;
  console.log(line + (rec.ok ? "" : `  ${C.r}${rec.reason}${C.n}`));
  if (!rec.ok || VERBOSE) console.log(`        ${C.d}${rec.snippet}${C.n}`);
}

function section(title) { if (!JSON_OUT) console.log(`\n${C.y}${C.b}${title}${C.n}`); }

// ---- the test plan --------------------------------------------------------
async function run() {
  if (!JSON_OUT) {
    console.log(`${C.b}Pimenta API functional test${C.n}`);
    console.log(`Target : ${BASE}`);
    console.log(`As     : ${EMAIL}`);
    console.log("------------------------------------------------------------");
  }

  section("Public endpoints");
  await check("health", "GET", "/health", {}, (r) => {
    status(r, 200); isJson(r); eq(field(r, "status"), "ok", "status"); field(r, "counts.products");
  });
  await check("app-version", "GET", "/rest/admin/application-version", {}, (r) => {
    status(r, 200); isJson(r); field(r, "version");
  });
  const prods = await check("list products", "GET", "/api/Products", {}, (r) => {
    status(r, 200); const d = arr(r, "data"); if (d.length === 0) throw new Error("no products");
  });
  state.productId = get(prods.json, "data.0.id") ?? 1;
  await check("get product", "GET", `/api/Products/${state.productId}`, {}, (r) => {
    status(r, 200); field(r, "data.id"); field(r, "data.price");
  });
  await check("product 404", "GET", "/api/Products/999999", {}, (r) => {
    status(r, 404); isJson(r); field(r, "error");
  });
  await check("search", "GET", "/rest/products/search?q=a", {}, (r) => { status(r, 200); arr(r, "data"); });
  await check("feedbacks", "GET", "/api/Feedbacks", {}, (r) => { status(r, 200); arr(r, "data"); });
  await check("post feedback", "POST", "/api/Feedbacks", { body: { comment: "api-test", rating: 5 } }, (r) => {
    status(r, 201); field(r, "data.id");
  });

  section("Authentication");
  await check("login (bad creds)", "POST", "/rest/user/login", { body: { email: "x@y.z", password: "nope" } }, (r) => {
    status(r, 401); isJson(r); field(r, "error");
  });
  const login = await check("login (ok)", "POST", "/rest/user/login", { body: { email: EMAIL, password: PASSWORD } }, (r) => {
    status(r, 200); const t = field(r, "authentication.token"); if (!t) throw new Error("empty token");
  });
  state.token = get(login.json, "authentication.token") || "";

  section("Auth required — must reject anonymous (401)");
  await check("whoami (anon)", "GET", "/rest/user/whoami", {}, (r) => status(r, 401));
  await check("users/1 (anon)", "GET", "/api/Users/1", {}, (r) => status(r, 401));
  await check("orders (anon)", "GET", "/api/Orders", {}, (r) => status(r, 401));
  await check("basket (anon)", "GET", "/rest/basket/0", {}, (r) => status(r, 401));
  await check("add item (anon)", "POST", "/api/BasketItems", { body: { ProductId: 1, quantity: 1 } }, (r) => status(r, 401));

  section("Auth required — with token");
  const tk = { token: state.token };
  await check("whoami", "GET", "/rest/user/whoami", tk, (r) => {
    status(r, 200); eq(field(r, "user.email"), EMAIL, "user.email");
  });
  await check("users/1", "GET", "/api/Users/1", tk, (r) => { status(r, 200); field(r, "data.id"); });
  await check("update product", "PUT", `/api/Products/${state.productId}`, { token: state.token, body: { description: "api-test update", price: 9.99 } }, (r) => {
    status(r, 200); eq(field(r, "data.price"), 9.99, "data.price");
  });
  await check("add to basket", "POST", "/api/BasketItems", { token: state.token, body: { ProductId: state.productId, quantity: 2 } }, (r) => {
    status(r, 201); field(r, "data.ProductId");
  });
  await check("view basket", "GET", "/rest/basket/0", tk, (r) => {
    status(r, 200); const items = arr(r, "data.items"); if (items.length === 0) throw new Error("basket empty after add");
    if (typeof field(r, "data.total") !== "number") throw new Error("total is not a number");
  });
  const co = await check("checkout", "POST", "/rest/basket/0/checkout", tk, (r) => {
    status(r, 200); const id = field(r, "data.orderId"); if (!String(id).startsWith("PIM-")) throw new Error(`orderId "${id}" not PIM-*`);
  });
  state.orderId = get(co.json, "data.orderId");
  await check("orders", "GET", "/api/Orders", tk, (r) => {
    status(r, 200); const o = arr(r, "data"); if (o.length === 0) throw new Error("no orders after checkout");
  });
  const email = `api-test-${Date.now()}@pimenta.fun`;
  await check("register", "POST", "/api/Users", { body: { email, password: "Passw0rd!" } }, (r) => {
    status(r, 201); eq(field(r, "data.email"), email, "data.email");
  });

  section("Negative / routing checks");
  await check("wrong method", "DELETE", `/api/Products/${state.productId}`, tk, (r) => status(r, 404));
  await check("unknown route", "GET", "/api/DoesNotExist", {}, (r) => {
    status(r, 404); isJson(r); eq(field(r, "error"), "Not found", "error");
  });

  // ---- summary ----
  const passed = results.filter((r) => r.ok).length;
  const failed = results.length - passed;
  const totalMs = results.reduce((s, r) => s + r.ms, 0);
  const avg = results.length ? Math.round(totalMs / results.length) : 0;

  if (JSON_OUT) {
    console.log(JSON.stringify({ base: BASE, email: EMAIL, passed, failed, total: results.length, avgMs: avg, results }, null, 2));
  } else {
    console.log("------------------------------------------------------------");
    const head = failed === 0 ? `${C.g}${C.b}ALL PASSED${C.n}` : `${C.r}${C.b}${failed} FAILED${C.n}`;
    console.log(`${head}  ${passed}/${results.length} passed  ${C.d}(avg ${avg}ms/req)${C.n}`);
    if (!state.token) console.log(`${C.y}note: no token was acquired — check the backend is up and credentials are correct.${C.n}`);
  }
  process.exit(failed === 0 ? 0 : 1);
}

function readHelp() {
  return `api-test.mjs — functional tester for the Pimenta API

Usage:
  node tools/api-test.mjs [BASE_URL] [EMAIL] [PASSWORD] [flags]

Defaults:
  BASE_URL  https://api.pimenta.fun   (or $API_BASE)
  EMAIL     admin@juice-sh.op         (or $API_EMAIL)
  PASSWORD  admin123                  (or $API_PASSWORD)

Flags:
  --json          machine-readable JSON report
  --verbose, -v   show a body snippet for every test
  --no-color      disable ANSI colours
  --timeout=MS    per-request timeout (default 10000)
  --help, -h      this help

Exit code 0 = all passed, 1 = one or more failed.`;
}

run().catch((e) => {
  console.error(`fatal: ${e.stack || e.message}`);
  process.exit(1);
});
