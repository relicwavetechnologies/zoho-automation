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

    def execute(self, sql, args):
        self.calls.append((sql, args))
        if 'WHERE "companyId" = %s AND "email" = %s' in sql:
            email = args[1]
            for row in self.company_users.values():
                if row.get("companyId") == args[0] and row.get("email") == email:
                    return FakeCursor({"id": row["id"]})
            return FakeCursor()
        if 'INSERT INTO "CompanyUser"' in sql:
            row = {
                "id": args[0],
                "companyId": args[1],
                "email": args[2],
                "displayName": args[3],
                "role": args[4],
                "departmentId": args[5],
                "status": "active",
            }
            existing = self.company_users.get(row["id"], {})
            existing.update({k: v for k, v in row.items() if v is not None})
            self.company_users[row["id"]] = existing
            return FakeCursor()
        if 'UPDATE "CompanyUser"' in sql:
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
