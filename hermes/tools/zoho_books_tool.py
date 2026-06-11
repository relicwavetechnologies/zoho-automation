"""Hermes-native Zoho Books model tool."""

from __future__ import annotations

from typing import Any

from tools.registry import registry, tool_error, tool_result
from tools.zoho_approval import require_zoho_write_approval
from tools.zoho_auth import check_zoho_requirements
from tools.zoho_client import (
    DEFAULT_INLINE_THRESHOLD,
    ZohoClient,
    build_date_range_params,
    build_overdue_report,
    enrich_books_records,
    format_books_result,
    normalize_status,
    parse_date_filter,
    records_to_csv,
    summarize_records,
)


BOOKS_READ_OPS = {
    "list_invoices",
    "get_invoice",
    "list_contacts",
    "get_contact",
    "list_expenses",
    "list_bills",
    "list_payments",
    "get_chart_of_accounts",
    "get_account_balance",
    "list_bank_transactions",
    "search_transactions",
    "get_tax_summary",
    "build_overdue_report",
}
BOOKS_CREATE_OPS = {
    "create_invoice",
    "send_invoice",
    "record_payment",
    "create_expense",
    "create_bill",
}
BOOKS_DELETE_OPS = {"void_invoice"}
BOOKS_WRITE_OPS = BOOKS_CREATE_OPS | BOOKS_DELETE_OPS

BOOKS_LIST_OPS = {
    "list_invoices": {
        "module": "invoices",
        "label": "invoices",
        "amount_keys": ["total", "balance", "amount_due"],
    },
    "list_contacts": {
        "module": "contacts",
        "label": "contacts",
        "amount_keys": [],
    },
    "list_expenses": {
        "module": "expenses",
        "label": "expenses",
        "amount_keys": ["total", "amount"],
    },
    "list_bills": {
        "module": "bills",
        "label": "bills",
        "amount_keys": ["total", "balance", "amount_due"],
    },
    "list_payments": {
        "module": "customerpayments",
        "label": "payments",
        "amount_keys": ["amount", "payment_amount"],
    },
    "list_bank_transactions": {
        "module": "banktransactions",
        "label": "bank transactions",
        "amount_keys": ["amount"],
    },
    "search_transactions": {
        "module": "banktransactions",
        "label": "transaction search results",
        "amount_keys": ["amount"],
    },
}


ZOHO_BOOKS_SCHEMA = {
    "name": "zoho_books",
    "description": (
        "Access Zoho Books for invoices, contacts, expenses, bills, payments, "
        "bank transactions, chart of accounts, tax summary, and overdue reports. "
        "List operations exhaust Zoho pagination up to Divo's 20-page cap and "
        "return bounded inline JSON plus optional inline CSV."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "op": {
                "type": "string",
                "enum": sorted(BOOKS_READ_OPS | BOOKS_WRITE_OPS),
                "description": "Divo-compatible operation name.",
            },
            "operation": {
                "type": "string",
                "description": "Alias for op. Prefer op for Divo compatibility.",
            },
            "invoiceId": {"type": "string"},
            "contactId": {"type": "string"},
            "accountId": {"type": "string"},
            "searchQuery": {"type": "string"},
            "email": {"type": "string"},
            "fields": {
                "type": "object",
                "additionalProperties": True,
                "description": "Zoho Books request body for create/write operations.",
            },
            "limit": {
                "type": "integer",
                "minimum": 1,
                "maximum": 100,
                "description": "Maximum inline records to return. Default 25.",
            },
            "exportAll": {
                "type": "boolean",
                "description": "Include an inline CSV string for list results.",
            },
            "exportCsv": {
                "type": "boolean",
                "description": "Include an inline CSV string for list/report rows.",
            },
            "csvColumns": {
                "type": "array",
                "items": {"type": "string"},
                "description": "Optional CSV column order.",
            },
            "organizationId": {"type": "string"},
            "dateFrom": {"type": "string"},
            "dateTo": {"type": "string"},
            "status": {"type": "string"},
            "taxYear": {"type": "string"},
            "asOfDate": {"type": "string"},
            "minOverdueDays": {"type": "integer", "minimum": 0},
            "invoiceDateFrom": {"type": "string"},
            "invoiceDateTo": {"type": "string"},
        },
        "required": ["op"],
    },
}


async def _handle_zoho_books(args: dict[str, Any], **kwargs: Any) -> str:
    op = _operation(args)
    if not op:
        return tool_error("op is required", success=False)
    if op not in BOOKS_READ_OPS and op not in BOOKS_WRITE_OPS:
        return tool_error(f"Unknown Zoho Books operation: {op}", success=False)

    try:
        from tools.zoho_runtime import resolve_tool_client

        client = resolve_tool_client(kwargs)
    except Exception as exc:
        return tool_error(_map_zoho_error(exc), success=False, operation=op)

    try:
        if op in BOOKS_WRITE_OPS:
            approved = require_zoho_write_approval(
                pattern_key=f"zoho_books:{op}",
                action=f"zoho_books {op}",
                description=_write_description(op, args),
                approval_callback=kwargs.get("approval_callback"),
            )
            if not approved.get("approved"):
                return tool_error(
                    approved.get("message") or "Zoho Books write approval required.",
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
    org_id = _str_arg(args, "organizationId")

    if op in BOOKS_LIST_OPS:
        return await _list_books(client, op, args)

    if op == "get_invoice":
        invoice_id = _required(args, "invoiceId", op)
        data = await client.books_get_record("invoices", invoice_id, organization_id=org_id)
        return {"success": True, "data": format_books_result(data)}

    if op == "get_contact":
        contact_id = _required(args, "contactId", op)
        data = await client.books_get_record("contacts", contact_id, organization_id=org_id)
        return {"success": True, "data": format_books_result(data)}

    if op == "get_chart_of_accounts":
        data = await client.books_get_endpoint(
            "/chartofaccounts",
            organization_id=org_id,
        )
        return {
            "success": True,
            "data": format_books_result(data.get("chartofaccounts", data)),
        }

    if op == "get_account_balance":
        account_id = _str_arg(args, "accountId")
        if account_id:
            data = await client.books_get_endpoint(
                f"/bankaccounts/{account_id}",
                organization_id=org_id,
            )
        else:
            data = await client.books_list_records(
                "bankaccounts",
                organization_id=org_id,
                per_page=_limit(args),
            )
        return {"success": True, "data": format_books_result(data)}

    if op == "get_tax_summary":
        params = _date_filters(args)
        tax_year = _str_arg(args, "taxYear")
        if tax_year:
            params["tax_year"] = tax_year
        data = await client.books_get_endpoint(
            "/reports/taxsummary",
            organization_id=org_id,
            params=params,
        )
        return {"success": True, "data": format_books_result(data)}

    if op == "build_overdue_report":
        report = await build_overdue_report(
            client,
            organization_id=org_id,
            as_of_date=_single_date_arg(args, "asOfDate"),
            min_overdue_days=int(args.get("minOverdueDays") or 1),
            invoice_date_from=_range_date_arg(args, "invoiceDateFrom", "from"),
            invoice_date_to=_range_date_arg(args, "invoiceDateTo", "to"),
            inline_threshold=min(_limit(args), 100),
        )
        return {
            "success": True,
            "message": report["summary"],
            "report": format_books_result(report),
        }

    raise ValueError(f"Unhandled Zoho Books read operation: {op}")


async def _list_books(
    client: ZohoClient,
    op: str,
    args: dict[str, Any],
) -> dict[str, Any]:
    spec = BOOKS_LIST_OPS[op]
    filters = _date_filters(args)
    if op == "search_transactions":
        search_query = _required(args, "searchQuery", op)
        query = search_query
    else:
        query = _str_arg(args, "searchQuery")
    result = await client.books_list_all_records(
        spec["module"],
        organization_id=_str_arg(args, "organizationId"),
        filters=filters,
        query=query,
    )
    items = enrich_books_records(result["items"])
    inline_limit = _limit(args)
    inline_items = items[:inline_limit]
    summary = summarize_records(spec["label"], spec["amount_keys"], items)
    if len(items) > len(inline_items):
        summary += f" Showing {len(inline_items)} inline."
    if result.get("truncated"):
        summary += " Pagination limit reached; totals may be understated."

    csv_text = None
    if bool(args.get("exportAll")) or bool(args.get("exportCsv")):
        csv_columns = args.get("csvColumns")
        csv_text = records_to_csv(
            items,
            csv_columns if isinstance(csv_columns, list) else None,
        )

    report = {
        "items": format_books_result(inline_items),
        "totalCount": len(items),
        "organizationId": result.get("organizationId"),
        "truncated": bool(result.get("truncated")),
        "hasMore": len(items) > len(inline_items) or bool(result.get("truncated")),
        "suggestExport": len(items) > inline_limit and not csv_text,
        **({"csv": csv_text} if csv_text is not None else {}),
    }
    return {
        "success": True,
        "message": summary,
        "data": report["items"],
        "report": report,
        "truncated": report["truncated"],
        "hasMore": report["hasMore"],
        "suggestExport": report["suggestExport"],
        **({"csv": csv_text} if csv_text is not None else {}),
    }


async def _execute_write(
    client: ZohoClient,
    op: str,
    args: dict[str, Any],
) -> dict[str, Any]:
    org_id = _str_arg(args, "organizationId")

    if op == "create_invoice":
        fields = _fields(args, op)
        result = await client.books_create_invoice(fields, organization_id=org_id)
        return {
            "success": True,
            "id": result["invoiceId"],
            "message": "Invoice created successfully",
            "data": format_books_result(result.get("data")),
        }

    if op == "send_invoice":
        invoice_id = _required(args, "invoiceId", op)
        result = await client.books_send_invoice(
            invoice_id,
            email=_str_arg(args, "email"),
            organization_id=org_id,
        )
        return {
            "success": True,
            "id": result["invoiceId"],
            "message": "Invoice sent successfully",
            "data": format_books_result(result.get("data")),
        }

    if op == "record_payment":
        fields = _fields(args, op)
        result = await client.books_record_payment(fields, organization_id=org_id)
        return {
            "success": True,
            "id": result["paymentId"],
            "message": "Payment recorded successfully",
            "data": format_books_result(result.get("data")),
        }

    if op == "create_expense":
        fields = _fields(args, op)
        result = await client.books_create_expense(fields, organization_id=org_id)
        return {
            "success": True,
            "id": result["expenseId"],
            "message": "Expense created successfully",
            "data": format_books_result(result.get("data")),
        }

    if op == "create_bill":
        fields = _fields(args, op)
        result = await client.books_create_bill(fields, organization_id=org_id)
        return {
            "success": True,
            "id": result["billId"],
            "message": "Bill created successfully",
            "data": format_books_result(result.get("data")),
        }

    if op == "void_invoice":
        invoice_id = _required(args, "invoiceId", op)
        result = await client.books_void_invoice(invoice_id, organization_id=org_id)
        return {
            "success": True,
            "id": result["invoiceId"],
            "message": "Invoice voided successfully",
            "data": format_books_result(result.get("data")),
        }

    raise ValueError(f"Unhandled Zoho Books write operation: {op}")


def _operation(args: dict[str, Any]) -> str:
    return str(args.get("op") or args.get("operation") or "").strip()


def _limit(args: dict[str, Any]) -> int:
    try:
        return max(1, min(100, int(args.get("limit") or DEFAULT_INLINE_THRESHOLD)))
    except (TypeError, ValueError):
        return DEFAULT_INLINE_THRESHOLD


def _date_filters(args: dict[str, Any]) -> dict[str, Any]:
    filters = build_date_range_params(
        _str_arg(args, "dateFrom"),
        _str_arg(args, "dateTo"),
    )
    status = normalize_status(_str_arg(args, "status"))
    if status:
        filters["status"] = status
    return filters


def _single_date_arg(args: dict[str, Any], key: str) -> str | None:
    value = _str_arg(args, key)
    if not value:
        return None
    return parse_date_filter(value)["to"]


def _range_date_arg(args: dict[str, Any], key: str, side: str) -> str | None:
    value = _str_arg(args, key)
    if not value:
        return None
    parsed = parse_date_filter(value)
    return parsed[side]


def _str_arg(args: dict[str, Any], key: str) -> str | None:
    value = args.get(key)
    return value.strip() if isinstance(value, str) and value.strip() else None


def _required(args: dict[str, Any], key: str, op: str) -> str:
    value = _str_arg(args, key)
    if not value:
        raise ValueError(f"{key} required for {op}")
    return value


def _fields(args: dict[str, Any], op: str) -> dict[str, Any]:
    fields = args.get("fields")
    if not isinstance(fields, dict) or not fields:
        raise ValueError(f"fields required for {op}")
    return fields


def _write_description(op: str, args: dict[str, Any]) -> str:
    identifiers = []
    for key in ("invoiceId", "contactId", "accountId", "email"):
        value = _str_arg(args, key)
        if value:
            identifiers.append(f"{key}={value}")
    detail = f" ({', '.join(identifiers)})" if identifiers else ""
    return f"Zoho Books write operation '{op}'{detail}"


def _map_zoho_error(exc: Exception) -> str:
    text = str(exc)
    lower = text.lower()
    if "1002" in text or "invalid oauth" in lower or "unauthorized" in lower:
        return "Zoho authentication failed. Reconnect Zoho or refresh credentials."
    if "4001" in text or "organization" in lower and "required" in lower:
        return "Zoho Books organization is missing or invalid. Set ZOHO_ORGANIZATION_ID."
    if "4823" in text:
        return "This Zoho Books transaction cannot be modified in its current state."
    return text


registry.register(
    name="zoho_books",
    toolset="zoho",
    schema=ZOHO_BOOKS_SCHEMA,
    handler=_handle_zoho_books,
    check_fn=check_zoho_requirements,
    requires_env=["ZOHO_CLIENT_ID", "ZOHO_CLIENT_SECRET", "ZOHO_REFRESH_TOKEN"],
    is_async=True,
    emoji="📒",
    max_result_size_chars=100_000,
)
