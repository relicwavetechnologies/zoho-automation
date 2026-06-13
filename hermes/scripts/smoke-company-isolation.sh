#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HERMES_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

cd "$HERMES_ROOT"

cat <<'EOF'
Hermes company user isolation smoke

This is hermetic. It does not read production cookies, production auth tokens,
or real employee secrets. It simulates two Lark-authenticated employees:
  - Abhishek Verma
  - Anish Suman

It verifies dashboard /api/sessions* isolation for:
  - local company sidecar mode
  - enterprise DB-backed session mode
EOF

uv run pytest tests/smoke/test_company_user_isolation_smoke.py "$@"
