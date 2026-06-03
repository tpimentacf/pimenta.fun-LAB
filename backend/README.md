# Pimenta API — persistent backend (Express + SQLite)

A long-running REST API with a real database that powers the shop and the
`api.pimenta.fun` console. Runs under **systemd**, so it starts on boot and
**auto-restarts** if it crashes or the VM reboots.

```
backend/
├── server.js                 # Express app + all routes
├── db.js                     # SQLite schema + seed (products, admin user)
├── package.json
├── pimenta-api.service        # systemd unit (Restart=always, start on boot)
└── pimenta-api.env.example    # config template (port, JWT secret, DB path)
```

## Stack & data

- **Runtime:** Node.js 18+ / Express
- **Database:** SQLite (file-based, WAL mode) — zero extra services, persists on disk
- **Auth:** JWT (bcrypt-hashed passwords)
- **DB location:** `/var/lib/pimenta-api/pimenta.db` (survives restarts/reboots)

### Endpoints

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET  | `/health` | – | status, uptime, row counts |
| POST | `/api/Users` | – | register |
| POST | `/rest/user/login` | – | login → `{ authentication: { token } }` |
| GET  | `/rest/user/whoami` | ✓ | current identity |
| GET  | `/api/Users/:id` | ✓ | user details (IDOR demo) |
| GET  | `/api/Products` | – | list products |
| GET  | `/api/Products/:id` | – | one product |
| PUT  | `/api/Products/:id` | ✓ | update a product |
| GET  | `/rest/products/search?q=` | – | search |
| POST | `/api/BasketItems` | ✓ | add to cart |
| GET  | `/rest/basket/:id` | ✓ | view cart + total |
| POST | `/rest/basket/:id/checkout` | ✓ | place order, clear cart |
| GET  | `/api/Orders` | ✓ | current user's order history |
| GET  | `/api/Feedbacks` | – | list feedback |
| POST | `/api/Feedbacks` | optional | submit feedback |
| GET  | `/rest/admin/application-version` | – | app version |

The login response is shaped like Juice Shop's, so the **API console**
(`api.pimenta.fun`) auto-captures the token after login.

---

## Install on the Ubuntu server

### 1. Node.js + build tools (better-sqlite3 compiles a native module)

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs build-essential python3
```

### 2. Service user + app directory

```bash
sudo useradd --system --home /opt/pimenta-api --shell /usr/sbin/nologin pimenta || true
sudo mkdir -p /opt/pimenta-api
sudo cp -r server.js db.js package.json /opt/pimenta-api/
cd /opt/pimenta-api
sudo npm install --omit=dev
sudo chown -R pimenta:pimenta /opt/pimenta-api
```

### 3. Database directory (persistent)

```bash
sudo mkdir -p /var/lib/pimenta-api
sudo chown pimenta:pimenta /var/lib/pimenta-api
```

### 4. Config

```bash
sudo mkdir -p /etc/pimenta-api
sudo cp pimenta-api.env.example /etc/pimenta-api/pimenta-api.env
sudo sed -i "s|replace-with-openssl-rand-hex-32|$(openssl rand -hex 32)|" /etc/pimenta-api/pimenta-api.env
sudo nano /etc/pimenta-api/pimenta-api.env     # set ADMIN_PASSWORD etc.
sudo chmod 600 /etc/pimenta-api/pimenta-api.env
```

### 5. Install & start the service

```bash
sudo cp pimenta-api.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now pimenta-api      # enable = start on boot
sudo systemctl status pimenta-api
```

### 6. Verify it's alive

```bash
curl http://127.0.0.1:3000/health
curl http://127.0.0.1:3000/api/Products
```

### 6b. Smoke-test every endpoint

`tools/smoke-test.sh` calls each route with the correct method and asserts the
expected status (including that auth routes reject anonymous calls with 401):

```bash
# against the live site
tools/smoke-test.sh https://api.pimenta.fun

# or directly against the local service
tools/smoke-test.sh http://127.0.0.1:3000

# custom credentials: tools/smoke-test.sh <BASE_URL> <EMAIL> <PASSWORD>
```

Exit code is 0 only if every check passes.

---

## Always-on / auto-restart — how it works

The systemd unit guarantees the API keeps running:

- `Restart=always` + `RestartSec=3` → if `node` exits for **any** reason
  (crash, unhandled error, OOM), systemd relaunches it after 3 seconds.
- `StartLimitIntervalSec=0` → systemd never stops trying to restart it.
- `WantedBy=multi-user.target` + `systemctl enable` → it **starts automatically
  on every boot/reboot**.
- `StateDirectory=pimenta-api` → `/var/lib/pimenta-api` is owned by the service
  user and persists, so the database is intact across restarts.

**Test it:**

```bash
# Simulate a crash — systemd brings it right back:
sudo systemctl kill -s SIGKILL pimenta-api
sleep 4 && systemctl status pimenta-api      # should be "active (running)" again

# Simulate a reboot:
sudo reboot
# after it comes back:
systemctl is-enabled pimenta-api             # -> enabled
curl http://127.0.0.1:3000/health            # -> {"status":"ok",...}
```

**Logs:**

```bash
journalctl -u pimenta-api -f          # live
journalctl -u pimenta-api --since "1 hour ago"
```

---

## Expose it via Apache (api.pimenta.fun)

The existing `api.pimenta.fun` vhost already proxies `/rest/` and `/api/` to
`127.0.0.1:3000`. Add the health route too if you like:

```apache
ProxyPass        /health  http://127.0.0.1:3000/health
ProxyPassReverse /health  http://127.0.0.1:3000/health
```

```bash
sudo a2enmod proxy proxy_http
sudo systemctl reload apache2
curl https://api.pimenta.fun/api/Products
```

> **Port note:** this API and OWASP Juice Shop both default to **3000** — run
> only one on that port. To run both, set `PORT=3001` in the env file and point
> a separate proxy/vhost at it.

### CORS

The shop/www pages call this API cross-origin, so their domains must be allowed.
This is controlled by `CORS_ORIGINS` in the env file (default:
`https://www.pimenta.fun,https://shop.pimenta.fun,https://api.pimenta.fun`).
Requests with no `Origin` header (curl, server-to-server) are always allowed.
Add `http://localhost:8080` (or similar) to the list when testing the frontend
locally.

---

## Common operations

```bash
sudo systemctl restart pimenta-api      # manual restart
sudo systemctl stop pimenta-api         # stop
sudo systemctl disable pimenta-api      # don't start on boot

# Re-seed / inspect DB
sudo -u pimenta DB_PATH=/var/lib/pimenta-api/pimenta.db node /opt/pimenta-api/db.js --seed
sudo apt install -y sqlite3
sudo -u pimenta sqlite3 /var/lib/pimenta-api/pimenta.db ".tables"

# Backup the database
sudo cp /var/lib/pimenta-api/pimenta.db ~/pimenta-backup-$(date +%F).db
```

---

## Local dev (your laptop)

```bash
cd backend
npm install
JWT_SECRET=dev PORT=3000 npm start
curl http://127.0.0.1:3000/health
```
