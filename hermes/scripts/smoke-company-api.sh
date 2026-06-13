#!/usr/bin/env bash
# API-level checks for company-mode smoke (no desktop UI).
set -euo pipefail

BASE_URL="${HERMES_DASHBOARD_PUBLIC_URL:-http://127.0.0.1:9119}"
FAIL=0

pass() { echo "  PASS  $*"; }
fail() { echo "  FAIL  $*"; FAIL=1; }

echo "Company API smoke @ ${BASE_URL}"
echo

status="$(curl -fsS "${BASE_URL}/api/status" 2>/dev/null)" || {
  fail "GET /api/status unreachable"
  exit 1
}

if python3 -c "import json,sys; d=json.loads(sys.argv[1]); sys.exit(0 if d.get('auth_required') and 'lark' in (d.get('auth_providers') or []) else 1)" "$status" 2>/dev/null; then
  pass "GET /api/status auth_required + lark provider"
else
  fail "GET /api/status missing auth_required/lark ($(echo "$status" | head -c 120))"
fi

code="$(curl -sS -o /tmp/smoke-team.json -w '%{http_code}' "${BASE_URL}/api/company/team-members")"
if [[ "$code" == "401" ]] && grep -q 'login_url' /tmp/smoke-team.json; then
  pass "GET /api/company/team-members → 401 + login_url"
else
  fail "GET /api/company/team-members expected 401+login_url, got ${code}: $(cat /tmp/smoke-team.json 2>/dev/null | head -c 120)"
fi

code="$(curl -sS -o /tmp/smoke-me.json -w '%{http_code}' "${BASE_URL}/api/company/me")"
if [[ "$code" == "401" ]] && grep -q 'login_url' /tmp/smoke-me.json; then
  pass "GET /api/company/me → 401 + login_url"
else
  fail "GET /api/company/me expected 401+login_url, got ${code}"
fi

echo
if [[ "$FAIL" -eq 0 ]]; then
  echo "API smoke: all checks passed"
  exit 0
fi
echo "API smoke: failures above"
exit 1
