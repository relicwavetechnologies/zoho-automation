from __future__ import annotations

from typing import Any

from enterprise import readiness
from enterprise.schema import ENTERPRISE_TABLES


class _Cursor:
    def __init__(self, rows):
        self._rows = rows

    def fetchall(self):
        return self._rows

    def close(self):
        pass


class _SchemaConnection:
    def __init__(self, missing_table: str | None = None, missing_column: tuple[str, str] | None = None):
        self.missing_table = missing_table
        self.missing_column = missing_column

    def execute(self, sql: str, args: tuple[Any, ...]):
        _schema, table_name = args
        if table_name == self.missing_table:
            return _Cursor([])
        table = next(table for table in ENTERPRISE_TABLES if table.name == table_name)
        columns = list(table.required_columns)
        if self.missing_column and self.missing_column[0] == table_name:
            columns.remove(self.missing_column[1])
        return _Cursor([{"column_name": column} for column in columns])


def _clear_company_env(monkeypatch):
    for name in (
        "HERMES_DASHBOARD_LARK_APP_ID",
        "HERMES_DASHBOARD_LARK_APP_SECRET",
        "LARK_APP_ID",
        "LARK_APP_SECRET",
        "HERMES_DASHBOARD_PUBLIC_URL",
        "HERMES_DESKTOP_REMOTE_URL",
        "HERMES_DESKTOP_REMOTE_AUTH_MODE",
        "HERMES_ENTERPRISE_DATABASE_URL",
        "DATABASE_URL",
        "HERMES_ENTERPRISE_POSTGRES",
        "ZOHO_TOKEN_ENCRYPTION_KEY",
    ):
        monkeypatch.delenv(name, raising=False)


def _set_valid_company_env(monkeypatch):
    monkeypatch.setenv("HERMES_DASHBOARD_LARK_APP_ID", "cli_lark")
    monkeypatch.setenv("HERMES_DASHBOARD_LARK_APP_SECRET", "secret")
    monkeypatch.setenv("HERMES_DASHBOARD_PUBLIC_URL", "http://127.0.0.1:9119")
    monkeypatch.setenv("HERMES_DESKTOP_REMOTE_URL", "http://127.0.0.1:9119")
    monkeypatch.setenv("HERMES_DESKTOP_REMOTE_AUTH_MODE", "oauth")
    monkeypatch.setenv("HERMES_ENTERPRISE_DATABASE_URL", "postgresql://hermes")
    monkeypatch.setenv("ZOHO_TOKEN_ENCRYPTION_KEY", "dev-secret")


def test_company_readiness_fails_closed_when_required_env_missing(monkeypatch):
    _clear_company_env(monkeypatch)

    report = readiness.collect_company_readiness(check_database=False)

    assert report["ok"] is False
    codes = {issue["code"] for issue in report["issues"]}
    assert "missing_lark_app_id" in codes
    assert "missing_enterprise_postgres" in codes
    assert "invalid_connector_encryption_key" in codes


def test_company_readiness_passes_with_required_env_without_db_probe(monkeypatch):
    _clear_company_env(monkeypatch)
    _set_valid_company_env(monkeypatch)

    report = readiness.collect_company_readiness(check_database=False)

    assert report["ok"] is True
    assert report["database_checked"] is False
    assert report["issues"] == []


def test_inspect_required_schema_reports_missing_table_and_column():
    missing_table = readiness.inspect_required_schema(
        _SchemaConnection(missing_table="RuntimeRun")
    )
    missing_column = readiness.inspect_required_schema(
        _SchemaConnection(missing_column=("HermesConnectorCredential", "payloadEncrypted"))
    )

    assert missing_table["ok"] is False
    assert missing_table["missing_tables"] == ["RuntimeRun"]
    assert missing_column["ok"] is False
    assert missing_column["missing_columns"] == {
        "HermesConnectorCredential": ["payloadEncrypted"]
    }


def test_company_readiness_can_probe_enterprise_schema(monkeypatch):
    _clear_company_env(monkeypatch)
    _set_valid_company_env(monkeypatch)
    monkeypatch.setattr(
        readiness,
        "get_enterprise_connection",
        lambda force_new=False: _SchemaConnection(),
    )

    report = readiness.collect_company_readiness(check_database=True)

    assert report["ok"] is True
    assert report["database_checked"] is True
    schema_check = next(check for check in report["checks"] if check["name"] == "enterprise_schema")
    assert schema_check["metadata"]["ok"] is True
