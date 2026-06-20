"""Hermes-native Zoho Books model tool."""

from __future__ import annotations

from typing import Any

from tools.registry import registry, tool_error, tool_result
from tools.zoho_approval import require_zoho_write_approval
from tools.zoho_runtime import zoho_tool_available
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
    "find_invoice",
    "list_invoices",
    "get_invoice",
    "get_invoice_by_number",
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
            "invoiceId": {
                "type": "string",
                "description": "Zoho internal invoice_id. Human invoice numbers like INV21421 can also be supplied and will be resolved automatically.",
            },
            "invoiceNumber": {
                "type": "string",
                "description": "Human-readable invoice number, e.g. INV21421. Use this when the user provides an invoice number.",
            },
            "contactId": {"type": "string"},
            "accountId": {"type": "string"},
            "searchQuery": {"type": "string"},
            "query": {
                "type": "string",
                "description": "General invoice search text. Can be an invoice number, customer name, or reference.",
            },
            "customerName": {
                "type": "string",
                "description": "Filter invoice search by customer name.",
            },
            "customerId": {
                "type": "string",
                "description": "Filter invoice search by Zoho customer_id.",
            },
            "amount": {
                "type": "number",
                "description": "Filter invoice search by exact total amount.",
            },
            "amountMin": {
                "type": "number",
                "description": "Minimum invoice total for find_invoice.",
            },
            "amountMax": {
                "type": "number",
                "description": "Maximum invoice total for find_invoice.",
            },
            "includeLinked": {
                "type": "boolean",
                "description": "Include linked payment and credit-note lookups in invoice details. Default true.",
            },
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
            try:
                from tools.zoho_runtime import resolve_tool_client

                client = resolve_tool_client(kwargs)
            except Exception as exc:
                return tool_error(_map_zoho_error(exc), success=False, operation=op)
            result = await _execute_write(client, op, args)
            result["approval"] = approved.get("approval")
            return tool_result(result)

        try:
            from tools.zoho_runtime import resolve_tool_client

            client = resolve_tool_client(kwargs)
        except Exception as exc:
            return tool_error(_map_zoho_error(exc), success=False, operation=op)
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

    if op == "find_invoice":
        return await _find_invoice(client, args, organization_id=org_id)

    if op == "get_invoice":
        invoice_id = _required(args, "invoiceId", op)
        if _looks_like_invoice_number(invoice_id):
            return await _get_invoice_by_number(client, invoice_id, organization_id=org_id)
        data = await client.books_get_record("invoices", invoice_id, organization_id=org_id)
        dossier = await _build_invoice_dossier(
            client,
            data,
            organization_id=org_id,
            include_linked=_bool_arg(args, "includeLinked", default=True),
            fetch_if_summary=False,
        )
        return {
            "success": True,
            "message": f"Found invoice {dossier.get('invoiceNumber') or invoice_id}.",
            "data": format_books_result(dossier),
            "raw": format_books_result(data),
        }

    if op == "get_invoice_by_number":
        invoice_number = (
            _str_arg(args, "invoiceNumber")
            or _str_arg(args, "invoice_number")
            or _str_arg(args, "invoiceId")
            or _str_arg(args, "searchQuery")
        )
        if not invoice_number:
            raise ValueError("invoiceNumber is required for get_invoice_by_number")
        return await _get_invoice_by_number(client, invoice_number, organization_id=org_id)

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
    if op == "list_invoices":
        invoice_number = _str_arg(args, "invoiceNumber") or _str_arg(args, "invoice_number")
        if invoice_number:
            filters["invoice_number"] = invoice_number
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


async def _get_invoice_by_number(
    client: ZohoClient,
    invoice_number: str,
    *,
    organization_id: str | None = None,
) -> dict[str, Any]:
    normalized = invoice_number.strip()
    matches = await _invoice_number_matches(
        client,
        normalized,
        organization_id=organization_id,
        exact=True,
    )
    if not matches:
        return {
            "success": False,
            "message": f"Invoice {normalized} was not found by invoice number.",
            "data": [],
            "lookup": {
                "invoiceNumber": normalized,
                "method": "invoice_number",
            },
        }

    invoice = matches[0]
    invoice_id = str(invoice.get("invoice_id") or invoice.get("id") or "").strip()
    if not invoice_id:
        return {
            "success": True,
            "message": f"Found invoice {normalized}, but Zoho did not return an internal invoice_id.",
            "data": format_books_result(invoice),
            "lookup": {
                "invoiceNumber": normalized,
                "method": "invoice_number",
                "matchCount": len(matches),
            },
        }
    data = await client.books_get_record("invoices", invoice_id, organization_id=organization_id)
    dossier = await _build_invoice_dossier(
        client,
        data or invoice,
        organization_id=organization_id,
        include_linked=True,
        fetch_if_summary=False,
    )
    return {
        "success": True,
        "message": f"Found invoice {normalized}.",
        "data": format_books_result(dossier),
        "raw": format_books_result(data or invoice),
        "lookup": {
            "invoiceNumber": normalized,
            "invoiceId": invoice_id,
            "method": "invoice_number",
            "matchCount": len(matches),
        },
    }


async def _find_invoice(
    client: ZohoClient,
    args: dict[str, Any],
    *,
    organization_id: str | None = None,
) -> dict[str, Any]:
    query = (
        _str_arg(args, "query")
        or _str_arg(args, "searchQuery")
        or _str_arg(args, "invoiceNumber")
        or _str_arg(args, "invoice_number")
        or _str_arg(args, "invoiceId")
    )
    invoice_number = (
        _str_arg(args, "invoiceNumber")
        or _str_arg(args, "invoice_number")
        or (
            query
            if query and _looks_like_invoice_number(query)
            else None
        )
    )
    candidates = await _collect_invoice_candidates(
        client,
        args,
        query=query,
        invoice_number=invoice_number,
        organization_id=organization_id,
    )
    candidates = _filter_invoice_candidates(candidates, args, invoice_number=invoice_number)
    candidates.sort(
        key=lambda item: _invoice_candidate_score(item, args, query=query, invoice_number=invoice_number),
        reverse=True,
    )

    inline_limit = _limit(args)
    summaries = [_invoice_summary(item) for item in candidates[:inline_limit]]
    selected = _select_invoice_candidate(candidates, invoice_number=invoice_number)
    dossier = None
    if selected:
        dossier = await _build_invoice_dossier(
            client,
            selected,
            organization_id=organization_id,
            include_linked=_bool_arg(args, "includeLinked", default=True),
        )

    if not candidates:
        return {
            "success": False,
            "message": "No matching Zoho Books invoice found.",
            "query": _invoice_query_debug(args, query=query, invoice_number=invoice_number),
            "matchCount": 0,
            "matches": [],
            "data": None,
        }

    if dossier:
        message = f"Found invoice {dossier.get('invoiceNumber') or dossier.get('invoice_id')}."
    else:
        message = f"Found {len(candidates)} matching invoices. Pick one by invoiceNumber or invoiceId for full details."

    return {
        "success": True,
        "message": message,
        "query": _invoice_query_debug(args, query=query, invoice_number=invoice_number),
        "matchCount": len(candidates),
        "matches": format_books_result(summaries),
        "selected": format_books_result(dossier) if dossier else None,
        "data": format_books_result(dossier) if dossier else format_books_result(summaries),
        "hasMore": len(candidates) > inline_limit,
    }


async def _collect_invoice_candidates(
    client: ZohoClient,
    args: dict[str, Any],
    *,
    query: str | None,
    invoice_number: str | None,
    organization_id: str | None,
) -> list[dict[str, Any]]:
    candidates: list[dict[str, Any]] = []
    if invoice_number:
        candidates.extend(
            await _invoice_number_matches(
                client,
                invoice_number,
                organization_id=organization_id,
                exact=False,
            )
        )

    search_query = query if query and query != invoice_number else None
    if search_query:
        result = await client.books_list_records(
            "invoices",
            organization_id=organization_id,
            query=search_query,
            per_page=max(25, _limit(args)),
        )
        candidates.extend(_records(result.get("items")))

    filters = _invoice_api_filters(args)
    if filters or _has_client_side_invoice_filters(args) or not candidates:
        result = await client.books_list_all_records(
            "invoices",
            organization_id=organization_id,
            filters=filters,
            query=None if query == invoice_number else query,
        )
        candidates.extend(_records(result.get("items")))

    return _dedupe_invoice_candidates(candidates)


async def _invoice_number_matches(
    client: ZohoClient,
    invoice_number: str,
    *,
    organization_id: str | None,
    exact: bool,
) -> list[dict[str, Any]]:
    normalized = invoice_number.strip()
    matches: list[dict[str, Any]] = []
    for kwargs in (
        {"filters": {"invoice_number": normalized}},
        {"query": normalized},
    ):
        result = await client.books_list_records(
            "invoices",
            organization_id=organization_id,
            per_page=25,
            **kwargs,
        )
        matches.extend(_records(result.get("items")))
        if exact and _exact_invoice_number_matches(matches, normalized):
            break
    matches = _dedupe_invoice_candidates(matches)
    if exact:
        return _exact_invoice_number_matches(matches, normalized)
    return matches


def _exact_invoice_number_matches(
    invoices: list[dict[str, Any]],
    invoice_number: str,
) -> list[dict[str, Any]]:
    normalized = invoice_number.strip().lower()
    return [
        invoice
        for invoice in invoices
        if str(invoice.get("invoice_number") or invoice.get("invoiceNumber") or "").strip().lower()
        == normalized
    ]


def _invoice_api_filters(args: dict[str, Any]) -> dict[str, Any]:
    filters = _date_filters(args)
    customer_id = _str_arg(args, "customerId") or _str_arg(args, "customer_id")
    if customer_id:
        filters["customer_id"] = customer_id
    return filters


def _has_client_side_invoice_filters(args: dict[str, Any]) -> bool:
    return any(
        value is not None
        for value in (
            _str_arg(args, "customerName"),
            _number_arg(args, "amount"),
            _number_arg(args, "amountMin"),
            _number_arg(args, "amountMax"),
        )
    )


def _filter_invoice_candidates(
    invoices: list[dict[str, Any]],
    args: dict[str, Any],
    *,
    invoice_number: str | None,
) -> list[dict[str, Any]]:
    customer_name = (_str_arg(args, "customerName") or "").lower()
    customer_id = _str_arg(args, "customerId") or _str_arg(args, "customer_id")
    status = normalize_status(_str_arg(args, "status"))
    date_from = _str_arg(args, "dateFrom")
    date_to = _str_arg(args, "dateTo")
    amount = _number_arg(args, "amount")
    amount_min = _number_arg(args, "amountMin")
    amount_max = _number_arg(args, "amountMax")
    normalized_invoice_number = invoice_number.strip().lower() if invoice_number else None
    filtered = []
    for invoice in invoices:
        if normalized_invoice_number:
            candidate_number = str(
                invoice.get("invoice_number") or invoice.get("invoiceNumber") or ""
            ).strip().lower()
            if candidate_number and normalized_invoice_number not in candidate_number:
                continue
        if customer_id and str(invoice.get("customer_id") or "") != customer_id:
            continue
        if customer_name:
            candidate_customer = str(
                invoice.get("customer_name") or invoice.get("customerName") or ""
            ).lower()
            if customer_name not in candidate_customer:
                continue
        if status:
            candidate_status = normalize_status(str(invoice.get("status") or ""))
            if candidate_status and candidate_status != status:
                continue
        invoice_date = str(invoice.get("date") or invoice.get("invoice_date") or "")
        if date_from and invoice_date and invoice_date < date_from:
            continue
        if date_to and invoice_date and invoice_date > date_to:
            continue
        total = _number_from_record(invoice, "total", "amount", "invoice_total")
        if amount is not None and abs(total - amount) > 0.01:
            continue
        if amount_min is not None and total < amount_min:
            continue
        if amount_max is not None and total > amount_max:
            continue
        filtered.append(invoice)
    return filtered


def _invoice_candidate_score(
    invoice: dict[str, Any],
    args: dict[str, Any],
    *,
    query: str | None,
    invoice_number: str | None,
) -> int:
    score = 0
    candidate_number = str(invoice.get("invoice_number") or invoice.get("invoiceNumber") or "").lower()
    customer = str(invoice.get("customer_name") or invoice.get("customerName") or "").lower()
    if invoice_number:
        normalized = invoice_number.lower()
        if candidate_number == normalized:
            score += 1000
        elif normalized in candidate_number:
            score += 500
    if query:
        normalized_query = query.lower()
        if normalized_query in candidate_number:
            score += 300
        if normalized_query in customer:
            score += 150
    amount = _number_arg(args, "amount")
    if amount is not None and abs(_number_from_record(invoice, "total", "amount") - amount) <= 0.01:
        score += 80
    if _str_arg(args, "dateFrom") or _str_arg(args, "dateTo"):
        score += 25
    if _str_arg(args, "status"):
        score += 10
    return score


def _select_invoice_candidate(
    candidates: list[dict[str, Any]],
    *,
    invoice_number: str | None,
) -> dict[str, Any] | None:
    if not candidates:
        return None
    if len(candidates) == 1:
        return candidates[0]
    if invoice_number:
        exact = _exact_invoice_number_matches(candidates, invoice_number)
        if len(exact) == 1:
            return exact[0]
    return None


async def _build_invoice_dossier(
    client: ZohoClient,
    invoice: dict[str, Any],
    *,
    organization_id: str | None,
    include_linked: bool,
    fetch_if_summary: bool = True,
) -> dict[str, Any]:
    invoice = dict(invoice or {})
    invoice_id = str(invoice.get("invoice_id") or invoice.get("id") or "").strip()
    if fetch_if_summary and invoice_id and not invoice.get("line_items"):
        fetched = await client.books_get_record("invoices", invoice_id, organization_id=organization_id)
        if isinstance(fetched, dict):
            invoice = fetched

    linked = {"payments": [], "creditNotes": [], "warnings": []}
    if include_linked and invoice_id:
        linked = await _linked_invoice_records(client, invoice, organization_id=organization_id)

    summary = _invoice_summary(invoice)
    dossier = {
        **summary,
        "invoice_id": summary.get("invoiceId"),
        "invoice_number": summary.get("invoiceNumber"),
        "referenceNumber": invoice.get("reference_number") or invoice.get("referenceNumber"),
        "email": invoice.get("email"),
        "gstNo": invoice.get("gst_no") or invoice.get("gstNo"),
        "gstTreatment": invoice.get("gst_treatment") or invoice.get("gstTreatment"),
        "placeOfSupply": invoice.get("place_of_supply") or invoice.get("placeOfSupply"),
        "salespersonName": invoice.get("salesperson_name") or invoice.get("salespersonName"),
        "billingAddress": invoice.get("billing_address") or invoice.get("billingAddress"),
        "shippingAddress": invoice.get("shipping_address") or invoice.get("shippingAddress"),
        "invoiceUrl": invoice.get("invoice_url") or invoice.get("invoiceUrl"),
        "lastPaymentDate": invoice.get("last_payment_date") or invoice.get("lastPaymentDate"),
        "lineItems": [_line_item_summary(item) for item in _records(invoice.get("line_items"))],
        "taxes": [_tax_summary(item) for item in _records(invoice.get("taxes"))],
        "linkedTransactions": linked,
        "notes": invoice.get("notes"),
        "terms": invoice.get("terms"),
    }
    return {key: value for key, value in dossier.items() if value not in (None, "", [], {})}


async def _linked_invoice_records(
    client: ZohoClient,
    invoice: dict[str, Any],
    *,
    organization_id: str | None,
) -> dict[str, Any]:
    invoice_id = str(invoice.get("invoice_id") or invoice.get("id") or "").strip()
    invoice_number = str(invoice.get("invoice_number") or "").strip()
    linked = {
        "payments": [_payment_summary(item) for item in _embedded_linked_records(invoice, "payments")],
        "creditNotes": [_credit_note_summary(item) for item in _embedded_linked_records(invoice, "creditnotes", "credit_notes")],
        "warnings": [],
    }
    for path, result_key, output_key, mapper in (
        ("/customerpayments", "customerpayments", "payments", _payment_summary),
        ("/creditnotes", "creditnotes", "creditNotes", _credit_note_summary),
    ):
        try:
            data = await client.books_get_endpoint(
                path,
                organization_id=organization_id,
                params={"invoice_id": invoice_id},
            )
        except Exception as exc:  # Keep invoice details usable if linked lookup is unavailable.
            linked["warnings"].append(f"{path} lookup failed: {_map_zoho_error(exc)}")
            continue
        rows = [
            mapper(row)
            for row in _records(data.get(result_key))
            if _record_references_invoice(row, invoice_id=invoice_id, invoice_number=invoice_number)
        ]
        existing_ids = {str(row.get("id") or "") for row in linked[output_key]}
        for row in rows:
            row_id = str(row.get("id") or "")
            if row_id and row_id in existing_ids:
                continue
            linked[output_key].append(row)
            if row_id:
                existing_ids.add(row_id)
    return linked


def _embedded_linked_records(invoice: dict[str, Any], *keys: str) -> list[dict[str, Any]]:
    records: list[dict[str, Any]] = []
    for key in keys:
        records.extend(_records(invoice.get(key)))
    return records


def _record_references_invoice(
    value: Any,
    *,
    invoice_id: str,
    invoice_number: str,
) -> bool:
    if isinstance(value, dict):
        for key, nested in value.items():
            key_lower = str(key).lower()
            if "invoice" in key_lower:
                text = str(nested)
                if invoice_id and invoice_id in text:
                    return True
                if invoice_number and invoice_number.lower() in text.lower():
                    return True
            if _record_references_invoice(
                nested,
                invoice_id=invoice_id,
                invoice_number=invoice_number,
            ):
                return True
    elif isinstance(value, list):
        return any(
            _record_references_invoice(
                item,
                invoice_id=invoice_id,
                invoice_number=invoice_number,
            )
            for item in value
        )
    else:
        text = str(value)
        if invoice_id and invoice_id == text:
            return True
        if invoice_number and invoice_number.lower() == text.lower():
            return True
    return False


def _invoice_summary(invoice: dict[str, Any]) -> dict[str, Any]:
    return {
        "invoiceId": invoice.get("invoice_id") or invoice.get("id"),
        "invoiceNumber": invoice.get("invoice_number") or invoice.get("invoiceNumber"),
        "status": invoice.get("status"),
        "customerId": invoice.get("customer_id") or invoice.get("customerId"),
        "customerName": invoice.get("customer_name") or invoice.get("customerName"),
        "date": invoice.get("date") or invoice.get("invoice_date"),
        "dueDate": invoice.get("due_date") or invoice.get("dueDate"),
        "currencyCode": invoice.get("currency_code") or invoice.get("currencyCode"),
        "subTotal": _number_or_none(invoice, "sub_total", "subTotal"),
        "taxTotal": _number_or_none(invoice, "tax_total", "taxTotal"),
        "total": _number_or_none(invoice, "total", "amount", "invoice_total"),
        "balance": _number_or_none(invoice, "balance", "amount_due"),
        "paymentMade": _number_or_none(invoice, "payment_made", "paymentMade"),
        "creditsApplied": _number_or_none(invoice, "credits_applied", "creditsApplied"),
    }


def _line_item_summary(item: dict[str, Any]) -> dict[str, Any]:
    summary = {
        "itemId": item.get("item_id") or item.get("itemId"),
        "name": item.get("name") or item.get("item_name"),
        "description": item.get("description"),
        "quantity": _number_or_none(item, "quantity"),
        "rate": _number_or_none(item, "rate"),
        "amount": _number_or_none(item, "item_total", "amount"),
        "taxName": item.get("tax_name") or item.get("taxName"),
        "taxPercentage": _number_or_none(item, "tax_percentage", "taxPercentage"),
    }
    return {key: value for key, value in summary.items() if value not in (None, "", [], {})}


def _tax_summary(item: dict[str, Any]) -> dict[str, Any]:
    summary = {
        "name": item.get("tax_name") or item.get("name"),
        "percentage": _number_or_none(item, "tax_percentage", "percentage"),
        "amount": _number_or_none(item, "tax_amount", "amount"),
    }
    return {key: value for key, value in summary.items() if value not in (None, "", [], {})}


def _payment_summary(item: dict[str, Any]) -> dict[str, Any]:
    summary = {
        "id": item.get("payment_id") or item.get("customerpayment_id") or item.get("id"),
        "number": item.get("payment_number") or item.get("paymentNumber"),
        "date": item.get("date") or item.get("payment_date"),
        "amount": _number_or_none(item, "amount", "payment_amount"),
        "mode": item.get("payment_mode") or item.get("paymentMode"),
        "referenceNumber": item.get("reference_number") or item.get("referenceNumber"),
    }
    return {key: value for key, value in summary.items() if value not in (None, "", [], {})}


def _credit_note_summary(item: dict[str, Any]) -> dict[str, Any]:
    summary = {
        "id": item.get("creditnote_id") or item.get("id"),
        "number": item.get("creditnote_number") or item.get("creditnoteNumber"),
        "date": item.get("date"),
        "status": item.get("status"),
        "total": _number_or_none(item, "total", "amount"),
        "balance": _number_or_none(item, "balance"),
    }
    return {key: value for key, value in summary.items() if value not in (None, "", [], {})}


def _invoice_query_debug(
    args: dict[str, Any],
    *,
    query: str | None,
    invoice_number: str | None,
) -> dict[str, Any]:
    return {
        key: value
        for key, value in {
            "query": query,
            "invoiceNumber": invoice_number,
            "customerName": _str_arg(args, "customerName"),
            "customerId": _str_arg(args, "customerId") or _str_arg(args, "customer_id"),
            "dateFrom": _str_arg(args, "dateFrom"),
            "dateTo": _str_arg(args, "dateTo"),
            "status": _str_arg(args, "status"),
            "amount": _number_arg(args, "amount"),
            "amountMin": _number_arg(args, "amountMin"),
            "amountMax": _number_arg(args, "amountMax"),
        }.items()
        if value is not None
    }


def _dedupe_invoice_candidates(invoices: list[dict[str, Any]]) -> list[dict[str, Any]]:
    deduped: list[dict[str, Any]] = []
    seen: set[str] = set()
    for invoice in invoices:
        key = str(
            invoice.get("invoice_id")
            or invoice.get("id")
            or invoice.get("invoice_number")
            or invoice.get("invoiceNumber")
            or len(seen)
        )
        if key in seen:
            continue
        seen.add(key)
        deduped.append(invoice)
    return deduped


def _records(value: Any) -> list[dict[str, Any]]:
    if not isinstance(value, list):
        return []
    return [item for item in value if isinstance(item, dict)]


def _bool_arg(args: dict[str, Any], key: str, *, default: bool) -> bool:
    value = args.get(key)
    return value if isinstance(value, bool) else default


def _number_arg(args: dict[str, Any], key: str) -> float | None:
    return _as_number(args.get(key))


def _number_from_record(record: dict[str, Any], *keys: str) -> float:
    value = _number_or_none(record, *keys)
    return value if value is not None else 0.0


def _number_or_none(record: dict[str, Any], *keys: str) -> float | None:
    for key in keys:
        value = _as_number(record.get(key))
        if value is not None:
            return value
    return None


def _as_number(value: Any) -> float | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return float(value)
    if isinstance(value, str):
        try:
            return float(value.replace(",", ""))
        except ValueError:
            return None
    return None


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


def _looks_like_invoice_number(value: str) -> bool:
    normalized = value.strip()
    if not normalized:
        return False
    if normalized.isdigit():
        return False
    return any(ch.isalpha() for ch in normalized) and any(ch.isdigit() for ch in normalized)


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
    check_fn=zoho_tool_available,
    requires_env=["ZOHO_CLIENT_ID", "ZOHO_CLIENT_SECRET", "ZOHO_REFRESH_TOKEN"],
    is_async=True,
    emoji="📒",
    max_result_size_chars=100_000,
)
