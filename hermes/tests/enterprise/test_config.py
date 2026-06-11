from enterprise.config import EnterprisePostgresConfig


def test_enterprise_postgres_config_defaults_to_disabled(monkeypatch):
    monkeypatch.delenv("HERMES_ENTERPRISE_DATABASE_URL", raising=False)
    monkeypatch.delenv("DATABASE_URL", raising=False)
    monkeypatch.delenv("HERMES_ENTERPRISE_POSTGRES", raising=False)

    config = EnterprisePostgresConfig.from_env()

    assert config.enabled is False
    assert config.database_url == ""
    assert config.schema_name == "public"


def test_enterprise_postgres_config_reads_hermes_url_first(monkeypatch):
    monkeypatch.setenv("HERMES_ENTERPRISE_DATABASE_URL", "postgresql://hermes")
    monkeypatch.setenv("DATABASE_URL", "postgresql://fallback")
    monkeypatch.setenv("HERMES_ENTERPRISE_SCHEMA", "runtime")

    config = EnterprisePostgresConfig.from_env()

    assert config.enabled is True
    assert config.database_url == "postgresql://hermes"
    assert config.schema_name == "runtime"


def test_enterprise_postgres_explicit_disable_wins(monkeypatch):
    monkeypatch.setenv("HERMES_ENTERPRISE_DATABASE_URL", "postgresql://hermes")
    monkeypatch.setenv("HERMES_ENTERPRISE_POSTGRES", "false")

    config = EnterprisePostgresConfig.from_env()

    assert config.enabled is False
