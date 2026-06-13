"""Company-mode readiness checks for Hermes enterprise runtime."""

from __future__ import annotations

import argparse
import json
import os
from collections.abc import Mapping
from typing import Any
from urllib.parse import urlparse

from .config import EnterprisePostgresConfig
from .db import get_enterprise_connection
from .schema import ENTERPRISE_TABLES
from .token_crypto import TokenCryptoError, resolve_key


def _truthy(value: str | None) -> bool:
    return str(value or "").strip().lower() in {"1", "true", "yes", "on"}


def _env_value(*names: str) -> tuple[str, str]:
    for name in names:
        value = os.getenv(name, "").strip()
        if value:
            return name, value
    return names[0], ""


def _valid_http_url(value: str) -> bool:
    parsed = urlparse(value)
    return parsed.scheme in {"http", "https"} and bool(parsed.netloc)


def _check(
    checks: list[dict[str, Any]],
    issues: list[dict[str, str]],
    *,
    name: str,
    ok: bool,
    message: str,
    code: str | None = None,
    remediation: str | None = None,
    component: str = "enterprise",
    metadata: dict[str, Any] | None = None,
) -> None:
    checks.append({
        "name": name,
        "ok": ok,
        "message": message,
        "metadata": metadata or {},
    })
    if not ok:
        issues.append({
            "component": component,
            "code": code or name,
            "message": message,
            "remediation": remediation or "",
        })


def _row_value(row: Any, key: str) -> Any:
    if isinstance(row, Mapping):
        return row.get(key)
    try:
        return row[key]
    except (KeyError, TypeError, IndexError):
        return None


def inspect_required_schema(connection: Any, *, schema_name: str = "public") -> dict[str, Any]:
    """Inspect required enterprise tables/columns without returning secrets."""
    missing_tables: list[str] = []
    missing_columns: dict[str, list[str]] = {}

    for table in ENTERPRISE_TABLES:
        result = connection.execute(
            """
            SELECT column_name
            FROM information_schema.columns
            WHERE table_schema = %s AND table_name = %s
            """,
            (schema_name, table.name),
        )
        fetchall = getattr(result, "fetchall", None)
        try:
            rows = list(fetchall() or []) if fetchall is not None else []
        finally:
            close = getattr(result, "close", None)
            if close is not None:
                close()
        columns = {str(_row_value(row, "column_name") or _row_value(row, 0) or "") for row in rows}
        columns.discard("")
        if not columns:
            missing_tables.append(table.name)
            continue
        missing = [column for column in table.required_columns if column not in columns]
        if missing:
            missing_columns[table.name] = missing

    return {
        "ok": not missing_tables and not missing_columns,
        "missing_tables": missing_tables,
        "missing_columns": missing_columns,
    }


def collect_company_readiness(*, check_database: bool = False) -> dict[str, Any]:
    """Return safe company-mode readiness details for startup and status APIs."""
    checks: list[dict[str, Any]] = []
    issues: list[dict[str, str]] = []

    app_id_name, app_id = _env_value("HERMES_DASHBOARD_LARK_APP_ID", "LARK_APP_ID")
    app_secret_name, app_secret = _env_value("HERMES_DASHBOARD_LARK_APP_SECRET", "LARK_APP_SECRET")
    public_url_name, public_url = _env_value("HERMES_DASHBOARD_PUBLIC_URL")
    desktop_url_name, desktop_url = _env_value("HERMES_DESKTOP_REMOTE_URL")
    auth_mode = os.getenv("HERMES_DESKTOP_REMOTE_AUTH_MODE", "").strip().lower()

    _check(
        checks,
        issues,
        name="lark_oauth_app_id",
        ok=bool(app_id),
        message="Lark dashboard OAuth app id is configured" if app_id else "Missing Lark dashboard OAuth app id",
        code="missing_lark_app_id",
        remediation="Set HERMES_DASHBOARD_LARK_APP_ID in hermes/.env",
        metadata={"env": app_id_name, "present": bool(app_id)},
    )
    _check(
        checks,
        issues,
        name="lark_oauth_app_secret",
        ok=bool(app_secret),
        message="Lark dashboard OAuth app secret is configured" if app_secret else "Missing Lark dashboard OAuth app secret",
        code="missing_lark_app_secret",
        remediation="Set HERMES_DASHBOARD_LARK_APP_SECRET in hermes/.env",
        metadata={"env": app_secret_name, "present": bool(app_secret)},
    )
    _check(
        checks,
        issues,
        name="dashboard_public_url",
        ok=bool(public_url) and _valid_http_url(public_url),
        message="Dashboard public URL is valid" if public_url else "Missing dashboard public URL",
        code="invalid_dashboard_public_url",
        remediation="Set HERMES_DASHBOARD_PUBLIC_URL to the exact hosted base URL",
        metadata={"env": public_url_name, "present": bool(public_url)},
    )
    _check(
        checks,
        issues,
        name="desktop_remote_url",
        ok=bool(desktop_url) and _valid_http_url(desktop_url),
        message="Desktop remote URL is valid" if desktop_url else "Missing desktop remote URL",
        code="invalid_desktop_remote_url",
        remediation="Set HERMES_DESKTOP_REMOTE_URL to the company Hermes backend URL",
        metadata={"env": desktop_url_name, "present": bool(desktop_url)},
    )
    _check(
        checks,
        issues,
        name="desktop_auth_mode",
        ok=auth_mode == "oauth",
        message="Desktop remote auth mode is oauth" if auth_mode == "oauth" else "Desktop remote auth mode must be oauth",
        code="invalid_desktop_auth_mode",
        remediation="Set HERMES_DESKTOP_REMOTE_AUTH_MODE=oauth",
        metadata={"env": "HERMES_DESKTOP_REMOTE_AUTH_MODE", "value": auth_mode or ""},
    )

    config = EnterprisePostgresConfig.from_env()
    _check(
        checks,
        issues,
        name="enterprise_postgres_config",
        ok=config.enabled and bool(config.database_url),
        message="Enterprise Postgres is configured" if config.enabled and config.database_url else "Enterprise Postgres is not configured",
        code="missing_enterprise_postgres",
        remediation="Set HERMES_ENTERPRISE_DATABASE_URL or DATABASE_URL and enable HERMES_ENTERPRISE_POSTGRES",
        metadata={
            "enabled": config.enabled,
            "database_url_present": bool(config.database_url),
            "schema": config.schema_name,
        },
    )

    try:
        resolve_key()
        crypto_ok = True
        crypto_message = "Connector encryption key is valid"
    except TokenCryptoError as exc:
        crypto_ok = False
        crypto_message = str(exc)
    _check(
        checks,
        issues,
        name="connector_encryption_key",
        ok=crypto_ok,
        message=crypto_message,
        code="invalid_connector_encryption_key",
        remediation="Set ZOHO_TOKEN_ENCRYPTION_KEY to the Hermes/Divo AES-GCM key",
        metadata={"env": "ZOHO_TOKEN_ENCRYPTION_KEY", "present": bool(os.getenv("ZOHO_TOKEN_ENCRYPTION_KEY", "").strip())},
    )

    if check_database and config.enabled and config.database_url:
        try:
            connection = get_enterprise_connection(force_new=True)
            schema = inspect_required_schema(connection, schema_name=config.schema_name)
            _check(
                checks,
                issues,
                name="enterprise_schema",
                ok=bool(schema["ok"]),
                message="Enterprise schema contains required Wave 04 tables/columns"
                if schema["ok"]
                else "Enterprise schema is missing required Wave 04 tables/columns",
                code="enterprise_schema_incomplete",
                remediation="Run enterprise migrations and verify the Divo/Hermes runtime schema",
                metadata=schema,
            )
        except Exception as exc:  # noqa: BLE001 — readiness must normalize startup failures
            _check(
                checks,
                issues,
                name="enterprise_database_connection",
                ok=False,
                message=f"Enterprise database check failed: {exc}",
                code="enterprise_database_unavailable",
                remediation="Verify Postgres is reachable and credentials are correct",
            )
    elif check_database:
        _check(
            checks,
            issues,
            name="enterprise_schema",
            ok=False,
            message="Enterprise schema was not checked because Postgres is not configured",
            code="enterprise_schema_not_checked",
            remediation="Configure Enterprise Postgres before starting company mode",
        )

    return {
        "ok": not issues,
        "mode": "company",
        "database_checked": check_database,
        "checks": checks,
        "issues": issues,
    }


def format_readiness_report(report: dict[str, Any]) -> str:
    if report.get("ok"):
        return "Hermes company readiness OK"
    lines = ["Hermes company readiness failed:"]
    for issue in report.get("issues", []):
        lines.append(f"  - {issue.get('code')}: {issue.get('message')}")
        remediation = str(issue.get("remediation") or "").strip()
        if remediation:
            lines.append(f"    Fix: {remediation}")
    return "\n".join(lines)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Check Hermes company-mode readiness")
    parser.add_argument("--company-dev", action="store_true", help="Run company dev-stack readiness checks")
    parser.add_argument("--check-database", action="store_true", help="Probe Postgres schema")
    parser.add_argument("--json", action="store_true", help="Emit JSON")
    args = parser.parse_args(argv)
    if not args.company_dev:
        parser.error("--company-dev is required")
    report = collect_company_readiness(check_database=args.check_database)
    if args.json:
        print(json.dumps(report, indent=2, sort_keys=True))
    else:
        print(format_readiness_report(report))
    return 0 if report.get("ok") else 1


if __name__ == "__main__":
    raise SystemExit(main())
