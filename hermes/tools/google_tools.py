"""Hermes-native Google Workspace tools on per-company/user credentials."""

from __future__ import annotations

from tools.google.calendar import CALENDAR_SCHEMA, handle_calendar
from tools.google.docs import DOCS_SCHEMA, handle_docs
from tools.google.drive import DRIVE_SCHEMA, handle_drive
from tools.google.gmail import GMAIL_SCHEMA, handle_gmail
from tools.google.sheets import SHEETS_SCHEMA, handle_sheets
from tools.google.slides import SLIDES_SCHEMA, handle_slides
from tools.google_scope import make_google_check_fn
from tools.registry import registry

_GOOGLE_TOOLS = (
    ("gmail", GMAIL_SCHEMA, handle_gmail),
    ("google_calendar", CALENDAR_SCHEMA, handle_calendar),
    ("google_drive", DRIVE_SCHEMA, handle_drive),
    ("google_docs", DOCS_SCHEMA, handle_docs),
    ("google_sheets", SHEETS_SCHEMA, handle_sheets),
    ("google_slides", SLIDES_SCHEMA, handle_slides),
)

for _name, _schema, _handler in _GOOGLE_TOOLS:
    registry.register(
        name=_name,
        toolset="google",
        schema=_schema,
        handler=_handler,
        check_fn=make_google_check_fn(_name),
        is_async=True,
        emoji="📧" if _name == "gmail" else "📁",
        max_result_size_chars=100_000,
    )
