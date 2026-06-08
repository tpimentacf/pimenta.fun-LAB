# Pimenta.fun Lab — Deployment Guide (Ubuntu + Apache)

Three sites:

| Domain                | Content                                   | Backend            |
|-----------------------|-------------------------------------------|--------------------|
| `www.pimenta.fun`     | Landing page                              | Static HTML        |
| `shop.pimenta.fun`    | Shop items + login + chatbot              | Static HTML        |
| `api.pimenta.fun`     | API docs + live API                       | OWASP Juice Shop   |

```
pimenta-lab/
├── www/index.html
├── shop/index.html
├── shop/login.html
├── api/index.html
└── apache/
    ├── www.pimenta.fun.conf
    ├── shop.pimenta.fun.conf
    └── api.pimenta.fun.conf
```

---

## 1. Install Apache

```bash
sudo apt update
sudo apt install -y apache2
sudo systemctl enable --now apache2
```

## 2. Copy the site files

```bash
sudo mkdir -p /var/www/pimenta
sudo cp -r www shop api aop /var/www/pimenta/
sudo chown -R www-data:www-data /var/www/pimenta
sudo find /var/www/pimenta -type d -exec chmod 755 {} \;
sudo find /var/www/pimenta -type f -exec chmod 644 {} \;
```

## 3. Install the shared SSL + header snippets

```bash
sudo cp apache/pimenta-security-headers.conf /etc/apache2/conf-available/
sudo cp apache/pimenta-ssl-params.conf       /etc/apache2/conf-available/
sudo cp apache/pimenta-ssl-stapling.conf     /etc/apache2/conf-available/

# the vhosts Include the headers + ssl-params snippets in their :443 blocks;
# the stapling cache is global, so enable it as a conf:
sudo a2enconf pimenta-ssl-stapling
```

## 4. Install the virtual hosts

Easiest — use the helper (installs snippets, modules, fetches the AOP CA,
enables all four sites, runs configtest):

```bash
cd apache && sudo ./enable-sites.sh
```

Or manually:

```bash
sudo cp apache/www.pimenta.fun.conf  /etc/apache2/sites-available/
sudo cp apache/shop.pimenta.fun.conf /etc/apache2/sites-available/
sudo cp apache/api.pimenta.fun.conf  /etc/apache2/sites-available/
sudo cp apache/aop.pimenta.fun.conf  /etc/apache2/sites-available/

sudo a2ensite www.pimenta.fun shop.pimenta.fun api.pimenta.fun aop.pimenta.fun
sudo a2dissite 000-default.conf      # optional: drop the default site
```

### 4b. Download the Cloudflare origin-pull CA (required by aop.pimenta.fun)

The `aop` vhost verifies Cloudflare's client certificate, so this CA must exist
or Apache won't start:

```bash
sudo mkdir -p /etc/apache2/cloudflare
sudo curl -fsSL \
  https://developers.cloudflare.com/ssl/static/authenticated_origin_pull_ca.pem \
  -o /etc/apache2/cloudflare/origin-pull-ca.pem
```

## 5. Enable required modules

```bash
# ssl/headers/rewrite for HTTPS + response headers; proxy for the API;
# socache_shmcb backs the OCSP stapling cache
sudo a2enmod ssl headers rewrite proxy proxy_http socache_shmcb
```

> The vhosts listen on **:443** and reference Let's Encrypt cert paths
> (`/etc/letsencrypt/live/<domain>/`). Those files don't exist until you run
> Certbot (step 8), so enable the sites **then run Certbot**, which validates
> over HTTP-01 and reloads Apache. The `:443` blocks are wrapped in
> `<IfModule mod_ssl.c>` so `configtest` won't fail before certs exist, but
> Apache won't serve TLS until the certs are present.

## 5. Run OWASP Juice Shop (the API backend)

**Docker (recommended):**

```bash
sudo apt install -y docker.io
sudo docker run -d --restart=always \
  -p 127.0.0.1:3000:3000 \
  --name juice-shop \
  bkimminich/juice-shop
```

**Or via Node.js:**

```bash
git clone https://github.com/juice-shop/juice-shop.git
cd juice-shop && npm install && npm start   # listens on :3000
```

> The `api.pimenta.fun` vhost proxies `/rest/`, `/api/`, `/ftp/`, and `/metrics`
> to `127.0.0.1:3000`. To serve the **entire** Juice Shop app at the root,
> edit `api.pimenta.fun.conf` and uncomment the `ProxyPass /` lines.

## 6. Test config & reload

```bash
sudo apache2ctl configtest      # should print: Syntax OK
sudo systemctl reload apache2
```

---

## 7. DNS

Point the records at your server's public IP. Keep them **proxied (orange
cloud)** so Cloudflare features (WAF, mTLS, AOP, cache) apply:

```
www    A   <SERVER_IP>   (proxied)
shop   A   <SERVER_IP>   (proxied)
api    A   <SERVER_IP>   (proxied)
aop    A   <SERVER_IP>   (proxied — required for Authenticated Origin Pulls)
@      A   <SERVER_IP>   (optional, for the bare pimenta.fun)
```

For local-only testing, add to `/etc/hosts`:

```
<SERVER_IP>  www.pimenta.fun shop.pimenta.fun api.pimenta.fun aop.pimenta.fun pimenta.fun
```

---

## 8. HTTPS certificates

The vhosts already contain the `:443` SSL blocks and reference
`/etc/letsencrypt/live/<domain>/`. Obtain the certs with Certbot in
**certonly** mode (so it doesn't rewrite our hand-written vhosts), then reload:

```bash
sudo apt install -y certbot python3-certbot-apache

# HTTP-01 over the running :80 vhosts (the configs allow /.well-known/ through):
sudo certbot certonly --webroot -w /var/www/pimenta/www \
  -d www.pimenta.fun -d pimenta.fun
sudo certbot certonly --webroot -w /var/www/pimenta/shop -d shop.pimenta.fun
sudo certbot certonly --webroot -w /var/www/pimenta/api  -d api.pimenta.fun
sudo certbot certonly --webroot -w /var/www/pimenta/aop  -d aop.pimenta.fun

sudo apache2ctl configtest && sudo systemctl reload apache2
```

Auto-renewal is handled by the `certbot.timer` systemd unit. Add a reload hook:

```bash
echo -e '#!/bin/sh\nsystemctl reload apache2' | \
  sudo tee /etc/letsencrypt/renewal-hooks/deploy/reload-apache.sh
sudo chmod +x /etc/letsencrypt/renewal-hooks/deploy/reload-apache.sh
```

> Prefer the all-in-one installer? `sudo certbot --apache -d www.pimenta.fun -d pimenta.fun -d shop.pimenta.fun -d api.pimenta.fun`
> also works, but it may rewrite these vhosts — use `certonly` to keep them as-is.

### Verify headers & TLS

```bash
# security/response headers
curl -sI https://www.pimenta.fun | grep -Ei 'strict-transport|x-frame|x-content|referrer|permissions|x-pimenta'

# negotiated protocol should be TLS 1.3 (or 1.2); 1.0/1.1 must fail
openssl s_client -connect www.pimenta.fun:443 -tls1_3 </dev/null 2>/dev/null | grep -E 'Protocol|Cipher'
openssl s_client -connect www.pimenta.fun:443 -tls1_1 </dev/null 2>&1 | grep -i 'alert\|failure'   # expect a failure

# OCSP stapling
openssl s_client -connect www.pimenta.fun:443 -status </dev/null 2>/dev/null | grep -A1 'OCSP Response Status'
```

---

## 8b. Enable Authenticated Origin Pulls (aop.pimenta.fun)

1. The origin is ready: the `aop` vhost runs `SSLVerifyClient optional` and
   trusts `/etc/apache2/cloudflare/origin-pull-ca.pem` (step 4b).
2. In Cloudflare for the zone: **SSL/TLS → Origin Server → Authenticated Origin
   Pulls → On** (zone-level). Ensure the `aop` record is **proxied**.
3. Verify:

```bash
# Through Cloudflare: CF presents its client cert -> SUCCESS
curl -sI https://aop.pimenta.fun/ | grep -i x-aop-client-verify
#   -> X-AOP-Client-Verify: SUCCESS

# Direct to origin (no CF cert): NONE (optional) — or 400 if you switch to "require"
curl -sI --resolve aop.pimenta.fun:443:<ORIGIN_IP> https://aop.pimenta.fun/ | head
```

Or just open <https://aop.pimenta.fun/> — the page reports SUCCESS / NONE / FAILED.

---

## 9. Verify

```bash
curl -I http://www.pimenta.fun
curl -I http://shop.pimenta.fun
curl    https://api.pimenta.fun/rest/admin/application-version   # {"status":"success","version":"1.0.0",...}
curl -sI https://aop.pimenta.fun/ | grep -i x-aop-client-verify  # AOP status
```

Then browse:
- https://www.pimenta.fun
- https://shop.pimenta.fun  (open the chat bubble bottom-right; click **Login**)
- https://api.pimenta.fun
- https://aop.pimenta.fun

---

## Wiring the login form to the live API (optional)

In `shop/login.html` the form `action` is `/rest/user/login`. To make it hit
Juice Shop:

1. In `apache/shop.pimenta.fun.conf`, uncomment the `ProxyPass /rest/user/login`
   lines, **or**
2. In `shop/login.html`, uncomment the `fetch("https://api.pimenta.fun/rest/user/login", ...)`
   block in the `<script>` and remove the demo-mode branch.

> Reminder: Juice Shop is **intentionally vulnerable**. Keep this lab isolated and
> use it only for authorized security testing.
