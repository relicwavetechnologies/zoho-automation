from tools.send_message_tool import SEND_MESSAGE_SCHEMA
from tools.skills_tool import SKILLS_LIST_SCHEMA, SKILL_VIEW_SCHEMA


class TestCapabilitySchemaDescriptions:
    def test_send_message_schema_requires_target_discovery_before_platform_claims(self):
        description = SEND_MESSAGE_SCHEMA["description"]
        target_description = SEND_MESSAGE_SCHEMA["parameters"]["properties"]["target"][
            "description"
        ]

        assert "do not name specific messaging platforms as available" in description
        assert "send_message(action='list')" in description
        assert "Do not infer which platform names are configured" in target_description

    def test_skill_schemas_mark_skills_as_reference_not_executable_capability(self):
        list_description = SKILLS_LIST_SCHEMA["description"]
        view_description = SKILL_VIEW_SCHEMA["description"]

        assert "procedural/reference skills" in list_description
        assert "not proof" in list_description
        assert "Do not list skill names as executable capabilities" in list_description
        assert "instructions only" in view_description
        assert "verify active tools and credentials" in view_description
