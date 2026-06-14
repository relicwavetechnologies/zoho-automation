from company_identity import CompanyIdentityDB


def test_resolve_channel_identity_creates_company_user_and_session_binding(tmp_path, monkeypatch):
    monkeypatch.setenv("HERMES_COMPANY_ID", "company_emiac")
    monkeypatch.setenv("HERMES_COMPANY_SLUG", "emiac")
    monkeypatch.setenv("HERMES_COMPANY_NAME", "EMIAC")

    db = CompanyIdentityDB(tmp_path / "company.db")
    try:
        identity = db.resolve_channel_identity(
            platform="feishu",
            chat_id="oc_chat",
            user_id="ou_user",
            user_id_alt="on_union",
            user_name="Abhishek",
            thread_id="thread-1",
        )

        assert identity.company_id == "company_emiac"
        assert identity.company_user_id
        assert identity.channel_identity_id

        channel = db.get_channel_identity(identity.channel_identity_id)
        assert channel is not None
        assert channel["platform"] == "lark"
        assert channel["platform_user_id"] == "ou_user"
        assert channel["platform_user_id_alt"] == "on_union"
        assert channel["platform_chat_id"] == "oc_chat"
        assert channel["display_name"] == "Abhishek"

        db.bind_session_identity(
            session_id="session-1",
            session_key="agent:main:feishu:dm:oc_chat",
            identity=identity,
            platform="feishu",
            chat_id="oc_chat",
            thread_id="thread-1",
        )
        session_identity = db.get_session_identity("session-1")
        assert session_identity is not None
        assert session_identity["company_id"] == "company_emiac"
        assert session_identity["company_user_id"] == identity.company_user_id
        assert session_identity["channel_identity_id"] == identity.channel_identity_id
        assert session_identity["platform"] == "lark"
        by_user = db.list_session_identities_for_company_user(identity.company_user_id)
        assert [row["session_id"] for row in by_user] == ["session-1"]
    finally:
        db.close()


def test_channel_identity_without_user_binds_channel_only(tmp_path):
    db = CompanyIdentityDB(tmp_path / "company.db")
    try:
        identity = db.resolve_channel_identity(
            platform="webhook",
            chat_id="inbound-hook",
        )

        assert identity.company_id == "company_default"
        assert identity.company_user_id is None

        channel = db.get_channel_identity(identity.channel_identity_id)
        assert channel is not None
        assert channel["identity_kind"] == "channel"
        assert channel["identity_key"] == "chat:inbound-hook"
    finally:
        db.close()


def test_upsert_dashboard_member_lists_only_current_company(tmp_path):
    db = CompanyIdentityDB(tmp_path / "company.db")
    try:
        alice = db.upsert_dashboard_member(
            provider="lark",
            provider_user_id="ou_alice",
            display_name="Alice Example",
            email="alice@example.com",
            company_id="company_alpha",
        )
        db.upsert_dashboard_member(
            provider="lark",
            provider_user_id="ou_bob",
            display_name="Bob Example",
            email="bob@example.com",
            company_id="company_beta",
        )

        fetched = db.get_company_user(alice["id"])
        assert fetched is not None
        assert fetched["role"] == "MEMBER"
        assert fetched["email"] == "alice@example.com"

        rows = db.list_company_users(company_id="company_alpha")
        assert [row["email"] for row in rows] == ["alice@example.com"]

        channels = db.list_channel_identities_for_company_user(alice["id"])
        assert len(channels) == 1
        assert channels[0]["platform"] == "lark"
        assert channels[0]["platform_user_id"] == "ou_alice"
        assert channels[0]["approved_source"] == "dashboard_auth"

        found = db.find_dashboard_company_user(
            provider="lark",
            provider_user_id="ou_alice",
            company_id="company_alpha",
        )
        assert found is not None
        assert found["email"] == "alice@example.com"

        company = db.get_company("company_alpha")
        assert company is not None
        assert company["display_name"]
    finally:
        db.close()


def test_dashboard_member_updates_preserve_admin_role_and_disabled_status_on_login(tmp_path):
    db = CompanyIdentityDB(tmp_path / "company.db")
    try:
        alice = db.upsert_dashboard_member(
            provider="lark",
            provider_user_id="ou_alice",
            display_name="Alice Example",
            email="alice@example.com",
            company_id="company_alpha",
        )

        updated = db.update_company_user(
            company_user_id=alice["id"],
            company_id="company_alpha",
            role="COMPANY_ADMIN",
            status="disabled",
        )
        assert updated is not None
        assert updated["role"] == "COMPANY_ADMIN"
        assert updated["status"] == "disabled"

        login_upsert = db.upsert_dashboard_member(
            provider="lark",
            provider_user_id="ou_alice",
            display_name="Alice Changed",
            email="alice@example.com",
            company_id="company_alpha",
        )

        assert login_upsert["role"] == "COMPANY_ADMIN"
        assert login_upsert["status"] == "disabled"
        assert login_upsert["display_name"] == "Alice Changed"
    finally:
        db.close()


def test_feishu_channel_reuses_existing_lark_dashboard_identity(tmp_path):
    db = CompanyIdentityDB(tmp_path / "company.db")
    try:
        member = db.upsert_dashboard_member(
            provider="lark",
            provider_user_id="ou_anish",
            display_name="Anish Suman",
            email="anish@emiactech.com",
            company_id="company_relicwave",
        )
        existing_channel = db.list_channel_identities_for_company_user(member["id"])[0]

        identity = db.resolve_channel_identity(
            platform="feishu",
            chat_id="oc_chat",
            user_id="ou_anish",
            user_name=None,
            company_id="company_relicwave",
        )

        assert identity.company_id == "company_relicwave"
        assert identity.company_user_id == member["id"]
        assert identity.channel_identity_id == existing_channel["id"]

        channel = db.get_channel_identity(identity.channel_identity_id)
        assert channel is not None
        assert channel["platform"] == "lark"
        assert channel["platform_chat_id"] == "oc_chat"
        assert channel["display_name"] == "Anish Suman"

        company_user = db.get_company_user(member["id"])
        assert company_user is not None
        assert company_user["email"] == "anish@emiactech.com"
    finally:
        db.close()
