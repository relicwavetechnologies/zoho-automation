"""Google Calendar grouped tool handler."""

from __future__ import annotations

from typing import Any

from tools.google._helpers import ok, resolve_client_and_scopes
from tools.registry import tool_error

CALENDAR_BASE = "https://www.googleapis.com/calendar/v3"

CALENDAR_OPS = frozenset({
    "calendars_list",
    "events_list",
    "event_create",
    "event_update",
    "event_delete",
    "free_busy",
    "event_create_meet",
})

CALENDAR_SCHEMA = {
    "name": "google_calendar",
    "description": (
        "Google Calendar for the connected account. Operations: calendars_list, events_list, "
        "event_create, event_update, event_delete, free_busy, event_create_meet."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "op": {"type": "string", "enum": sorted(CALENDAR_OPS)},
            "calendarId": {"type": "string", "description": "Calendar id (default primary)."},
            "eventId": {"type": "string"},
            "timeMin": {"type": "string", "description": "ISO datetime lower bound."},
            "timeMax": {"type": "string", "description": "ISO datetime upper bound."},
            "summary": {"type": "string"},
            "description": {"type": "string"},
            "location": {"type": "string"},
            "start": {"type": "string", "description": "Event start ISO datetime."},
            "end": {"type": "string", "description": "Event end ISO datetime."},
            "attendees": {"type": "array", "items": {"type": "string"}},
            "timeZone": {"type": "string"},
            "items": {
                "type": "array",
                "description": "For free_busy: [{calendarId, timeMin, timeMax}]",
                "items": {"type": "object"},
            },
            "maxResults": {"type": "integer", "minimum": 1, "maximum": 250},
        },
        "required": ["op"],
    },
}


def _calendar_id(args: dict[str, Any]) -> str:
    return str(args.get("calendarId") or "primary").strip() or "primary"


async def handle_calendar(args: dict[str, Any], **kwargs: Any) -> str:
    op = str(args.get("op") or "").strip()
    if op not in CALENDAR_OPS:
        return tool_error(f"Unknown google_calendar operation: {op}", success=False)

    client, err = await resolve_client_and_scopes(kwargs, "google_calendar", op)
    if err:
        return err

    try:
        if op == "calendars_list":
            data = await client.request("GET", f"{CALENDAR_BASE}/users/me/calendarList")
            items = [
                {"id": c.get("id"), "summary": c.get("summary"), "primary": c.get("primary")}
                for c in (data or {}).get("items", [])
            ]
            return ok(items)

        if op == "events_list":
            cal = _calendar_id(args)
            params: dict[str, Any] = {
                "singleEvents": True,
                "orderBy": "startTime",
                "maxResults": max(1, min(250, int(args.get("maxResults") or 25))),
            }
            if args.get("timeMin"):
                params["timeMin"] = str(args["timeMin"])
            if args.get("timeMax"):
                params["timeMax"] = str(args["timeMax"])
            data = await client.request("GET", f"{CALENDAR_BASE}/calendars/{cal}/events", params=params)
            events = []
            for event in (data or {}).get("items", []):
                start = event.get("start", {})
                end = event.get("end", {})
                events.append({
                    "id": event.get("id"),
                    "summary": event.get("summary"),
                    "start": start.get("dateTime") or start.get("date"),
                    "end": end.get("dateTime") or end.get("date"),
                    "htmlLink": event.get("htmlLink"),
                    "location": event.get("location"),
                })
            return ok(events)

        if op in ("event_create", "event_create_meet"):
            cal = _calendar_id(args)
            start = str(args.get("start") or "").strip()
            end = str(args.get("end") or "").strip()
            if not start or not end:
                return tool_error("start and end are required", success=False, operation=op)
            tz = str(args.get("timeZone") or "UTC")
            body: dict[str, Any] = {
                "summary": str(args.get("summary") or ""),
                "start": {"dateTime": start, "timeZone": tz},
                "end": {"dateTime": end, "timeZone": tz},
            }
            if args.get("description"):
                body["description"] = str(args["description"])
            if args.get("location"):
                body["location"] = str(args["location"])
            if args.get("attendees"):
                body["attendees"] = [{"email": e.strip()} for e in args["attendees"] if str(e).strip()]
            params: dict[str, Any] = {}
            if op == "event_create_meet":
                body["conferenceData"] = {
                    "createRequest": {
                        "requestId": f"hermes-{start}-{end}"[:64],
                        "conferenceSolutionKey": {"type": "hangoutsMeet"},
                    }
                }
                params["conferenceDataVersion"] = 1
            data = await client.request(
                "POST",
                f"{CALENDAR_BASE}/calendars/{cal}/events",
                params=params,
                json_body=body,
            )
            meet_link = ""
            for entry in (data or {}).get("conferenceData", {}).get("entryPoints", []) or []:
                if entry.get("entryPointType") == "video":
                    meet_link = str(entry.get("uri") or "")
            return ok(data, meetLink=meet_link, message="Event created.")

        if op == "event_update":
            cal = _calendar_id(args)
            event_id = str(args.get("eventId") or "").strip()
            if not event_id:
                return tool_error("eventId is required for event_update", success=False, operation=op)
            body = {}
            for key in ("summary", "description", "location"):
                if args.get(key):
                    body[key] = str(args[key])
            tz = str(args.get("timeZone") or "UTC")
            if args.get("start"):
                body["start"] = {"dateTime": str(args["start"]), "timeZone": tz}
            if args.get("end"):
                body["end"] = {"dateTime": str(args["end"]), "timeZone": tz}
            if args.get("attendees"):
                body["attendees"] = [{"email": e.strip()} for e in args["attendees"] if str(e).strip()]
            data = await client.request(
                "PATCH",
                f"{CALENDAR_BASE}/calendars/{cal}/events/{event_id}",
                json_body=body,
            )
            return ok(data, message="Event updated.")

        if op == "event_delete":
            cal = _calendar_id(args)
            event_id = str(args.get("eventId") or "").strip()
            if not event_id:
                return tool_error("eventId is required for event_delete", success=False, operation=op)
            await client.request("DELETE", f"{CALENDAR_BASE}/calendars/{cal}/events/{event_id}")
            return ok({"eventId": event_id}, message="Event deleted.")

        if op == "free_busy":
            items = args.get("items")
            if not isinstance(items, list) or not items:
                cal = _calendar_id(args)
                items = [{
                    "id": cal,
                    "timeMin": str(args.get("timeMin") or ""),
                    "timeMax": str(args.get("timeMax") or ""),
                }]
            data = await client.request(
                "POST",
                f"{CALENDAR_BASE}/freeBusy",
                json_body={"items": items, "timeMin": str(args.get("timeMin") or ""), "timeMax": str(args.get("timeMax") or "")},
            )
            return ok(data)

        return tool_error(f"Unhandled google_calendar operation: {op}", success=False, operation=op)
    except Exception as exc:  # noqa: BLE001
        from tools.google_scope import map_google_api_error

        return map_google_api_error(exc, tool_name="google_calendar", operation=op)
