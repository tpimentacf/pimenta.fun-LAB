#!/usr/bin/env node
// Generates default Pimenta lab test pages under ../www.
// Re-runnable (overwrites). Usage: node tools/scaffold-tests.js [wwwDir]

const fs = require("fs");
const path = require("path");

const ROOT = process.argv[2] || path.join(__dirname, "..", "www");

function page({ file, title, crumb, tag, h1, body, headExtra = "", script = "" }) {
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${title} &mdash; Pimenta Lab</title>
  <link rel="stylesheet" href="/assets/lab.css" />
${headExtra}</head>
<body>
  <header class="lab">
    <div class="brand">pimenta<span>.fun</span> lab</div>
    <nav>
      <a href="https://www.pimenta.fun">Home</a>
      <a href="https://www.pimenta.fun/#tests">Tests</a>
    </nav>
  </header>

  <main class="lab">
    <div class="crumb">${crumb}</div>
    ${tag ? '<span class="tag">' + tag + "</span>" : ""}
    <h1>${h1}</h1>
${body}
  </main>

  <footer class="lab">
    Pimenta lab &middot; <a href="https://www.pimenta.fun/#tests">back to tests</a>
  </footer>
${script ? "  <script>\n" + script + "\n  </script>\n" : ""}</body>
</html>
`;
  const full = path.join(ROOT, file);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, html);
  console.log("wrote", file);
}

const crumb = (cat, name) =>
  '<a href="https://www.pimenta.fun/#tests">Tests</a> / ' + cat + " / " + name;

// ---------------------------------------------------------------------------
// Error pages
// ---------------------------------------------------------------------------
const errors = [
  ["403", "Forbidden", "You don't have permission to access this resource."],
  ["404", "Not Found", "The page you requested could not be found."],
  ["406", "Not Acceptable", "The server can't produce a response matching the request's Accept headers."],
  ["502", "Bad Gateway", "The origin returned an invalid response."],
];
errors.forEach(([code, label, desc]) => {
  page({
    file: `error/error${code}/index.html`,
    title: `${code} ${label}`,
    crumb: crumb("Error Pages", code),
    tag: "Error page",
    h1: `<span class="grad">${code}</span> ${label}`,
    body:
      '    <div class="center"><div class="big-code">' + code + "</div></div>\n" +
      "    <p class=\"lead center\">" + desc + "</p>\n" +
      '    <div class="note">Use this as a <strong>Custom Error Response</strong> page in Cloudflare for HTTP ' + code +
      ", or return it from a WAF/Origin rule.</div>\n" +
      '    <p class="center"><a class="btn" href="https://www.pimenta.fun">Back to home</a></p>',
  });
});

// 204 maintenance
page({
  file: "error/error204/index.html",
  title: "204 No Content",
  crumb: crumb("Maintenance", "Origin Response 204"),
  tag: "Maintenance",
  h1: '<span class="grad">204</span> No Content',
  body:
    '    <p class="lead">This route is configured to return <code class="inline">204 No Content</code>.</p>\n' +
    '    <div class="note">A 204 is handy for maintenance toggles, health probes, or silencing beacons. There is intentionally no body.</div>',
});

// Cloudflare default block page (mock)
page({
  file: "error/block/index.html",
  title: "Blocked",
  crumb: crumb("Error Pages", "Block page"),
  tag: "Security",
  h1: "Sorry, you have been <span class=\"grad\">blocked</span>",
  body:
    '    <p class="lead">You are unable to access this site.</p>\n' +
    '    <div class="warn">Mock of a Cloudflare security block page. In production this is served automatically when a WAF or custom rule action is <strong>Block</strong>. It typically shows a Ray ID and your IP.</div>\n' +
    "    <pre>Ray ID: 8f0000000000abcd\nYour IP: 203.0.113.10\nAction: block (managed rule)</pre>",
});

// ---------------------------------------------------------------------------
// Challenge landing pages (the page itself is normal; CF injects the challenge)
// ---------------------------------------------------------------------------
const challenges = [
  ["managed", "Managed Challenge", "Cloudflare automatically chooses the best challenge (JS, interactive, or none)."],
  ["javascript", "JS Challenge", "A non-interactive JavaScript challenge runs before this page loads."],
  ["interactive", "Interactive Challenge", "The visitor must interact (e.g. click) to proceed."],
  ["jwt", "JWT Validation", "Protected by a JWT validation rule (API Shield / Access)."],
  ["mtls", "mTLS", "Requires a valid client certificate (mutual TLS)."],
];
challenges.forEach(([slug, name, desc]) => {
  page({
    file: `challenges/${slug}/index.html`,
    title: name,
    crumb: crumb("Challenges", name),
    tag: "Challenge",
    h1: name.replace(name.split(" ")[0], '<span class="grad">' + name.split(" ")[0] + "</span>"),
    body:
      '    <div class="ok">&#10003; If you can read this, you passed the <strong>' + name + "</strong>.</div>\n" +
      "    <p>" + desc + "</p>\n" +
      '    <div class="note">Configure this in the Cloudflare dashboard: <em>Security &rarr; WAF &rarr; Custom rules</em> ' +
      "(action: <code class=\"inline\">" + (slug === "mtls" ? "mTLS / Access" : slug === "jwt" ? "JWT validation" : "Managed/JS/Interactive Challenge") +
      "</code>) scoped to this path.</div>",
  });
});

// ---------------------------------------------------------------------------
// Rate limiting testers
// ---------------------------------------------------------------------------
const rls = [
  ["5r1m", "5 Requests / 1 Minute", "Fire requests at this path; the 6th within a minute should be rate-limited."],
  ["throttle", "5 Req / 1 Min (Throttle)", "Throttle action slows excess requests instead of blocking outright."],
  ["worker-rl", "Rate Limit by Worker", "A Worker enforces the limit using the Rate Limiting binding."],
];
const hammer =
  "    var n = 0;\n" +
  "    function hit() {\n" +
  "      n++;\n" +
  "      var idx = n;\n" +
  "      var t0 = performance.now();\n" +
  "      fetch(location.href, { cache: 'no-store' }).then(function (r) {\n" +
  "        log(idx, r.status, Math.round(performance.now() - t0));\n" +
  "      }).catch(function (e) { log(idx, 'ERR', '-'); });\n" +
  "    }\n" +
  "    function burst(k) { for (var i = 0; i < k; i++) hit(); }\n" +
  "    function log(idx, status, ms) {\n" +
  "      var cls = (status === 429) ? 'warn' : 'ok';\n" +
  "      var el = document.getElementById('log');\n" +
  "      var line = document.createElement('div');\n" +
  "      line.textContent = '#' + idx + '  ->  ' + status + '  (' + ms + ' ms)';\n" +
  "      line.style.color = (status === 429) ? '#ffc4c4' : '#b6f5dc';\n" +
  "      el.prepend(line);\n" +
  "    }\n" +
  "    document.getElementById('one').addEventListener('click', function () { hit(); });\n" +
  "    document.getElementById('ten').addEventListener('click', function () { burst(10); });";
rls.forEach(([slug, name, desc]) => {
  page({
    file: `ratelimiting/${slug}/index.html`,
    title: name,
    crumb: crumb("Rate Limiting", name),
    tag: "Rate limiting",
    h1: name,
    body:
      "    <p class=\"lead\">" + desc + "</p>\n" +
      '    <div class="panel">\n' +
      '      <button class="btn" id="one">Send 1 request</button>\n' +
      '      &nbsp; <button class="btn ghost" id="ten">Burst 10</button>\n' +
      '      <h2>Responses (newest first)</h2>\n' +
      '      <div id="log"></div>\n' +
      "    </div>\n" +
      '    <div class="note">Watch for HTTP <code class="inline">429 Too Many Requests</code> once the configured threshold is exceeded.</div>',
    script: hammer,
  });
});

// ---------------------------------------------------------------------------
// Turnstile variants
// ---------------------------------------------------------------------------
const tsHead = '  <script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>\n';
const tsVariants = [
  ["non-interactive", "Non-Interactive", 'data-sitekey="1x00000000000000000000AA" data-theme="dark"'],
  ["invisible", "Invisible", 'data-sitekey="1x00000000000000000000AA" data-size="invisible"'],
];
tsVariants.forEach(([slug, name, attrs]) => {
  page({
    file: `turnstile/${slug}/index.html`,
    title: "Turnstile (" + name + ")",
    crumb: crumb("Turnstile", name),
    tag: "Turnstile",
    h1: 'Turnstile &mdash; <span class="grad">' + name + "</span>",
    headExtra: tsHead,
    body:
      '    <div class="warn">Uses the Cloudflare <strong>test sitekey</strong> (always passes). Swap in your real sitekey for a live test.</div>\n' +
      '    <form class="panel" id="f">\n' +
      '      <p style="color:var(--text)">Widget mode: <strong>' + name + "</strong></p>\n" +
      '      <div class="cf-turnstile" ' + attrs + ' data-callback="onToken"></div>\n' +
      "      <br /><button class=\"btn\" type=\"submit\">Submit</button>\n" +
      "    </form>\n" +
      '    <div id="result"></div>\n' +
      "    <h2>Token</h2>\n    <pre id=\"token\">(waiting…)</pre>",
    script:
      "    function onToken(t){ document.getElementById('token').textContent = t; }\n" +
      "    document.getElementById('f').addEventListener('submit', function(e){ e.preventDefault();\n" +
      "      var r = document.getElementById('result'); r.className='ok';\n" +
      "      r.textContent = 'Token captured — verify server-side via /siteverify.'; });",
  });
});

// Turnstile login
page({
  file: "turnstile/login/index.html",
  title: "Turnstile Login",
  crumb: crumb("Turnstile", "Login"),
  tag: "Turnstile",
  h1: 'Turnstile <span class="grad">Login</span>',
  headExtra: tsHead,
  body:
    '    <form class="panel" id="f">\n' +
    "      <label for=\"u\">Email</label><input id=\"u\" type=\"email\" placeholder=\"you@example.com\" required />\n" +
    "      <label for=\"p\">Password</label><input id=\"p\" type=\"password\" placeholder=\"password\" required />\n" +
    '      <br /><br /><div class="cf-turnstile" data-sitekey="1x00000000000000000000AA" data-theme="dark"></div>\n' +
    "      <br /><button class=\"btn\" type=\"submit\">Sign in</button>\n" +
    "    </form>\n    <div id=\"result\"></div>",
  script:
    "    document.getElementById('f').addEventListener('submit', function(e){ e.preventDefault();\n" +
    "      var r = document.getElementById('result'); r.className='ok';\n" +
    "      r.textContent = 'Demo login submitted with a Turnstile token.'; });",
});

// ---------------------------------------------------------------------------
// Page Shield
// ---------------------------------------------------------------------------
const psHead = '  <script src="https://cdnjs.cloudflare.com/ajax/libs/jquery/3.7.1/jquery.min.js" defer></script>\n';
page({
  file: "page-shield/index.html",
  title: "Page Shield",
  crumb: crumb("Page Shield", "Workers"),
  tag: "Page Shield",
  h1: 'Page <span class="grad">Shield</span>',
  headExtra: psHead,
  body:
    '    <p class="lead">This page loads a third-party script so Page Shield has something to inventory.</p>\n' +
    '    <div class="note">Open <em>Security &rarr; Page Shield</em> in Cloudflare to see the connected/loaded scripts detected on this page.</div>\n' +
    "    <pre id=\"libs\">checking…</pre>",
  script:
    "    window.addEventListener('load', function(){\n" +
    "      document.getElementById('libs').textContent = 'jQuery loaded: ' + (window.jQuery ? jQuery.fn.jquery : 'no');\n" +
    "    });",
});
page({
  file: "page-shield-login/index.html",
  title: "Page Shield (Login)",
  crumb: crumb("Page Shield", "Login"),
  tag: "Page Shield",
  h1: 'Page Shield &mdash; <span class="grad">Login</span>',
  headExtra: psHead,
  body:
    '    <p class="lead">A login form monitored by Page Shield for script/skimmer changes (Magecart-style).</p>\n' +
    '    <form class="panel" id="f">\n' +
    "      <label>Email</label><input type=\"email\" required />\n" +
    "      <label>Password</label><input type=\"password\" required />\n" +
    "      <br /><br /><button class=\"btn\" type=\"submit\">Sign in</button>\n    </form>\n" +
    "    <div id=\"result\"></div>",
  script:
    "    document.getElementById('f').addEventListener('submit', function(e){ e.preventDefault();\n" +
    "      var r=document.getElementById('result'); r.className='ok'; r.textContent='Submitted (demo).'; });",
});

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------
const cacheScript =
  "    async function check(){\n" +
  "      var out = document.getElementById('hdr'); out.textContent='Fetching…';\n" +
  "      try{ var res = await fetch(location.href, {cache:'no-store'});\n" +
  "        var keys=['cf-cache-status','age','cache-control','cloudflare-cdn-cache-control','last-modified','etag','cf-ray'];\n" +
  "        var lines=[]; keys.forEach(function(k){ var v=res.headers.get(k); if(v) lines.push(k+': '+v); });\n" +
  "        out.textContent = lines.length ? lines.join('\\n') : '(no cache headers readable)';\n" +
  "      }catch(e){ out.textContent='Error: '+e.message; }\n" +
  "    }\n    document.getElementById('go').addEventListener('click', check); check();";
[
  ["cloudflare-cdn-cache-control", "Cloudflare-CDN-Cache-Control", "Tests the Cloudflare-specific edge cache TTL header, separate from the browser's Cache-Control."],
  ["cache-worker", "Cache Override via Workers", "A Worker rewrites Cache-Control / cache keys for this route."],
].forEach(([slug, name, desc]) => {
  page({
    file: `cache/${slug}/index.html`,
    title: name,
    crumb: crumb("Cache", name),
    tag: "Cache",
    h1: name,
    body:
      "    <p class=\"lead\">" + desc + "</p>\n" +
      '    <button class="btn" id="go">&#8635; Check cache headers</button>\n' +
      "    <h2>Cache headers</h2>\n    <pre id=\"hdr\">…</pre>\n" +
      '    <div class="note">Look at <code class="inline">cf-cache-status</code> (HIT/MISS/DYNAMIC) and the TTL headers.</div>',
    script: cacheScript,
  });
});

// ---------------------------------------------------------------------------
// API Shield sequence
// ---------------------------------------------------------------------------
[1, 2, 3].forEach((n) => {
  const next = n < 3
    ? '<a class="btn" href="https://www.pimenta.fun/api-shield/sequence/page' + (n + 1) + '/">Go to Page ' + (n + 1) + " &rarr;</a>"
    : '<div class="ok">&#10003; Sequence complete. API Shield Sequence Mitigation should allow this order: 1 &rarr; 2 &rarr; 3.</div>';
  page({
    file: `api-shield/sequence/page${n}/index.html`,
    title: "Sequence Page " + n,
    crumb: crumb("API Shield", "Sequence / Page " + n),
    tag: "API Shield",
    h1: 'Sequence &mdash; <span class="grad">Page ' + n + "</span>",
    body:
      "    <p class=\"lead\">Step " + n + " of a 3-step API sequence.</p>\n" +
      '    <div class="note">API Shield Sequence Mitigation enforces that clients hit pages in order (1&rarr;2&rarr;3). Jumping straight to a later page can be flagged.</div>\n' +
      "    <p>" + next + "</p>",
  });
});

// ---------------------------------------------------------------------------
// Security solutions (info pages)
// ---------------------------------------------------------------------------
const info = (file, cat, name, tag, lead, bullets) =>
  page({
    file, title: name, crumb: crumb(cat, name), tag, h1: name,
    body:
      "    <p class=\"lead\">" + lead + "</p>\n" +
      '    <ul class="bullets">\n' + bullets.map((b) => "      <li>" + b + "</li>").join("\n") + "\n    </ul>",
  });

info("security-solutions/password-spraying/index.html", "Security Solutions", "Password Spraying Protection", "Security",
  "Detect and stop credential-stuffing / password-spraying against login endpoints.",
  ["Rate limit by IP + username on POST /login", "WAF rule on leaked-credential checks", "Turnstile on the login form", "Account lockout via Worker + KV"]);
info("security-solutions/e-commerce/index.html", "Security Solutions", "E-Commerce Features", "Security",
  "Cloudflare features useful for protecting online stores.",
  ["Bot Management for checkout & inventory hoarding", "Page Shield for payment-skimmer detection", "Rate limiting on cart/checkout APIs", "Turnstile on account creation"]);
info("security-solutions/firewall-for-ai-llm/index.html", "Security Solutions", "Firewall for AI & LLMs", "Security",
  "Guardrails for AI/LLM-backed endpoints.",
  ["Prompt-injection and PII detection", "Rate limiting per token/user", "Bot scoring on inference routes", "Logging & analytics for abuse"]);
info("gotestwaf/index.html", "Security Solutions", "WAF Testing (GoTestWAF)", "Security",
  "Run the open-source GoTestWAF tool against this lab to score WAF coverage.",
  ["Install: <code class=\"inline\">docker pull wallarm/gotestwaf</code>",
   "Run: <code class=\"inline\">docker run wallarm/gotestwaf --url=https://www.pimenta.fun/</code>",
   "Review the generated PDF/HTML report for bypasses",
   "Tune Cloudflare Managed Rules and re-test"]);

// ---------------------------------------------------------------------------
// Bot management — delay action
// ---------------------------------------------------------------------------
page({
  file: "delay-action/index.html",
  title: "Delay Action",
  crumb: crumb("Bot Management", "Delay-action"),
  tag: "Bot Management",
  h1: 'Bot <span class="grad">Delay</span> Action',
  body:
    '    <p class="lead">Simulates a delayed response, used to slow down suspected bots without blocking.</p>\n' +
    '    <button class="btn" id="go">Request with delay</button>\n    <pre id="out">…</pre>',
  script:
    "    document.getElementById('go').addEventListener('click', function(){\n" +
    "      var o=document.getElementById('out'); o.textContent='waiting 3s…';\n" +
    "      var t0=Date.now(); setTimeout(function(){ o.textContent='responded after '+(Date.now()-t0)+' ms'; }, 3000);\n" +
    "    });",
});

// ---------------------------------------------------------------------------
// Content scanning / uploads
// ---------------------------------------------------------------------------
const uploadBody =
  '    <p class="lead">Upload a file to exercise Cloudflare WAF Content Scanning.</p>\n' +
  '    <form class="panel" id="f">\n' +
  "      <label>Choose a file</label><input id=\"file\" type=\"file\" />\n" +
  "      <br /><br /><button class=\"btn\" type=\"submit\">Upload</button>\n    </form>\n" +
  '    <div id="result"></div>\n' +
  '    <div class="note">Try the EICAR test file to see Content Scanning flag a malicious upload.</div>';
const uploadScript =
  "    document.getElementById('f').addEventListener('submit', function(e){ e.preventDefault();\n" +
  "      var f=document.getElementById('file').files[0];\n" +
  "      var r=document.getElementById('result'); r.className='ok';\n" +
  "      r.textContent = f ? ('Selected: '+f.name+' ('+f.size+' bytes). Wire to a Worker/R2 to upload.') : 'Pick a file first.'; });";
page({ file: "media/upload/index.html", title: "Upload to R2", crumb: crumb("Content Scanning", "Upload to R2"),
  tag: "Content Scanning", h1: 'Upload to <span class="grad">R2</span>', body: uploadBody, script: uploadScript });
page({ file: "content-scanning-lab/index.html", title: "Content Scanning Lab", crumb: crumb("Content Scanning", "Lab"),
  tag: "Content Scanning", h1: 'Content Scanning <span class="grad">Lab</span>', body: uploadBody, script: uploadScript });

// ---------------------------------------------------------------------------
// Forms: signup, login-demo, login-jwt, maintenance-snippets
// ---------------------------------------------------------------------------
page({
  file: "forms/signup/index.html", title: "Signup Protection", crumb: crumb("Forms", "Signup"),
  tag: "Forms protection", h1: '<span class="grad">Signup</span> Protection',
  body:
    '    <form class="panel" id="f">\n' +
    "      <label>Email</label><input type=\"email\" required />\n" +
    "      <label>Password</label><input type=\"password\" required />\n" +
    "      <label>Confirm password</label><input type=\"password\" required />\n" +
    "      <br /><br /><button class=\"btn\" type=\"submit\">Create account</button>\n    </form>\n    <div id=\"result\"></div>",
  script: "    document.getElementById('f').addEventListener('submit',function(e){e.preventDefault();var r=document.getElementById('result');r.className='ok';r.textContent='Demo signup captured.';});",
});
page({
  file: "login-demo/index.html", title: "Login Demo", crumb: crumb("Forms", "Login Demo"),
  tag: "Forms protection", h1: '<span class="grad">Login</span> Demo',
  body:
    '    <form class="panel" id="f">\n' +
    "      <label>Username</label><input type=\"text\" value=\"admin\" />\n" +
    "      <label>Password</label><input type=\"password\" />\n" +
    "      <br /><br /><button class=\"btn\" type=\"submit\">Log in</button>\n    </form>\n    <div id=\"result\"></div>",
  script: "    document.getElementById('f').addEventListener('submit',function(e){e.preventDefault();var r=document.getElementById('result');r.className='ok';r.textContent='Demo login submitted.';});",
});
page({
  file: "forms/login-jwt.html", title: "Login with JWT", crumb: crumb("API Shield", "Login with JWT"),
  tag: "API Shield", h1: 'Login with <span class="grad">JWT</span>',
  body:
    '    <p class="lead">Authenticate against the live API and receive a JWT.</p>\n' +
    '    <form class="panel" id="f">\n' +
    "      <label>Email</label><input id=\"e\" type=\"email\" value=\"admin@juice-sh.op\" />\n" +
    "      <label>Password</label><input id=\"p\" type=\"password\" value=\"admin123\" />\n" +
    "      <br /><br /><button class=\"btn\" type=\"submit\">Get token</button>\n    </form>\n" +
    "    <h2>Token</h2>\n    <pre id=\"out\">(none yet)</pre>",
  script:
    "    document.getElementById('f').addEventListener('submit', async function(e){ e.preventDefault();\n" +
    "      var out=document.getElementById('out'); out.textContent='Requesting…';\n" +
    "      try{ var res= await fetch('https://api.pimenta.fun/rest/user/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:document.getElementById('e').value,password:document.getElementById('p').value})});\n" +
    "        var j= await res.json(); out.textContent = (j.authentication && j.authentication.token) ? j.authentication.token : JSON.stringify(j); }\n" +
    "      catch(err){ out.textContent='Error: '+err.message; } });",
});
page({
  file: "maintenance-snippets/index.html", title: "Maintenance (Snippets)", crumb: crumb("Maintenance", "From Snippets"),
  tag: "Maintenance", h1: 'Maintenance &mdash; <span class="grad">Snippets</span>',
  body:
    '    <div class="center"><div class="big-code">&#128296;</div></div>\n' +
    '    <p class="lead center">Served by a Cloudflare Snippet.</p>\n' +
    '    <div class="note">A Snippet intercepts matching requests at the edge and returns this maintenance response without touching the origin.</div>',
});

console.log("\nDone. Pages generated under", ROOT);
