#!/usr/bin/env bash
#
# Exercise the Turnstile Worker: GET injection, POST verify (pass & fail), and
# the anti-bypass hardening checks (replay, hostname, action, stale token).
#
# Prereqs (two terminals):
#   1. Serve the mock origin:
#        cd test && python3 -m http.server 8080
#   2. Run the Worker pointed at that origin:
#        ORIGIN_URL=http://localhost:8080  ->  set in wrangler.toml [vars] or .dev.vars
#        npx wrangler dev --port 8787
#
# Turnstile TEST keys (https://developers.cloudflare.com/turnstile/troubleshooting/testing/):
#   sitekey  1x00000000000000000000AA              -> always passes (visible)
#   secret   1x0000000000000000000000000000000AA   -> siteverify always PASSES (use for pass path)
#   secret   2x0000000000000000000000000000000AA   -> siteverify always FAILS  (use for fail path)
#   dummy client token: XXXX.DUMMY.TOKEN.XXXX
#
# NOTE on the "pass" path: the mock origin is `python3 -m http.server`, which
# returns 501 for POST. That's expected — any non-403 code means verification
# PASSED and the request reached origin. Reject paths return 403 from the Worker
# itself, before origin is ever contacted.
#
# Usage:
#   ./curl-tests.sh            # baseline suite (tests 1-4 + replay if KV bound)
#   ./curl-tests.sh baseline   # same as above
#   ./curl-tests.sh replay     # token single-use (needs TOKEN_REPLAY KV bound)
#   ./curl-tests.sh hostname   # hostname allowlist rejection
#   ./curl-tests.sh action     # action-binding rejection
#   ./curl-tests.sh stale      # token freshness rejection
#   ./curl-tests.sh fail       # failing-secret rejection
#   ./curl-tests.sh all        # print guidance for every group
#
set -euo pipefail

WORKER="${WORKER:-http://localhost:8787}"
DUMMY_TOKEN="${DUMMY_TOKEN:-XXXX.DUMMY.TOKEN.XXXX}"
SUBMIT="${SUBMIT:-$WORKER/submit}"

hr()   { printf '\n\033[1;34m== %s ==\033[0m\n' "$1"; }
pass() { printf '  \033[1;32mPASS\033[0m %s\n' "$1"; }
fail() { printf '  \033[1;31mFAIL\033[0m %s\n' "$1"; }
info() { printf '  \033[0;90m%s\033[0m\n' "$1"; }

# assert_code <expected> <desc> <curl args...>
assert_code() {
  local want="$1" desc="$2"; shift 2
  local got; got=$(curl -s -o /dev/null -w "%{http_code}" "$@")
  [ "$got" = "$want" ] && pass "$desc (HTTP $got)" || fail "$desc (want $want, got $got)"
}

# assert_not_403 <desc> <curl args...>  — pass path: reached origin
assert_not_403() {
  local desc="$1"; shift
  local got; got=$(curl -s -o /dev/null -w "%{http_code}" "$@")
  [ "$got" != "403" ] \
    && pass "$desc → forwarded to origin (HTTP $got)" \
    || fail "$desc (unexpected 403 — verification blocked it)"
}

post_form()  { curl -s -X POST "$SUBMIT" -H "Content-Type: application/x-www-form-urlencoded" "$@"; }
post_json()  { curl -s -X POST "$SUBMIT" -H "Content-Type: application/json" "$@"; }

# ---------------------------------------------------------------- baseline ----
baseline() {
  hr "1. GET / — expect injected turnstile script + cf-turnstile widget"
  if curl -s "$WORKER/" | grep -Eiq 'turnstile/v0/api\.js|class="cf-turnstile"'; then
    pass "injection present"
  else
    fail "injection NOT found"
  fi

  hr "2. POST with NO token — expect 403 (origin never hit)"
  assert_code 403 "missing token rejected" \
    -X POST "$SUBMIT" -H "Content-Type: application/x-www-form-urlencoded" --data "username=user@example.com&password=hunter2"

  hr "3. POST with token (urlencoded) — pass path (secret must be 1x...PASS key)"
  assert_not_403 "urlencoded token accepted" \
    -X POST "$SUBMIT" -H "Content-Type: application/x-www-form-urlencoded" \
    --data-urlencode "username=user@example.com" --data-urlencode "password=hunter2" --data-urlencode "cf-turnstile-response=$DUMMY_TOKEN"

  hr "4. POST as JSON — same verify path via JSON body"
  assert_not_403 "json token accepted" \
    -X POST "$SUBMIT" -H "Content-Type: application/json" \
    --data "{\"username\":\"user@example.com\",\"password\":\"hunter2\",\"cf-turnstile-response\":\"$DUMMY_TOKEN\"}"

  hr "5. Replay — same token twice (needs TOKEN_REPLAY KV bound)"
  info "1st use should reach origin; 2nd identical token should be 403 token-replayed."
  local uniq="RE.$(date +%s).$RANDOM"
  assert_not_403 "replay: first use accepted" \
    -X POST "$SUBMIT" -H "Content-Type: application/json" \
    --data "{\"username\":\"user@example.com\",\"cf-turnstile-response\":\"$uniq\"}"
  assert_code 403 "replay: second use rejected" \
    -X POST "$SUBMIT" -H "Content-Type: application/json" \
    --data "{\"username\":\"user@example.com\",\"cf-turnstile-response\":\"$uniq\"}"
  info "If BOTH were accepted, TOKEN_REPLAY KV is not bound — see wrangler.toml."

  hr "Done (baseline)"
}

# ------------------------------------------------------- hardening groups ----
replay() {
  hr "Replay / single-use"
  info "Requires TOKEN_REPLAY KV bound in wrangler.toml and secret=1x...PASS."
  local uniq="RE.$(date +%s).$RANDOM"
  assert_not_403 "first use accepted" \
    -X POST "$SUBMIT" -H "Content-Type: application/json" \
    --data "{\"cf-turnstile-response\":\"$uniq\"}"
  assert_code 403 "second use rejected (token-replayed)" \
    -X POST "$SUBMIT" -H "Content-Type: application/json" \
    --data "{\"cf-turnstile-response\":\"$uniq\"}"
}

hostname() {
  hr "Hostname allowlist"
  info "Set a deliberately-wrong host, restart wrangler, then run:"
  info '  EXPECTED_HOSTNAMES="nomatch.invalid" (in wrangler.toml [vars] or .dev.vars)'
  assert_code 403 "hostname-mismatch rejected" \
    -X POST "$SUBMIT" -H "Content-Type: application/json" \
    --data "{\"cf-turnstile-response\":\"$DUMMY_TOKEN\"}"
}

action() {
  hr "Action binding"
  info "Set an action the dummy token cannot satisfy, restart wrangler, then run:"
  info '  EXPECTED_ACTION="login"   (dummy test token carries no action → mismatch)'
  assert_code 403 "action-mismatch rejected" \
    -X POST "$SUBMIT" -H "Content-Type: application/json" \
    --data "{\"cf-turnstile-response\":\"$DUMMY_TOKEN\"}"
}

stale() {
  hr "Token freshness"
  info "Force staleness, restart wrangler, then run:"
  info '  MAX_TOKEN_AGE_SECONDS="-1"   (any token is immediately too old)'
  info "Note: only fires if siteverify returns challenge_ts for the test key."
  assert_code 403 "stale token rejected" \
    -X POST "$SUBMIT" -H "Content-Type: application/json" \
    --data "{\"cf-turnstile-response\":\"$DUMMY_TOKEN\"}"
}

failpath() {
  hr "Failing secret"
  info "Set the always-fails secret, restart wrangler, then run:"
  info '  TURNSTILE_SECRET="2x0000000000000000000000000000000AA"'
  assert_code 403 "siteverify failure rejected" \
    -X POST "$SUBMIT" -H "Content-Type: application/json" \
    --data "{\"cf-turnstile-response\":\"$DUMMY_TOKEN\"}"
}

all() {
  baseline
  info ""
  info "Hardening groups each need a specific config + wrangler restart:"
  info "  ./curl-tests.sh replay    (TOKEN_REPLAY KV bound)"
  info "  ./curl-tests.sh hostname  (EXPECTED_HOSTNAMES=nomatch.invalid)"
  info "  ./curl-tests.sh action    (EXPECTED_ACTION=login)"
  info "  ./curl-tests.sh stale     (MAX_TOKEN_AGE_SECONDS=-1)"
  info "  ./curl-tests.sh fail      (TURNSTILE_SECRET=2x...FAIL)"
}

case "${1:-baseline}" in
  baseline) baseline ;;
  replay)   replay ;;
  hostname) hostname ;;
  action)   action ;;
  stale)    stale ;;
  fail)     failpath ;;
  all)      all ;;
  *) echo "Unknown group: $1"; echo "Use: baseline|replay|hostname|action|stale|fail|all"; exit 2 ;;
esac
