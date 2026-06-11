from enterprise.identity import EnterpriseIdentityEnvelope


def test_identity_envelope_accepts_snake_case_fields():
    envelope = EnterpriseIdentityEnvelope.from_mapping(
        {
            "company_id": "company_1",
            "company_user_id": "cu_1",
            "channel_identity_id": "ci_1",
            "company_role": "ADMIN",
            "department_id": "dept_1",
            "session_key": "agent:main:lark:dm:chat",
        }
    )

    assert envelope.company_id == "company_1"
    assert envelope.company_user_id == "cu_1"
    assert envelope.channel_identity_id == "ci_1"
    assert envelope.company_role == "ADMIN"
    assert envelope.department_id == "dept_1"
    assert envelope.session_key == "agent:main:lark:dm:chat"


def test_identity_envelope_accepts_camel_case_fields():
    envelope = EnterpriseIdentityEnvelope.from_mapping(
        {
            "companyId": "company_1",
            "companyUserId": "cu_1",
            "channelIdentityId": "ci_1",
            "companyRole": "MEMBER",
            "departmentId": "dept_1",
            "sessionKey": "agent:main:desktop:user",
        }
    )

    assert envelope.session_vars() == {
        "company_id": "company_1",
        "company_user_id": "cu_1",
        "channel_identity_id": "ci_1",
        "company_role": "MEMBER",
        "department_id": "dept_1",
    }


def test_identity_envelope_uses_session_key_fallback():
    envelope = EnterpriseIdentityEnvelope.from_mapping({}, session_key="fallback")

    assert envelope.session_key == "fallback"


def test_from_session_entry_produces_same_fields_as_from_mapping():
    """Runtime parity: desktop (from_session_entry) and API (from_mapping) paths
    both produce the same EnterpriseIdentityEnvelope shape for set_session_vars().

    This is the canonical assertion that enterprise identity is transport-agnostic:
    a desktop-originated SessionEntry and an API request body with the same company
    context produce identical envelope fields.
    """
    from types import SimpleNamespace

    entry = SimpleNamespace(
        company_id="company_abc",
        company_user_id="cu_desktop_001",
        channel_identity_id="ci_desktop_456",
        company_role="MEMBER",
        department_id="dept_eng",
        session_key="agent:main:desktop:user_abc",
    )

    from_entry = EnterpriseIdentityEnvelope.from_session_entry(entry)
    from_api = EnterpriseIdentityEnvelope.from_mapping(
        {
            "company_id": "company_abc",
            "company_user_id": "cu_desktop_001",
            "channel_identity_id": "ci_desktop_456",
            "company_role": "MEMBER",
            "department_id": "dept_eng",
            "session_key": "agent:main:desktop:user_abc",
        }
    )

    assert from_entry.session_vars() == from_api.session_vars()
    assert from_entry.as_event_payload() == from_api.as_event_payload()


def test_from_session_entry_handles_none_fields_gracefully():
    """from_session_entry must not fail when optional fields are None (fresh session)."""
    from types import SimpleNamespace

    entry = SimpleNamespace(
        company_id=None,
        company_user_id=None,
        channel_identity_id=None,
        company_role=None,
        department_id=None,
        session_key="agent:main:desktop:fresh",
    )

    envelope = EnterpriseIdentityEnvelope.from_session_entry(entry)

    assert envelope.company_id == ""
    assert envelope.company_user_id == ""
    assert envelope.channel_identity_id == ""
    assert envelope.company_role == ""
    assert envelope.department_id == ""
    assert envelope.session_key == "agent:main:desktop:fresh"


def test_from_session_entry_session_key_override():
    """Caller can override the session key from the entry (approval routing)."""
    from types import SimpleNamespace

    entry = SimpleNamespace(
        company_id="c1",
        company_user_id="cu1",
        channel_identity_id="",
        company_role="",
        department_id="",
        session_key="agent:main:desktop:user",
    )

    envelope = EnterpriseIdentityEnvelope.from_session_entry(entry, session_key="override-key")
    assert envelope.session_key == "override-key"
