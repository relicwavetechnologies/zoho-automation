from __future__ import annotations

from company_lark_enrichment import LarkContactProfile
from company_member_profile import (
    resolve_lark_open_id,
    serialize_company_user,
    synthesize_session_company_user,
)


def test_serialize_company_user_uses_session_fallback_for_lark_open_id():
    row = {
        "id": "cu_test",
        "company_id": "company_alpha",
        "display_name": "Alice Example",
        "email": "alice@example.com",
        "role": "MEMBER",
        "department_id": None,
        "status": "active",
        "created_at": 1_700_000_000.0,
        "updated_at": 1_700_000_100.0,
    }
    profile = serialize_company_user(
        row,
        session_fallback={
            "provider": "lark",
            "user_id": "ou_alice",
            "email": "alice@example.com",
            "display_name": "Alice Example",
        },
        lark_enrichment={
            "ou_alice": LarkContactProfile(
                open_id="ou_alice",
                union_id="on_alice",
                user_id="u_alice",
                avatar_url="https://example.com/avatar.png",
                department_id="od_eng",
                department_name="Engineering",
            )
        },
        company_name="EMIAC",
        include_company_name=True,
    )

    assert profile["lark_open_id"] == "ou_alice"
    assert profile["lark_union_id"] == "on_alice"
    assert profile["avatar_url"] == "https://example.com/avatar.png"
    assert profile["department_name"] == "Engineering"
    assert profile["provider"] == "lark"
    assert profile["company_name"] == "EMIAC"


def test_resolve_lark_open_id_prefers_channel_identity():
    open_id = resolve_lark_open_id(
        channel_identities=[
            {
                "platform": "lark",
                "platform_user_id": "ou_from_channel",
                "approved_source": "dashboard_auth",
            }
        ],
        session_fallback={"provider": "lark", "user_id": "ou_from_session"},
    )
    assert open_id == "ou_from_channel"


def test_synthesize_session_company_user_builds_minimal_profile():
    profile = synthesize_session_company_user(
        {
            "provider": "lark",
            "user_id": "ou_browser",
            "email": "browser@example.com",
            "display_name": "Browser Login",
        },
        company_id="company_hermes",
        company_name="Hermes Co",
    )

    assert profile["company_id"] == "company_hermes"
    assert profile["company_name"] == "Hermes Co"
    assert profile["lark_open_id"] == "ou_browser"
    assert profile["email"] == "browser@example.com"
    assert profile["display_name"] == "Browser Login"
