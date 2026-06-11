from enterprise.schema import (
    ENTERPRISE_TABLES,
    LOCAL_CACHE_STORES,
    REQUIRED_IDENTITY_CONTEXT_KEYS,
)


def test_schema_contract_contains_required_enterprise_tables_and_columns():
    tables = {table.name: table for table in ENTERPRISE_TABLES}

    assert "Company" in tables
    assert "RuntimeConversationMessage" in tables
    assert "HermesSessionBinding" in tables
    assert "HermesRunStats" in tables
    for table in ENTERPRISE_TABLES:
        assert table.required_columns


def test_identity_context_contract_includes_role_and_department():
    assert REQUIRED_IDENTITY_CONTEXT_KEYS == (
        "HERMES_COMPANY_ID",
        "HERMES_COMPANY_USER_ID",
        "HERMES_CHANNEL_IDENTITY_ID",
        "HERMES_COMPANY_ROLE",
        "HERMES_DEPARTMENT_ID",
        "HERMES_SESSION_KEY",
    )


def test_local_cache_contract_is_rebuildable_from_enterprise_tables():
    stores = {store.name: store for store in LOCAL_CACHE_STORES}
    enterprise_table_names = {table.name for table in ENTERPRISE_TABLES}

    assert set(stores) == {"state.db", "sessions.json", "company.db"}
    for store in stores.values():
        assert store.purpose
        assert set(store.rebuild_from_tables).issubset(enterprise_table_names)

    assert stores["state.db"].rebuild_from_tables == (
        "RuntimeConversation",
        "RuntimeConversationMessage",
        "RuntimeRun",
        "HermesSessionBinding",
    )
    assert stores["company.db"].rebuild_from_tables == (
        "Company",
        "CompanyUser",
        "ChannelIdentity",
    )
