from enterprise.identity_repository import EnterpriseIdentityRepository


class FakeCursor:
    def __init__(self, row=None):
        self._row = row
        self.closed = False

    def fetchone(self):
        return self._row

    def close(self):
        self.closed = True


class FakeConnection:
    def __init__(self):
        self.calls = []

    def execute(self, sql, args):
        self.calls.append((sql, args))
        if 'RETURNING "id", "companyUserId", "identityKey", "aiRole"' in sql:
            return FakeCursor(
                {
                    "id": "ci_existing",
                    "companyUserId": args[2],
                    "identityKey": args[8],
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
    assert identity.channel_identity_id == "ci_existing"
    assert identity.identity_key == "user:ou_123"
    assert identity.company_role == "ADMIN"

    company_sql, company_args = connection.calls[0]
    user_sql, user_args = connection.calls[1]
    channel_sql, channel_args = connection.calls[2]
    assert 'INSERT INTO "Company"' in company_sql
    assert company_args == ("company_emiac-tech", "emiac-tech", "Emiac Tech")
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
