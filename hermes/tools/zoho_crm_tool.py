"""Hermes-native Zoho CRM model tool."""

from __future__ import annotations

from typing import Any

from tools.registry import registry, tool_error, tool_result
from tools.zoho_approval import require_zoho_write_approval
from tools.zoho_runtime import zoho_tool_available
from tools.zoho_client import (
    DEFAULT_INLINE_THRESHOLD,
    ZohoClient,
    build_deal_forecast,
    build_lead_report,
    build_pipeline_summary,
    format_crm_result,
    normalize_crm_module,
    parse_date_filter,
    records_to_csv,
)


CRM_READ_OPS = {
    "list",
    "get",
    "search",
    "search_text",
    "build_pipeline_summary",
    "build_lead_report",
    "build_deal_forecast",
}
CRM_WRITE_OPS = {"create", "update", "delete"}
CRM_MODULES = ["Leads", "Contacts", "Accounts", "Deals", "Tasks"]


ZOHO_CRM_SCHEMA = {
    "name": "zoho_crm",
    "description": (
        "Access Zoho CRM records and reports. Supports Divo-compatible "
        "operations for Leads, Contacts, Accounts, Deals, and Tasks: list, get, "
        "criteria search, free-text search, create, update, delete, pipeline "
        "summary, lead report, and deal forecast."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "op": {
                "type": "string",
                "enum": sorted(CRM_READ_OPS | CRM_WRITE_OPS),
                "description": "Divo-compatible operation name.",
            },
            "operation": {
                "type": "string",
                "description": "Alias for op. Prefer op for Divo compatibility.",
            },
            "module": {
                "type": "string",
                "enum": CRM_MODULES + [
                    "lead",
                    "contact",
                    "account",
                    "deal",
                    "task",
                    "opportunity",
                    "company",
                    "customer",
                ],
                "description": "CRM module for CRUD/search operations.",
            },
            "recordId": {"type": "string"},
            "criteria": {
                "type": "string",
                "description": "Zoho CRM criteria syntax, e.g. (Last_Name:contains:Smith).",
            },
            "query": {
                "type": "string",
                "description": "Free-text search query for search_text.",
            },
            "fields": {
                "type": "object",
                "additionalProperties": True,
                "description": "Zoho CRM record fields for create/update.",
            },
            "limit": {
                "type": "integer",
                "minimum": 1,
                "maximum": 200,
                "description": "Maximum inline records to return. Default 25.",
            },
            "sortBy": {"type": "string"},
            "sortOrder": {"type": "string", "enum": ["asc", "desc"]},
            "exportAll": {
                "type": "boolean",
                "description": "Exhaust all pages and include summary metadata.",
            },
            "exportCsv": {
                "type": "boolean",
                "description": "Include an inline CSV string for returned/exported rows.",
            },
            "csvColumns": {
                "type": "array",
                "items": {"type": "string"},
                "description": "Optional CSV column order.",
            },
            "closingFrom": {"type": "string"},
            "closingTo": {"type": "string"},
            "currency": {"type": "string"},
        },
        "required": ["op"],
    },
}


async def _handle_zoho_crm(args: dict[str, Any], **kwargs: Any) -> str:
    op = _operation(args)
    if not op:
        return tool_error("op is required", success=False)
    if op not in CRM_READ_OPS and op not in CRM_WRITE_OPS:
        return tool_error(f"Unknown Zoho CRM operation: {op}", success=False)

    try:
        from tools.zoho_runtime import resolve_tool_client

        client = resolve_tool_client(kwargs)
    except Exception as exc:
        return tool_error(_map_zoho_error(exc), success=False, operation=op)

    try:
        if op in CRM_WRITE_OPS:
            approved = require_zoho_write_approval(
                pattern_key=f"zoho_crm:{op}",
                action=f"zoho_crm {op}",
                description=_write_description(op, args),
                approval_callback=kwargs.get("approval_callback"),
            )
            if not approved.get("approved"):
                return tool_error(
                    approved.get("message") or "Zoho CRM write approval required.",
                    success=False,
                    operation=op,
                    status=approved.get("status", "blocked"),
                    approval_pending=approved.get("approval_pending", False),
                    pattern_key=approved.get("pattern_key"),
                )
            result = await _execute_write(client, op, args)
            result["approval"] = approved.get("approval")
            return tool_result(result)

        result = await _execute_read(client, op, args)
        return tool_result(result)
    except Exception as exc:
        return tool_error(_map_zoho_error(exc), success=False, operation=op)


async def _execute_read(
    client: ZohoClient,
    op: str,
    args: dict[str, Any],
) -> dict[str, Any]:
    if op == "list":
        module = _module(args, op)
        if bool(args.get("exportAll")):
            result = await client.crm_list_all_records(
                module,
                sort_by=_str_arg(args, "sortBy"),
                sort_order=_sort_order(args),
            )
            items = result["items"]
            inline = items[: _limit(args)]
            csv_text = _maybe_csv(args, items)
            message = f"Found {len(items)} {normalize_crm_module(module)} record(s)."
            if len(items) > len(inline):
                message += f" Showing {len(inline)} inline."
            if csv_text:
                message += " Inline CSV included."
            if result.get("truncated"):
                message += " Pagination limit reached; additional records may exist."
            return {
                "success": True,
                "data": format_crm_result(inline),
                "message": message,
                "truncated": bool(result.get("truncated")),
                "hasMore": len(items) > len(inline) or bool(result.get("truncated")),
                "report": {
                    "items": format_crm_result(inline),
                    "totalCount": len(items),
                    "truncated": bool(result.get("truncated")),
                    **({"csv": csv_text} if csv_text else {}),
                },
                **({"csv": csv_text} if csv_text else {}),
            }

        result = await client.crm_list_records(
            module,
            per_page=_limit(args),
            sort_by=_str_arg(args, "sortBy"),
            sort_order=_sort_order(args),
        )
        items = result["items"]
        return {
            "success": True,
            "data": format_crm_result(items),
            "message": f"Found {len(items)} {normalize_crm_module(module)} record(s).",
            "hasMore": bool(result.get("hasMore")),
        }

    if op == "get":
        module = _module(args, op)
        record_id = _required(args, "recordId", op)
        record = await client.crm_get_record(module, record_id)
        return {
            "success": True,
            "data": format_crm_result(record),
            "message": "Record not found" if record is None else None,
        }

    if op == "search":
        module = _module(args, op)
        criteria = _required(args, "criteria", op)
        result = await client.crm_search_records(
            module,
            criteria,
            per_page=_limit(args),
        )
        items = result["items"]
        mod = normalize_crm_module(module)
        return {
            "success": True,
            "data": format_crm_result(items),
            "message": (
                f"Found {len(items)} {mod} record(s)."
                if items
                else f"No {mod} records matched the search criteria."
            ),
            "hasMore": bool(result.get("hasMore")),
        }

    if op == "search_text":
        module = _module(args, op)
        query = _required(args, "query", op)
        result = await client.crm_search_by_text(
            module,
            query,
            per_page=_limit(args),
        )
        items = result["items"]
        mod = normalize_crm_module(module)
        return {
            "success": True,
            "data": format_crm_result(items),
            "message": (
                f"Found {len(items)} {mod} record(s) matching \"{query}\"."
                if items
                else f"No {mod} records found matching \"{query}\"."
            ),
            "hasMore": bool(result.get("hasMore")),
        }

    if op == "build_pipeline_summary":
        report = await build_pipeline_summary(
            client,
            currency=_str_arg(args, "currency") or "INR",
            inline_threshold=min(_limit(args), 200),
        )
        return {
            "success": True,
            "message": report["summary"],
            "report": format_crm_result(report),
        }

    if op == "build_lead_report":
        report = await build_lead_report(client, inline_threshold=min(_limit(args), 200))
        return {
            "success": True,
            "message": report["summary"],
            "report": format_crm_result(report),
        }

    if op == "build_deal_forecast":
        closing_from = _date_bound(args, "closingFrom", "from")
        closing_to = _date_bound(args, "closingTo", "to")
        report = await build_deal_forecast(
            client,
            closing_from=closing_from,
            closing_to=closing_to,
            currency=_str_arg(args, "currency") or "INR",
            inline_threshold=min(_limit(args), 200),
        )
        return {
            "success": True,
            "message": report["summary"],
            "report": format_crm_result(report),
        }

    raise ValueError(f"Unhandled Zoho CRM read operation: {op}")


async def _execute_write(
    client: ZohoClient,
    op: str,
    args: dict[str, Any],
) -> dict[str, Any]:
    module = _module(args, op)
    mod = normalize_crm_module(module)

    if op == "create":
        fields = _fields(args, op)
        result = await client.crm_create_record(module, fields)
        return {
            "success": True,
            "recordId": result["id"],
            "message": f"{mod} record created",
            "data": format_crm_result(result.get("data")),
        }

    if op == "update":
        record_id = _required(args, "recordId", op)
        fields = _fields(args, op)
        result = await client.crm_update_record(module, record_id, fields)
        return {
            "success": True,
            "recordId": record_id,
            "message": f"{mod} record updated",
            "data": format_crm_result(result),
        }

    if op == "delete":
        record_id = _required(args, "recordId", op)
        result = await client.crm_delete_record(module, record_id)
        return {
            "success": True,
            "recordId": record_id,
            "message": f"{mod} record deleted",
            "data": format_crm_result(result),
        }

    raise ValueError(f"Unhandled Zoho CRM write operation: {op}")


def _operation(args: dict[str, Any]) -> str:
    return str(args.get("op") or args.get("operation") or "").strip()


def _limit(args: dict[str, Any]) -> int:
    try:
        return max(1, min(200, int(args.get("limit") or DEFAULT_INLINE_THRESHOLD)))
    except (TypeError, ValueError):
        return DEFAULT_INLINE_THRESHOLD


def _module(args: dict[str, Any], op: str) -> str:
    module = _str_arg(args, "module")
    if not module:
        raise ValueError(f"module is required for {op}")
    return module


def _sort_order(args: dict[str, Any]) -> str | None:
    value = _str_arg(args, "sortOrder")
    return value if value in {"asc", "desc"} else None


def _date_bound(args: dict[str, Any], key: str, side: str) -> str | None:
    value = _str_arg(args, key)
    if not value:
        return None
    return parse_date_filter(value)[side]


def _maybe_csv(args: dict[str, Any], items: list[dict[str, Any]]) -> str | None:
    if not (bool(args.get("exportCsv")) or bool(args.get("exportAll"))):
        return None
    columns = args.get("csvColumns")
    return records_to_csv(items, columns if isinstance(columns, list) else None)


def _str_arg(args: dict[str, Any], key: str) -> str | None:
    value = args.get(key)
    return value.strip() if isinstance(value, str) and value.strip() else None


def _required(args: dict[str, Any], key: str, op: str) -> str:
    value = _str_arg(args, key)
    if not value:
        raise ValueError(f"{key} is required for {op}")
    return value


def _fields(args: dict[str, Any], op: str) -> dict[str, Any]:
    fields = args.get("fields")
    if not isinstance(fields, dict) or not fields:
        raise ValueError(f"fields is required for {op}")
    return fields


def _write_description(op: str, args: dict[str, Any]) -> str:
    identifiers = []
    module = _str_arg(args, "module")
    record_id = _str_arg(args, "recordId")
    if module:
        identifiers.append(f"module={normalize_crm_module(module)}")
    if record_id:
        identifiers.append(f"recordId={record_id}")
    detail = f" ({', '.join(identifiers)})" if identifiers else ""
    return f"Zoho CRM write operation '{op}'{detail}"


def _map_zoho_error(exc: Exception) -> str:
    text = str(exc)
    lower = text.lower()
    if "1002" in text or "invalid oauth" in lower or "unauthorized" in lower:
        return "Zoho authentication failed. Reconnect Zoho or refresh credentials."
    if "invalid module" in lower:
        return "Zoho CRM module is invalid. Use Leads, Contacts, Accounts, Deals, or Tasks."
    return text


registry.register(
    name="zoho_crm",
    toolset="zoho",
    schema=ZOHO_CRM_SCHEMA,
    handler=_handle_zoho_crm,
    check_fn=zoho_tool_available,
    requires_env=["ZOHO_CLIENT_ID", "ZOHO_CLIENT_SECRET", "ZOHO_REFRESH_TOKEN"],
    is_async=True,
    emoji="🏢",
    max_result_size_chars=100_000,
)
