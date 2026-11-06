/**
 * traffic-cron — scheduled Worker that generates background traffic for the lab.
 *
 * Every 5 minutes (see wrangler.toml) it sends a random batch of requests to:
 *   - www.pimenta.fun : every lab page (static HTML under www/)
 *   - api.pimenta.fun : every API route in backend/server.js
 *
 * Goals: keep Cloudflare analytics / Security Events populated around the clock
 * and let API Shield Endpoint Discovery + Schema Learning see every endpoint.
 *
 *  - Random order, full coverage: endpoints are drawn from a shuffled deck that
 *    is reshuffled every run; over a day every endpoint is hit many times.
 *  - Day/night curve: batch size follows local time (TZ var), ~x0.3 at 04:00,
 *    ~x1.7 at 16:00.
 *  - Realistic flows: login -> JWT for authenticated routes, add to basket
 *    before checkout, PUT writes back current product values (no data change).
 *  - Varied clients: random User-Agent, Accept-Language, Referer per request.
 *
 * Source IP: subrequests from a Worker always leave from Cloudflare's Workers
 * egress address, so the zone sees ONE client IP for this traffic. A Worker
 * cannot choose or spoof its source IP. For multi-IP traffic run
 * tools/api-traffic.mjs from several hosts/networks in addition to this cron.
 *
 * Limits: stays under 50 subrequests per invocation (Workers Free limit).
 */

const WWW = "https://www.pimenta.fun";
const API = "https://api.pimenta.fun";

// All static lab pages (generated from www/**/index.html). Rate-limit and
// challenge test paths are excluded so the single Workers egress IP is not
// rate-limited or challenged for all other traffic.
const PAGES = [
  "/", "/aegis-lab/", "/agent-ready/", "/agent/", "/ai-lab/", "/ai-lab/slides/",
  "/api-backend-guide/", "/api-shield/", "/api-shield/sequence/page1/",
  "/api-shield/sequence/page2/", "/api-shield/sequence/page3/", "/blog/",
  "/cache/cache-worker/", "/cache/cloudflare-cdn-cache-control/", "/cache/edge-24h/",
  "/cache/edge-5min/", "/cf-echo/", "/challenges/jwt/", "/challenges/mtls/",
  "/content-scanning-lab/", "/ddns/", "/deploy/", "/docs/", "/edge-inspector/",
  "/error/error404/", "/forms/signup/", "/images-lab/", "/load-balancer-guide/",
  "/login-demo/", "/magic-transit-guide/", "/maintenance-snippets/", "/media/upload/",
  "/mtls-guide/", "/page-shield-guide/", "/page-shield-login/", "/page-shield/",
  "/page-shield/page-shield-lab/", "/page-shield/page-shield-origin/",
  "/page-shield/page-shield-origin/origin-demo.js", "/precursor-lab/", "/redirect-rules/",
  "/sample/", "/security-solutions/e-commerce/", "/security-solutions/firewall-for-ai-llm/",
  "/security-solutions/password-spraying/", "/static-ip-byoip-guide/", "/transform-rules/",
  "/turnstile/injection-worker/", "/turnstile/invisible/", "/turnstile/login/",
  "/turnstile/managed/", "/turnstile/non-interactive/", "/workers-snippets-guide/",
  "/zaraz/", "/assets/docs.css", "/assets/lab.css", "/robots.txt", "/cdn-cgi/trace",
];

const UAS = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_6) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Safari/605.1.15",
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148",
  "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Mobile Safari/537.36",
  "Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0",
  "PimentaShop/2.3 (Android 14; Pixel 8)",
  "pimenta-traffic-cron/1.0 (+https://www.pimenta.fun)",
];
const LANGS = ["en-US,en;q=0.9", "pt-PT,pt;q=0.9,en;q=0.6", "es-ES,es;q=0.9", "fr-FR,fr;q=0.8,en;q=0.5", "de-DE,de;q=0.9"];
const TERMS = ["", "apple", "juice", "pepper", "shirt", "mug", "sticker", "green", "box", "lab"];
const COMMENTS = ["Great service!", "Fast delivery", "Could be cheaper", "Love the lab", "Five stars"];

const rand = (n) => Math.floor(Math.random() * n);
const pick = (a) => a[rand(a.length)];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function hourIn(tz) {
  try {
    return Number(new Intl.DateTimeFormat("en-GB", { hour: "numeric", hour12: false, timeZone: tz }).format(new Date()));
  } catch (_) { return new Date().getUTCHours(); }
}
const curve = (h) => 1 + 0.7 * Math.sin((2 * Math.PI * (h - 10)) / 24);

/** Per-run context: shared token, counters, budget. */
function makeRun(env) {
  const budget = Math.min(48, Number(env.MAX_SUBREQUESTS || 48));
  const run = { env, used: 0, budget, token: null, bid: 1, products: [], basket: 0, stats: {}, log: [] };

  run.http = async (base, method, path, { body, auth, token, label } = {}) => {
    if (run.used >= run.budget) return null;
    run.used++;
    const headers = {
      "User-Agent": pick(UAS),
      "Accept-Language": pick(LANGS),
      Accept: base === API ? "application/json" : "text/html,application/xhtml+xml,*/*;q=0.8",
      "X-Lab-Traffic": "traffic-cron",
    };
    if (base === API) headers.api_key = env.API_KEY || "12345";
    else if (Math.random() < 0.6) headers.Referer = WWW + pick(PAGES);
    const t = token !== undefined ? token : auth ? run.token : null;
    if (t) headers.Authorization = "Bearer " + t;
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const t0 = Date.now();
    let status = 0, json = null;
    try {
      const res = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), redirect: "manual" });
      status = res.status;
      const text = await res.text();
      if (base === API) { try { json = JSON.parse(text); } catch (_) {} }
    } catch (e) {
      status = "ERR";
    }
    const key = label || `${method} ${base === API ? "api" : "www"}${path.split("?")[0]}`;
    const s = (run.stats[key] = run.stats[key] || {});
    s[status] = (s[status] || 0) + 1;
    run.log.push(`${status} ${method} ${base.replace("https://", "")}${path} ${Date.now() - t0}ms`);
    return { status, json };
  };

  run.login = async () => {
    if (run.token) return true;
    const email = env.API_EMAIL || "tpimentacf@gmail.com";
    const password = env.API_PASSWORD || "1z1muef2";
    const r = await run.http(API, "POST", "/rest/user/login", { body: { email, password } });
    if (r && r.status === 200 && r.json?.authentication?.token) {
      run.token = r.json.authentication.token;
      run.bid = r.json.authentication.bid || 1;
      return true;
    }
    return false;
  };

  run.authed = async (method, path, opts = {}, label) => {
    if (!(await run.login())) return null;
    return run.http(API, method, path, { ...opts, auth: true, label });
  };

  run.productId = async () => {
    if (!run.products.length) {
      const r = await run.http(API, "GET", "/api/Products");
      run.products = (r?.json?.data || []).map((p) => p.id);
    }
    return run.products.length ? pick(run.products) : 1;
  };
  return run;
}

// ---- API endpoints (all 16 routes of backend/server.js) -------------------
const API_ENDPOINTS = [
  { w: 3, run: (r) => r.http(API, "GET", "/health") },
  { w: 1, run: (r) => r.http(API, "GET", "/rest/admin/application-version") },
  { w: 5, run: async (r) => {
      const x = await r.http(API, "GET", "/api/Products");
      if (x?.json?.data) r.products = x.json.data.map((p) => p.id);
    } },
  { w: 5, run: async (r) => r.http(API, "GET", `/api/Products/${await r.productId()}`, { label: "GET api/api/Products/:id" }) },
  { w: 4, run: (r) => r.http(API, "GET", `/rest/products/search?q=${encodeURIComponent(pick(TERMS))}`) },
  { w: 3, run: (r) => r.http(API, "GET", "/api/Feedbacks") },
  { w: 2, run: (r) => { r.token = null; return r.login(); } },
  { w: 3, run: (r) => r.authed("GET", "/rest/user/whoami") },
  { w: 2, run: (r) => r.authed("GET", `/api/Users/${1 + rand(5)}`, {}, "GET api/api/Users/:id") },
  { w: 3, run: async (r) => { await r.login(); return r.authed("GET", `/rest/basket/${r.bid}`, {}, "GET api/rest/basket/:id"); } },
  { w: 2, run: (r) => r.authed("GET", "/api/Orders") },
  { w: 3, run: async (r) => {
      const x = await r.authed("POST", "/api/BasketItems", { body: { ProductId: await r.productId(), quantity: 1 + rand(3) } });
      if (x?.status === 201) r.basket++;
    } },
  { w: 1, run: async (r) => {
      if (!r.basket) {
        const x = await r.authed("POST", "/api/BasketItems", { body: { ProductId: await r.productId(), quantity: 1 } });
        if (x?.status === 201) r.basket++;
      }
      await r.authed("POST", `/rest/basket/${r.bid}/checkout`, { body: {} }, "POST api/rest/basket/:id/checkout");
      r.basket = 0;
    } },
  { w: 1, run: async (r) => {
      // read, then write back the same values: exercises PUT without changing data
      const id = await r.productId();
      const cur = await r.http(API, "GET", `/api/Products/${id}`, { label: "GET api/api/Products/:id" });
      const p = cur?.json?.data;
      if (p) await r.authed("PUT", `/api/Products/${id}`, { body: { name: p.name, description: p.description, price: p.price, emoji: p.emoji } }, "PUT api/api/Products/:id");
    } },
  { w: 1, run: (r) => (Math.random() < 0.5
      ? r.http(API, "POST", "/api/Feedbacks", { body: { comment: `${pick(COMMENTS)} (traffic cron)`, rating: 1 + rand(5) } })
      : r.authed("POST", "/api/Feedbacks", { body: { comment: `${pick(COMMENTS)} (traffic cron)`, rating: 1 + rand(5) } })) },
  { w: 0.3, run: (r) => r.http(API, "POST", "/api/Users", {
      body: { email: `visitor+${Date.now().toString(36)}${rand(1000)}@pimenta.fun`, password: "Visitor-" + rand(1e6) } }) },
  // negative traffic (expected 4xx) - also useful for API Shield / WAF analytics
  { w: 0.5, run: (r) => r.http(API, "GET", `/api/Products/${90000 + rand(9999)}`, { label: "NEG 404 product" }) },
  { w: 0.5, run: (r) => r.http(API, "GET", "/rest/user/whoami", { token: null, label: "NEG 401 whoami" }) },
];

function buildDeck() {
  const deck = [];
  for (const e of API_ENDPOINTS) {
    const n = e.w >= 1 ? e.w : Math.random() < e.w ? 1 : 0;
    for (let i = 0; i < n; i++) deck.push({ kind: "api", e });
  }
  for (const p of PAGES) deck.push({ kind: "www", p });
  for (let i = deck.length - 1; i > 0; i--) { const j = rand(i + 1); [deck[i], deck[j]] = [deck[j], deck[i]]; }
  return deck;
}

async function runBatch(env, reason) {
  const h = hourIn(env.TZ || "Europe/Lisbon");
  const base = Number(env.BATCH_SIZE || 20);
  const target = Math.max(3, Math.round(base * curve(h) * (0.6 + Math.random() * 0.8)));
  const run = makeRun(env);
  const deck = buildDeck();
  let done = 0;
  while (done < target && deck.length && run.used < run.budget) {
    const item = deck.pop();
    try {
      if (item.kind === "www") await run.http(WWW, "GET", item.p);
      else await item.e.run(run);
    } catch (e) {
      run.log.push(`ERR ${e.message}`);
    }
    done++;
    await sleep(200 + rand(2500)); // spread requests inside the run
  }
  console.log(JSON.stringify({ reason, hour: h, target, actions: done, subrequests: run.used, stats: run.stats }));
  return run;
}

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runBatch(env, event.cron));
  },

  // Optional manual trigger on workers.dev: GET /run?key=<RUN_KEY>
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/run" && env.RUN_KEY && url.searchParams.get("key") === env.RUN_KEY) {
      const run = await runBatch(env, "manual");
      return new Response(JSON.stringify({ subrequests: run.used, stats: run.stats, log: run.log }, null, 2), {
        headers: { "content-type": "application/json" },
      });
    }
    return new Response("traffic-cron: scheduled worker\n", { status: 404 });
  },
};
