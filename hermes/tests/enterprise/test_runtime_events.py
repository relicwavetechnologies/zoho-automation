from enterprise.identity import EnterpriseIdentityEnvelope
from enterprise.runtime_events import RuntimeEventNormalizer, RuntimeIdentityContext


def test_runtime_event_normalizer_sequences_message_delta_with_identity():
    identity = RuntimeIdentityContext.from_envelope(
        EnterpriseIdentityEnvelope(
            company_id="company_1",
            company_user_id="cu_1",
            channel_identity_id="ci_1",
            company_role="ADMIN",
            department_id="dept_1",
            session_key="session-key",
        )
    )
    normalizer = RuntimeEventNormalizer(run_id="run_1", identity=identity)

    event = normalizer.normalize(
        {
            "event": "message.delta",
            "run_id": "run_1",
            "timestamp": 123.0,
            "delta": "hello",
        }
    )

    assert event.sequence == 1
    assert event.idempotency_key == "run_1:1:message.delta"
    assert event.message_role == "assistant"
    assert event.message_kind == "delta"
    assert event.content_text == "hello"
    assert event.identity.company_id == "company_1"
    assert event.as_dict()["identity"]["department_id"] == "dept_1"


def test_runtime_event_normalizer_maps_terminal_and_tool_events():
    normalizer = RuntimeEventNormalizer(run_id="run_1")

    tool = normalizer.normalize(
        {
            "event": "tool.completed",
            "run_id": "run_1",
            "tool": "zoho_books",
            "duration": 1.25,
        }
    )
    done = normalizer.normalize(
        {
            "event": "run.completed",
            "run_id": "run_1",
            "output": "done",
            "usage": {"input_tokens": 10, "output_tokens": 5},
        }
    )

    assert tool.sequence == 1
    assert tool.message_kind == "tool"
    assert tool.tool_name == "zoho_books"
    assert done.sequence == 2
    assert done.status == "completed"
    assert done.finish_reason == "completed"
    assert done.content_text == "done"
    assert done.usage == {"input_tokens": 10, "output_tokens": 5}
