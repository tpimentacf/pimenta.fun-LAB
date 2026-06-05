#!/usr/bin/env bash
#
# enable-sites.sh — install & enable the Pimenta Apache vhosts on Ubuntu.
#
# Run as root from the apache/ directory (or anywhere — it finds its own path):
#   sudo ./enable-sites.sh
#
# Idempotent: safe to re-run. Does NOT obtain TLS certs (run certbot after).

set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo "Please run as root:  sudo $0" >&2
  exit 1
fi

# Directory this script lives in (so it can find the .conf files).
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONF_AVAIL="/etc/apache2/conf-available"
SITES_AVAIL="/etc/apache2/sites-available"

SITES=(www.pimenta.fun shop.pimenta.fun api.pimenta.fun)
SNIPPETS=(pimenta-security-headers.conf pimenta-ssl-params.conf pimenta-ssl-stapling.conf)

echo "==> Enabling required modules"
a2enmod ssl headers rewrite proxy proxy_http socache_shmcb >/dev/null

echo "==> Installing shared snippets to ${CONF_AVAIL}"
for s in "${SNIPPETS[@]}"; do
  install -m 0644 "${SRC}/${s}" "${CONF_AVAIL}/${s}"
  echo "    + ${s}"
done

echo "==> Enabling global OCSP stapling cache"
a2enconf pimenta-ssl-stapling >/dev/null

echo "==> Installing vhosts to ${SITES_AVAIL}"
for site in "${SITES[@]}"; do
  install -m 0644 "${SRC}/${site}.conf" "${SITES_AVAIL}/${site}.conf"
  echo "    + ${site}.conf"
done

echo "==> Enabling sites"
for site in "${SITES[@]}"; do
  a2ensite "${site}.conf" >/dev/null
  echo "    enabled ${site}"
done

echo "==> Disabling the default site (if present)"
a2dissite 000-default.conf >/dev/null 2>&1 || true

echo "==> Testing configuration"
if apache2ctl configtest; then
  echo "==> Reloading Apache"
  systemctl reload apache2
  echo
  echo "Done. Sites enabled: ${SITES[*]}"
  echo "Next: obtain TLS certs (the :443 blocks reference /etc/letsencrypt/live/<domain>/):"
  echo "  sudo certbot certonly --webroot -w /var/www/pimenta/www  -d www.pimenta.fun -d pimenta.fun"
  echo "  sudo certbot certonly --webroot -w /var/www/pimenta/shop -d shop.pimenta.fun"
  echo "  sudo certbot certonly --webroot -w /var/www/pimenta/api  -d api.pimenta.fun"
  echo "  sudo systemctl reload apache2"
else
  echo "configtest FAILED — not reloading. Fix the errors above." >&2
  exit 1
fi
