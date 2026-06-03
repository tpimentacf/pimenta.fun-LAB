# Cloudflare Dynamic DNS for GCP VM

Keeps `www.pimenta.fun` and `shop.pimenta.fun` pointed at the **current public IP**
of this GCP VM, updated daily via cron.

Files:
- `cf-ddns.sh` — the update script (IP detection + Cloudflare API sync)
- `cf-ddns.env.example` — config template

---

## How it works

1. Reads the VM's external IP from the **GCP metadata server**
   (`metadata.google.internal`), falling back to `ipify.org` / `ifconfig.me`.
2. Looks up each A record in Cloudflare via the API.
3. **Creates** the record if missing, **updates** it only if the IP changed,
   otherwise does nothing. Logs every run to `/var/log/cf-ddns.log`.

> Note: a daily cron is fine if the VM has a **static external IP** or rarely
> reboots. If the IP can change at any time (ephemeral IP), run it more often
> (e.g. every 5 minutes) — see the cron options below. The best fix is to
> reserve a **static external IP** in GCP so it never changes.

---

## 1. Create a scoped Cloudflare API token

Cloudflare Dashboard → **My Profile → API Tokens → Create Token → Create Custom Token**:

- **Permissions:** `Zone` → `DNS` → `Edit`
- **Zone Resources:** `Include` → `Specific zone` → `pimenta.fun`
- Create and copy the token (shown once).

(Use a scoped token, **not** the Global API Key.)

---

## 2. Install on the VM

```bash
# Dependencies
sudo apt update && sudo apt install -y curl jq

# Script
sudo install -m 0755 cf-ddns.sh /usr/local/bin/cf-ddns.sh

# Config
sudo mkdir -p /etc/cf-ddns
sudo cp cf-ddns.env.example /etc/cf-ddns/cf-ddns.env
sudo nano /etc/cf-ddns/cf-ddns.env        # paste token, confirm RECORDS
sudo chmod 600 /etc/cf-ddns/cf-ddns.env   # protect the token

# Log file
sudo touch /var/log/cf-ddns.log
```

---

## 3. Test it manually

```bash
sudo /usr/local/bin/cf-ddns.sh
sudo tail -n 20 /var/log/cf-ddns.log
```

Expected output:

```
2026-06-03 09:00:01 Current public IP: 34.12.34.56
2026-06-03 09:00:01 Zone pimenta.fun -> a1b2c3...
2026-06-03 09:00:02 UPDATED www.pimenta.fun: 1.2.3.4 -> 34.12.34.56
2026-06-03 09:00:02 UPDATED shop.pimenta.fun: 1.2.3.4 -> 34.12.34.56
2026-06-03 09:00:02 Done.
```

Verify in Cloudflare or with dig:

```bash
dig +short www.pimenta.fun @1.1.1.1
dig +short shop.pimenta.fun @1.1.1.1
```

---

## 4. Schedule the cron job (daily)

Install a root crontab entry — runs every day at 03:00:

```bash
echo '0 3 * * * /usr/local/bin/cf-ddns.sh >> /var/log/cf-ddns.log 2>&1' \
  | sudo tee /etc/cron.d/cf-ddns
# /etc/cron.d entries need a user field; use this exact form instead:
```

**Recommended — use `/etc/cron.d` with the user column:**

```bash
sudo tee /etc/cron.d/cf-ddns >/dev/null <<'EOF'
# m h dom mon dow user command
0 3 * * * root /usr/local/bin/cf-ddns.sh >> /var/log/cf-ddns.log 2>&1
EOF
sudo chmod 644 /etc/cron.d/cf-ddns
```

Or via root's crontab:

```bash
sudo crontab -e
# add:
0 3 * * * /usr/local/bin/cf-ddns.sh >> /var/log/cf-ddns.log 2>&1
```

Cron schedule cheatsheet:
- `0 3 * * *`   → daily at 03:00 (what you asked for)
- `*/5 * * * *` → every 5 minutes (use if the IP is ephemeral)
- `@reboot`     → also run once on every boot (good for ephemeral IPs)

---

## 5. (Optional but recommended) Reserve a static IP in GCP

If you give the VM a **static external IP**, the record only ever needs to be
set once — but the daily cron remains a safe self-healing backstop.

```bash
# Promote the VM's current ephemeral IP to static (run with gcloud):
gcloud compute addresses create pimenta-ip \
  --addresses "$(curl -s -H 'Metadata-Flavor: Google' \
    http://metadata.google.internal/computeMetadata/v1/instance/network-interfaces/0/access-configs/0/external-ip)" \
  --region YOUR_REGION
```

---

## 6. (Alternative) systemd timer instead of cron

If you prefer systemd:

```bash
sudo tee /etc/systemd/system/cf-ddns.service >/dev/null <<'EOF'
[Unit]
Description=Cloudflare DDNS update
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
ExecStart=/usr/local/bin/cf-ddns.sh
EOF

sudo tee /etc/systemd/system/cf-ddns.timer >/dev/null <<'EOF'
[Unit]
Description=Run Cloudflare DDNS daily

[Timer]
OnCalendar=*-*-* 03:00:00
Persistent=true

[Install]
WantedBy=timers.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable --now cf-ddns.timer
systemctl list-timers cf-ddns.timer
```

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| `zone not found / token lacks access` | Token must include `Zone:DNS:Edit` for `pimenta.fun`. |
| `could not determine public IP` | Check egress; metadata server only works on GCP. Test `curl https://api.ipify.org`. |
| Record proxied/unproxied wrong | Set `PROXIED="true"` or `"false"` in the env file. |
| No log output from cron | Confirm `cron` is running: `systemctl status cron`. |
| Want to confirm value sent | `sudo bash -x /usr/local/bin/cf-ddns.sh` for verbose trace. |
