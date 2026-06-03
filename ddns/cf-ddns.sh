#!/usr/bin/env bash
#
# cf-ddns.sh — Update Cloudflare A records with this GCP VM's current public IP.
#
# Updates each hostname listed in $RECORDS. Creates the record if it does not
# exist, and only sends an update when the IP has actually changed.
#
# Requires: curl, jq
# Config:   /etc/cf-ddns/cf-ddns.env  (or pass a path as $1)
#
set -euo pipefail

# ---------------------------------------------------------------------------
# Load config
# ---------------------------------------------------------------------------
CONFIG="${1:-/etc/cf-ddns/cf-ddns.env}"
if [[ ! -f "$CONFIG" ]]; then
  echo "ERROR: config file not found: $CONFIG" >&2
  exit 1
fi
# shellcheck disable=SC1090
source "$CONFIG"

: "${CF_API_TOKEN:?CF_API_TOKEN not set in $CONFIG}"
: "${CF_ZONE_NAME:?CF_ZONE_NAME not set in $CONFIG}"
: "${RECORDS:?RECORDS not set in $CONFIG}"
TTL="${TTL:-120}"            # seconds; 1 = auto
PROXIED="${PROXIED:-false}"  # true to route through Cloudflare proxy
LOG_FILE="${LOG_FILE:-/var/log/cf-ddns.log}"

API="https://api.cloudflare.com/client/v4"
AUTH=(-H "Authorization: Bearer ${CF_API_TOKEN}" -H "Content-Type: application/json")

log() { echo "$(date '+%Y-%m-%d %H:%M:%S') $*" | tee -a "$LOG_FILE"; }

# ---------------------------------------------------------------------------
# Dependency check
# ---------------------------------------------------------------------------
for bin in curl jq; do
  command -v "$bin" >/dev/null 2>&1 || { echo "ERROR: '$bin' is required" >&2; exit 1; }
done

# ---------------------------------------------------------------------------
# 1. Determine current public IPv4
# ---------------------------------------------------------------------------
get_public_ip() {
  # Prefer the GCP metadata server (authoritative for the VM's external IP).
  local ip
  ip="$(curl -s -m 5 -H 'Metadata-Flavor: Google' \
    'http://metadata.google.internal/computeMetadata/v1/instance/network-interfaces/0/access-configs/0/external-ip' || true)"

  # Fall back to public echo services if metadata is unavailable.
  if ! [[ "$ip" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]]; then
    ip="$(curl -s -m 5 https://api.ipify.org || true)"
  fi
  if ! [[ "$ip" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]]; then
    ip="$(curl -s -m 5 https://ifconfig.me || true)"
  fi

  [[ "$ip" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]] || return 1
  echo "$ip"
}

PUBLIC_IP="$(get_public_ip)" || { log "ERROR: could not determine public IP"; exit 1; }
log "Current public IP: ${PUBLIC_IP}"

# ---------------------------------------------------------------------------
# 2. Resolve Zone ID
# ---------------------------------------------------------------------------
if [[ -z "${CF_ZONE_ID:-}" ]]; then
  CF_ZONE_ID="$(curl -s "${AUTH[@]}" "${API}/zones?name=${CF_ZONE_NAME}" \
    | jq -r '.result[0].id // empty')"
  [[ -n "$CF_ZONE_ID" ]] || { log "ERROR: zone '${CF_ZONE_NAME}' not found / token lacks access"; exit 1; }
fi
log "Zone ${CF_ZONE_NAME} -> ${CF_ZONE_ID}"

# ---------------------------------------------------------------------------
# 3. Sync each record
# ---------------------------------------------------------------------------
update_record() {
  local name="$1"
  local resp record_id current_ip

  resp="$(curl -s "${AUTH[@]}" "${API}/zones/${CF_ZONE_ID}/dns_records?type=A&name=${name}")"
  record_id="$(echo "$resp" | jq -r '.result[0].id // empty')"
  current_ip="$(echo "$resp" | jq -r '.result[0].content // empty')"

  local payload
  payload="$(jq -nc \
    --arg name "$name" --arg ip "$PUBLIC_IP" \
    --argjson ttl "$TTL" --argjson proxied "$PROXIED" \
    '{type:"A", name:$name, content:$ip, ttl:$ttl, proxied:$proxied}')"

  if [[ -z "$record_id" ]]; then
    # Create
    local out ok
    out="$(curl -s "${AUTH[@]}" -X POST \
      "${API}/zones/${CF_ZONE_ID}/dns_records" --data "$payload")"
    ok="$(echo "$out" | jq -r '.success')"
    if [[ "$ok" == "true" ]]; then
      log "CREATED ${name} -> ${PUBLIC_IP}"
    else
      log "ERROR creating ${name}: $(echo "$out" | jq -c '.errors')"
    fi
    return
  fi

  if [[ "$current_ip" == "$PUBLIC_IP" ]]; then
    log "OK ${name} already ${PUBLIC_IP} (no change)"
    return
  fi

  # Update (PUT preserves nothing, so we resend the full record)
  local out ok
  out="$(curl -s "${AUTH[@]}" -X PUT \
    "${API}/zones/${CF_ZONE_ID}/dns_records/${record_id}" --data "$payload")"
  ok="$(echo "$out" | jq -r '.success')"
  if [[ "$ok" == "true" ]]; then
    log "UPDATED ${name}: ${current_ip} -> ${PUBLIC_IP}"
  else
    log "ERROR updating ${name}: $(echo "$out" | jq -c '.errors')"
  fi
}

for host in $RECORDS; do
  update_record "$host"
done

log "Done."
