from enterprise.identity_repository import EnterpriseIdentityRepository


class FakeCursor:
    def __init__(self, row=None, rows=None):
        self._row = row
        self._rows = rows or []
        self.closed = False

    def fetchone(self):
        return self._row

    def fetchall(self):
        return self._rows

    def close(self):
        self.closed = True


class FakeConnection:
    def __init__(self):
        self.calls = []
        self.company_users = {}
        self.channel_identities = {}
        self.session_bindings = {}
        self.runtime_conversations = {}

    def execute(self, sql, args):
        self.calls.append((sql, args))
        if 'WHERE "companyId" = %s AND "email" = %s' in sql:
            email = args[1]
            for row in self.company_users.values():
                if row.get("companyId") == args[0] and row.get("email") == email:
                    return FakeCursor({"id": row["id"]})
            return FakeCursor()
        if 'INSERT INTO "CompanyUser"' in sql:
            existing = self.company_users.get(args[0], {})
            role_value = args[4] or existing.get("role") or "MEMBER"
            row = {
                "id": args[0],
                "companyId": args[1],
                "email": args[2],
                "displayName": args[3],
                "role": role_value,
                "departmentId": args[5],
                "status": existing.get("status", "active"),
            }
            existing.update({k: v for k, v in row.items() if v is not None})
            self.company_users[row["id"]] = existing
            return FakeCursor()
        if 'UPDATE "CompanyUser"' in sql:
            if 'WHERE "id" = %s AND "companyId" = %s' in sql:
                row = self.company_users.setdefault(args[-2], {"id": args[-2]})
                idx = 0
                if '"role" = %s' in sql:
                    row["role"] = args[idx]
                    idx += 1
                if '"status" = %s' in sql:
                    row["status"] = args[idx]
                row["companyId"] = args[-1]
            else:
                row = self.company_users.setdefault(args[1], {"id": args[1]})
                row["status"] = args[0]
            return FakeCursor()
        if 'SELECT "id", "companyId", "email", "displayName", "role", "departmentId"' in sql:
            if 'WHERE "id" = %s' in sql:
                return FakeCursor(self.company_users.get(args[0]))
            return FakeCursor(rows=[
                row for row in self.company_users.values()
                if row.get("companyId") == args[0]
            ])
        if 'INSERT INTO "RuntimeConversation"' in sql:
            row = {
                "id": args[0],
                "companyId": args[1],
                "departmentId": args[2],
                "channel": args[3],
                "channelConversationKey": args[4],
                "rawChannelKey": args[5],
                "createdByUserId": args[6],
            }
            self.runtime_conversations[(args[1], args[3], args[4])] = row
            return FakeCursor({"id": row["id"]})
        if 'INSERT INTO "HermesSessionBinding"' in sql:
            row = {
                "hermesSessionId": args[2],
                "sessionKey": args[3],
                "companyId": args[1],
                "conversationId": args[4],
                "channelIdentityId": args[5],
                "resolvedUserId": args[6],
                "platform": args[7],
                "chatId": args[8],
                "threadId": args[9],
                "source": args[10],
            }
            self.session_bindings[args[2]] = row
            return FakeCursor()
        if 'FROM "ChannelIdentity"' in sql and 'WHERE "companyId" = %s' in sql:
            company_id, channel, identity_key, external_user_id, lark_open_id, user_id_alt = args
            for row in self.channel_identities.values():
                if row.get("companyId") != company_id:
                    continue
                same_channel = (
                    row.get("channel") == channel
                    and (
                        row.get("identityKey") == identity_key
                        or row.get("externalUserId") == external_user_id
                    )
                )
                same_lark_open_id = row.get("larkOpenId") and row.get("larkOpenId") == lark_open_id
                same_alt = row.get("platformUserIdAlt") and row.get("platformUserIdAlt") == user_id_alt
                if same_channel or same_lark_open_id or same_alt:
                    return FakeCursor(row)
            return FakeCursor()
        if 'SELECT "hermesSessionId", "sessionKey", "companyId", "resolvedUserId"' in sql:
            if 'WHERE "hermesSessionId" = %s' in sql:
                return FakeCursor(self.session_bindings.get(args[0]))
            return FakeCursor(
                rows=[
                    row
                    for row in self.session_bindings.values()
                    if row.get("resolvedUserId") == args[0]
                ]
            )
        if 'RETURNING "id", "companyUserId", "identityKey", "aiRole"' in sql:
            row = {
                "id": args[0],
                "companyId": args[1],
                "companyUserId": args[2],
                "channel": args[3],
                "externalUserId": args[4],
                "displayName": args[6],
                "identityKey": args[8],
                "platformUserIdAlt": args[9],
                "platformChatId": args[10],
                "platformWorkspaceId": args[11],
                "aiRole": "ADMIN",
            }
            key = (row["channel"], row["externalUserId"], row["companyId"])
            existing = self.channel_identities.get(key, {})
            for field, value in row.items():
                if field == "displayName" and value is None:
                    continue
                existing[field] = value
            self.channel_identities[key] = existing
            return FakeCursor(
                {
                    "id": existing["id"],
                    "companyUserId": existing.get("companyUserId"),
                    "identityKey": existing["identityKey"],
                    "aiRole": "ADMIN",
                }
            )
        return FakeCursor()


def test_enterprise_identity_repository_upserts_company_user_and_channel(monkeypatch):
    monkeypatch.setenv("HERMES_COMPANY_SLUG", "Emiac Tech")
    monkeypatch.setenv("HERMES_COMPANY_NAME", "Emiac Tech")
    connection = FakeConnection()
    repo = EnterpriseIdentityRepository(connection)

    identity = repo.resolve_channel_identity(
        platform="lark",
        chat_id="chat_1",
        user_id="ou_123",
        user_name="Alice",
        user_id_alt="u_123",
        platform_workspace_id="tenant_1",
        raw={"message_id": "m_1"},
    )

    assert identity.company_id == "company_emiac-tech"
    assert identity.company_user_id
    assert identity.channel_identity_id
    assert identity.identity_key == "user:ou_123"
    assert identity.company_role == "ADMIN"

    company_sql, company_args = connection.calls[0]
    lookup_sql, _lookup_args = connection.calls[1]
    user_sql, user_args = connection.calls[2]
    channel_sql, channel_args = connection.calls[3]
    assert 'INSERT INTO "Company"' in company_sql
    assert company_args == ("company_emiac-tech", "emiac-tech", "Emiac Tech")
    assert 'FROM "ChannelIdentity"' in lookup_sql
    assert 'INSERT INTO "CompanyUser"' in user_sql
    assert user_args[:2] == (identity.company_user_id, "company_emiac-tech")
    assert 'INSERT INTO "ChannelIdentity"' in channel_sql
    assert 'ON CONFLICT ("channel", "externalUserId", "companyId")' in channel_sql
    assert channel_args[3:6] == ("lark", "ou_123", "tenant_1")


def test_enterprise_identity_repository_supports_channel_only_identity(monkeypatch):
    monkeypatch.delenv("HERMES_COMPANY_ID", raising=False)
    monkeypatch.delenv("HERMES_COMPANY_SLUG", raising=False)
    connection = FakeConnection()
    repo = EnterpriseIdentityRepository(connection)

    identity = repo.resolve_channel_identity(platform="desktop", chat_id="local")

    assert identity.company_id == "company_default"
    assert identity.company_user_id is None
    assert identity.identity_key == "chat:local"
    assert len(connection.calls) == 2
    channel_args = connection.calls[-1][1]
    assert channel_args[4] == "chat:local"
    assert channel_args[5] == "local"


def test_enterprise_identity_repository_reuses_imported_lark_identity(monkeypatch):
    monkeypatch.delenv("HERMES_COMPANY_ID", raising=False)
    connection = FakeConnection()
    connection.channel_identities[("lark", "ou_anish", "company_relicwave")] = {
        "id": "ci_imported_anish",
        "companyId": "company_relicwave",
        "companyUserId": None,
        "channel": "lark",
        "externalUserId": "ou_anish",
        "larkOpenId": "ou_anish",
        "email": "anish@emiactech.com",
        "displayName": "Anish Suman",
        "identityKey": "user:ou_anish",
    }
    repo = EnterpriseIdentityRepository(connection)

    identity = repo.resolve_channel_identity(
        platform="feishu",
        chat_id="oc_chat",
        user_id="ou_anish",
        user_name=None,
        company_id="company_relicwave",
    )

    assert identity.company_id == "company_relicwave"
    assert identity.channel_identity_id == "ci_imported_anish"
    assert identity.company_user_id

    company_user = connection.company_users[identity.company_user_id]
    assert company_user["email"] == "anish@emiactech.com"
    assert company_user["displayName"] == "Anish Suman"

    channel = connection.channel_identities[("lark", "ou_anish", "company_relicwave")]
    assert channel["companyUserId"] == identity.company_user_id
    assert channel["platformChatId"] == "oc_chat"


def test_enterprise_identity_repository_upserts_dashboard_member(monkeypatch):
    monkeypatch.setenv("HERMES_COMPANY_ID", "company_alpha")
    connection = FakeConnection()
    repo = EnterpriseIdentityRepository(connection)

    member = repo.upsert_dashboard_member(
        provider="lark",
        provider_user_id="ou_alice",
        display_name="Alice Example",
        email="alice@example.com",
    )

    assert member["companyId"] == "company_alpha"
    assert member["email"] == "alice@example.com"
    rows = repo.list_company_users(company_id="company_alpha")
    assert [row["email"] for row in rows] == ["alice@example.com"]


def test_enterprise_identity_repository_updates_member_and_preserves_disabled(monkeypatch):
    monkeypatch.setenv("HERMES_COMPANY_ID", "company_alpha")
    connection = FakeConnection()
    repo = EnterpriseIdentityRepository(connection)

    member = repo.upsert_dashboard_member(
        provider="lark",
        provider_user_id="ou_alice",
        display_name="Alice Example",
        email="alice@example.com",
    )
    updated = repo.update_company_user(
        company_user_id=member["id"],
        company_id="company_alpha",
        role="COMPANY_ADMIN",
        status="disabled",
    )
    assert updated is not None
    assert updated["role"] == "COMPANY_ADMIN"
    assert updated["status"] == "disabled"

    login_upsert = repo.upsert_dashboard_member(
        provider="lark",
        provider_user_id="ou_alice",
        display_name="Alice Changed",
        email="alice@example.com",
    )
    assert login_upsert["role"] == "COMPANY_ADMIN"
    assert login_upsert["status"] == "disabled"


def test_enterprise_identity_repository_binds_and_lists_session_identity(monkeypatch):
    monkeypatch.setenv("HERMES_COMPANY_ID", "company_alpha")
    connection = FakeConnection()
    repo = EnterpriseIdentityRepository(connection)

    repo.bind_session_identity(
        session_id="session-1",
        session_key="session-1",
        identity=type(
            "Identity",
            (),
            {
                "company_id": "company_alpha",
                "company_user_id": "cu_1",
                "channel_identity_id": "ci_1",
                "department_id": "dept_1",
            },
        )(),
        platform="tui",
        chat_id="session-1",
        binding_source="tui_gateway",
    )

    binding = repo.get_session_identity("session-1")
    assert binding is not None
    assert binding["company_id"] == "company_alpha"
    assert binding["company_user_id"] == "cu_1"
    assert binding["channel_identity_id"] == "ci_1"

    by_user = repo.list_session_identities_for_company_user("cu_1")
    assert [row["session_id"] for row in by_user] == ["session-1"]
