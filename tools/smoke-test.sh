#!/usr/bin/env bash
#
# smoke-test.sh — exercise every Pimenta API endpoint with the correct method
# and assert the expected HTTP status. Also checks that auth-required routes
# reject anonymous calls (401).
#
# Usage:
#   tools/smoke-test.sh [BASE_URL] [EMAIL] [PASSWORD]
# Defaults:
#   BASE_URL=https://api.pimenta.fun  EMAIL=admin@juice-sh.op  PASSWORD=admin123
#
# Requires: curl. (jq optional — falls back to sed for token extraction.)

set -u

BASE="${1:-https://api.pimenta.fun}"
EMAIL="${2:-admin@juice-sh.op}"
PASSWORD="${3:-admin123}"
BASE="${BASE%/}"

pass=0; fail=0
TOKEN=""

# Colours (disabled if not a TTY)
if [ -t 1 ]; then G=$'\033[32m'; R=$'\033[31m'; Y=$'\033[33m'; D=$'\033[2m'; N=$'\033[0m'; else G=; R=; Y=; D=; N=; fi

command -v curl >/dev/null 2>&1 || { echo "curl is required"; exit 1; }
HAVE_JQ=0; command -v jq >/dev/null 2>&1 && HAVE_JQ=1

echo "Target: $BASE"
echo "------------------------------------------------------------"

# check NAME METHOD PATH EXPECTED [auth|noauth] [body]
check() {
  local name="$1" method="$2" path="$3" expect="$4" auth="${5:-noauth}" body="${6:-}"
  local url="$BASE$path"
  local args=(-s -o /dev/null -w "%{http_code}" -X "$method")
  [ "$auth" = "auth" ] && [ -n "$TOKEN" ] && args+=(-H "Authorization: Bearer $TOKEN")
  if [ -n "$body" ]; then args+=(-H "Content-Type: application/json" --data "$body"); fi
  local code
  code=$(curl "${args[@]}" "$url" 2>/dev/null)
  if [ "$code" = "$expect" ]; then
    printf "%s PASS %s  %-4s %-32s %s(%s)%s\n" "$G" "$N" "$method" "$path" "$D" "$code" "$N"
    pass=$((pass+1))
  else
    printf "%s FAIL %s  %-4s %-32s got %s, want %s\n" "$R" "$N" "$method" "$path" "$code" "$expect"
    fail=$((fail+1))
  fi
}

# ---- 1. Login first to obtain a token ----
echo "${Y}Authenticating…${N}"
LOGIN_BODY="{\"email\":\"$EMAIL\",\"password\":\"$PASSWORD\"}"
LOGIN_RESP=$(curl -s -X POST -H "Content-Type: application/json" --data "$LOGIN_BODY" "$BASE/rest/user/login" 2>/dev/null)
if [ "$HAVE_JQ" = "1" ]; then
  TOKEN=$(printf '%s' "$LOGIN_RESP" | jq -r '.authentication.token // empty')
else
  TOKEN=$(printf '%s' "$LOGIN_RESP" | sed -n 's/.*"token":"\([^"]*\)".*/\1/p')
fi
if [ -n "$TOKEN" ]; then
  echo "${G}token acquired${N} (${#TOKEN} chars)"
else
  echo "${R}WARNING: could not get a token — auth tests will report 401${N}"
fi
echo "------------------------------------------------------------"

# ---- 2. Public / unauthenticated endpoints ----
echo "${Y}Public endpoints${N}"
check "health"        GET  "/health"                          200
check "app-version"   GET  "/rest/admin/application-version"  200
check "products"      GET  "/api/Products"                    200
check "product 1"     GET  "/api/Products/1"                  200
check "product 404"   GET  "/api/Products/999999"             404
check "search"        GET  "/rest/products/search?q=apple"    200
check "feedbacks"     GET  "/api/Feedbacks"                   200
check "login ok"      POST "/rest/user/login"                 200 noauth "$LOGIN_BODY"
check "login bad"     POST "/rest/user/login"                 401 noauth '{"email":"x@y.z","password":"nope"}'
check "feedback post" POST "/api/Feedbacks"                   201 noauth '{"comment":"smoke test","rating":5}'

echo "------------------------------------------------------------"
echo "${Y}Auth required — must reject anonymous (401)${N}"
check "whoami anon"     GET  "/rest/user/whoami"      401 noauth
check "users/1 anon"    GET  "/api/Users/1"           401 noauth
check "orders anon"     GET  "/api/Orders"            401 noauth
check "basket anon"     GET  "/rest/basket/0"         401 noauth
check "additem anon"    POST "/api/BasketItems"       401 noauth '{"ProductId":1,"quantity":1}'
check "put prod anon"   PUT  "/api/Products/1"        401 noauth '{"price":9.99}'

echo "------------------------------------------------------------"
echo "${Y}Auth required — with token${N}"
check "whoami"          GET  "/rest/user/whoami"      200 auth
check "users/1"         GET  "/api/Users/1"           200 auth
check "put product"     PUT  "/api/Products/1"        200 auth '{"description":"smoke-test update","price":9.99}'
check "add item"        POST "/api/BasketItems"       201 auth '{"ProductId":1,"quantity":1}'
check "view basket"     GET  "/rest/basket/0"         200 auth
check "checkout"        POST "/rest/basket/0/checkout" 200 auth
check "orders"          GET  "/api/Orders"            200 auth
check "register"        POST "/api/Users"             201 noauth "{\"email\":\"smoke-$(date +%s)@pimenta.fun\",\"password\":\"Passw0rd!\"}"

echo "------------------------------------------------------------"
echo "${Y}Method / route negative checks${N}"
check "wrong method"    DELETE "/api/Products/1"      404 auth
check "unknown route"   GET  "/api/DoesNotExist"      404 noauth

echo "------------------------------------------------------------"
TOTAL=$((pass+fail))
if [ "$fail" -eq 0 ]; then
  echo "${G}ALL PASSED${N}  ($pass/$TOTAL)"
  exit 0
else
  echo "${R}$fail FAILED${N}, $pass passed  ($TOTAL total)"
  exit 1
fi
