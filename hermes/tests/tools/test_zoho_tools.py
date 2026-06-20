import json

import pytest

import tools.approval as approval_module
from tools.registry import registry
from tools.zoho_books_tool import _handle_zoho_books
from tools.zoho_crm_tool import _handle_zoho_crm
from toolsets import resolve_toolset


class FakeZohoClient:
    def __init__(self):
        self.calls = []

    def _invoice_summary(self, invoice_id="inv-internal-21421", invoice_number="INV21421"):
        return {
            "invoice_id": invoice_id,
            "invoice_number": invoice_number,
            "customer_id": "cust-digitas",
            "customer_name": "Digitas",
            "status": "sent",
            "date": "2026-06-10",
            "due_date": "2026-06-25",
            "total": "23600.00",
            "balance": "23600.00",
            "currency_code": "INR",
        }

    def _invoice_detail(self, invoice_id="inv-internal-21421", invoice_number="INV21421"):
        invoice = self._invoice_summary(invoice_id, invoice_number)
        invoice.update(
            {
                "sub_total": "20000.00",
                "tax_total": "3600.00",
                "payment_made": "0.00",
                "credits_applied": "0.00",
                "reference_number": "PO-21421",
                "email": "finance@example.com",
                "invoice_url": "https://books.zoho.example/invoice/21421",
                "line_items": [
                    {
                        "item_id": "item-1",
                        "name": "Consulting",
                        "description": "Monthly consulting",
                        "quantity": "1",
                        "rate": "20000.00",
                        "item_total": "20000.00",
                        "tax_name": "IGST",
                        "tax_percentage": "18",
                    }
                ],
                "taxes": [
                    {
                        "tax_name": "IGST",
                        "tax_percentage": "18",
                        "tax_amount": "3600.00",
                    }
                ],
            }
        )
        return invoice

    async def books_list_all_records(self, module_name, **kwargs):
        self.calls.append(("books_list_all_records", module_name, kwargs))
        if module_name == "invoices":
            return {
                "organizationId": kwargs.get("organization_id") or "org-1",
                "items": [
                    self._invoice_summary(),
                    self._invoice_summary("inv-internal-21429", "INV21429"),
                ],
                "truncated": False,
            }
        return {
            "organizationId": kwargs.get("organization_id") or "org-1",
            "items": [
                {
                    "bill_id": "bill-1",
                    "vendor_name": "Vendor A",
                    "total": "120.50",
                    "balance": "20.50",
                    "currency_code": "INR",
                    "date": "2026-05-01",
                }
            ],
            "truncated": False,
        }

    async def books_get_record(self, module_name, record_id, **kwargs):
        self.calls.append(("books_get_record", module_name, record_id, kwargs))
        if module_name == "invoices":
            number = "INV21421" if record_id == "inv-internal-21421" else "INV21429"
            return self._invoice_detail(record_id, number)
        return {
            "invoice_id": record_id,
            "invoice_number": "INV21421" if record_id == "inv-internal-21421" else None,
            "total": "125.50",
            "currency_code": "USD",
        }

    async def books_create_invoice(self, fields, **kwargs):
        self.calls.append(("books_create_invoice", fields, kwargs))
        return {"invoiceId": "inv-new", "data": {"invoice_id": "inv-new"}}

    async def books_record_payment(self, fields, **kwargs):
        self.calls.append(("books_record_payment", fields, kwargs))
        return {"paymentId": "pay-1", "data": {"payment_id": "pay-1"}}

    async def books_send_invoice(self, invoice_id, **kwargs):
        self.calls.append(("books_send_invoice", invoice_id, kwargs))
        return {"invoiceId": invoice_id, "data": {"invoice_id": invoice_id}}

    async def books_create_expense(self, fields, **kwargs):
        self.calls.append(("books_create_expense", fields, kwargs))
        return {"expenseId": "exp-1", "data": {"expense_id": "exp-1"}}

    async def books_create_bill(self, fields, **kwargs):
        self.calls.append(("books_create_bill", fields, kwargs))
        return {"billId": "bill-new", "data": {"bill_id": "bill-new"}}

    async def books_void_invoice(self, invoice_id, **kwargs):
        self.calls.append(("books_void_invoice", invoice_id, kwargs))
        return {"invoiceId": invoice_id, "data": {"invoice_id": invoice_id}}

    async def books_get_endpoint(self, path, **kwargs):
        self.calls.append(("books_get_endpoint", path, kwargs))
        if path == "/customerpayments":
            return {
                "customerpayments": [
                    {
                        "payment_id": "pay-21421",
                        "payment_number": "PAY-21421",
                        "date": "2026-06-15",
                        "amount": "1000.00",
                        "invoices": [{"invoice_id": "inv-internal-21421"}],
                    },
                    {
                        "payment_id": "pay-other",
                        "amount": "50.00",
                        "invoices": [{"invoice_id": "other-invoice"}],
                    },
                ]
            }
        if path == "/creditnotes":
            return {
                "creditnotes": [
                    {
                        "creditnote_id": "cn-21421",
                        "creditnote_number": "CN-21421",
                        "date": "2026-06-16",
                        "total": "500.00",
                        "invoices": [{"invoice_id": "inv-internal-21421"}],
                    }
                ]
            }
        return {"chartofaccounts": [{"account_id": "acct-1"}]}

    async def books_list_records(self, module_name, **kwargs):
        self.calls.append(("books_list_records", module_name, kwargs))
        if module_name == "invoices":
            filters = kwargs.get("filters") or {}
            query = kwargs.get("query")
            if filters.get("invoice_number") == "INV21421" or query == "INV21421":
                return {
                    "items": [self._invoice_summary()],
                    "hasMore": False,
                }
            if query == "Digitas":
                return {
                    "items": [
                        self._invoice_summary(),
                        self._invoice_summary("inv-internal-21429", "INV21429"),
                    ],
                    "hasMore": False,
                }
            return {"items": [], "hasMore": False}
        return {"items": [{"account_id": "acct-1"}], "hasMore": False}

    async def crm_list_records(self, module, **kwargs):
        self.calls.append(("crm_list_records", module, kwargs))
        return {"items": [{"id": "lead-1", "Last_Name": "Alice"}], "hasMore": False}

    async def crm_list_all_records(self, module, **kwargs):
        self.calls.append(("crm_list_all_records", module, kwargs))
        if module in {"Deals", "deal"}:
            return {
                "items": [
                    {
                        "id": "deal-1",
                        "Deal_Name": "Acme",
                        "Stage": "Qualification",
                        "Amount": 1000,
                        "Closing_Date": "2026-06-15",
                    }
                ],
                "truncated": False,
            }
        return {
            "items": [{"id": "lead-1", "Last_Name": "Alice", "Lead_Source": "Web"}],
            "truncated": False,
        }

    async def crm_search_records(self, module, criteria, **kwargs):
        self.calls.append(("crm_search_records", module, criteria, kwargs))
        return {"items": [{"id": "lead-1", "Last_Name": "Alice"}], "hasMore": False}

    async def crm_search_by_text(self, module, query, **kwargs):
        self.calls.append(("crm_search_by_text", module, query, kwargs))
        return {"items": [{"id": "lead-1", "Last_Name": "Alice"}], "hasMore": False}

    async def crm_get_record(self, module, record_id):
        self.calls.append(("crm_get_record", module, record_id))
        return {"id": record_id, "Last_Name": "Alice"}

    async def crm_create_record(self, module, fields):
        self.calls.append(("crm_create_record", module, fields))
        return {"id": "lead-new", "data": {"id": "lead-new"}}

    async def crm_update_record(self, module, record_id, fields):
        self.calls.append(("crm_update_record", module, record_id, fields))
        return {"data": [{"details": {"id": record_id}}]}

    async def crm_delete_record(self, module, record_id):
        self.calls.append(("crm_delete_record", module, record_id))
        return {"deleted": True}


@pytest.fixture(autouse=True)
def clean_approval_state(monkeypatch):
    approval_module._session_approved.clear()
    approval_module._pending.clear()
    approval_module._permanent_approved.clear()
    for name in (
        "HERMES_INTERACTIVE",
        "HERMES_GATEWAY_SESSION",
        "HERMES_EXEC_ASK",
        "HERMES_CRON_SESSION",
        "HERMES_YOLO_MODE",
    ):
        monkeypatch.delenv(name, raising=False)
    yield
    approval_module._session_approved.clear()
    approval_module._pending.clear()
    approval_module._permanent_approved.clear()


@pytest.mark.asyncio
async def test_zoho_books_list_uses_daterange_status_filters():
    client = FakeZohoClient()
    result = json.loads(
        await _handle_zoho_books(
            {
                "op": "list_bills",
                "dateFrom": "2026",
                "status": "Partially Paid",
                "limit": 10,
            },
            client=client,
        )
    )

    assert result["success"] is True
    assert result["data"][0]["bill_id"] == "bill-1"
    assert result["data"][0]["_amount"] == 120.5
    call = client.calls[0]
    assert call[0] == "books_list_all_records"
    assert call[1] == "bills"
    assert call[2]["filters"]["date_start"] == "2026-01-01"
    assert call[2]["filters"]["date_end"] == "2026-12-31"
    assert call[2]["filters"]["status"] == "partially_paid"


@pytest.mark.asyncio
async def test_zoho_books_get_invoice_by_human_number_resolves_internal_id():
    client = FakeZohoClient()
    result = json.loads(
        await _handle_zoho_books(
            {"op": "get_invoice_by_number", "invoiceNumber": "INV21421"},
            client=client,
        )
    )

    assert result["success"] is True
    assert result["lookup"]["invoiceNumber"] == "INV21421"
    assert result["lookup"]["invoiceId"] == "inv-internal-21421"
    assert result["data"]["invoice_id"] == "inv-internal-21421"
    assert result["data"]["lineItems"][0]["name"] == "Consulting"
    assert result["data"]["linkedTransactions"]["payments"][0]["id"] == "pay-21421"
    assert result["data"]["linkedTransactions"]["creditNotes"][0]["id"] == "cn-21421"
    assert [call[0] for call in client.calls] == [
        "books_list_records",
        "books_get_record",
        "books_get_endpoint",
        "books_get_endpoint",
    ]
    assert client.calls[0][2]["filters"]["invoice_number"] == "INV21421"


@pytest.mark.asyncio
async def test_zoho_books_get_invoice_auto_resolves_invoice_number():
    client = FakeZohoClient()
    result = json.loads(
        await _handle_zoho_books(
            {"op": "get_invoice", "invoiceId": "INV21421"},
            client=client,
        )
    )

    assert result["success"] is True
    assert result["lookup"]["method"] == "invoice_number"
    assert result["data"]["invoice_number"] == "INV21421"
    assert client.calls[0][0] == "books_list_records"
    assert client.calls[1][0] == "books_get_record"


@pytest.mark.asyncio
async def test_zoho_books_find_invoice_by_number_returns_dossier_with_linked_rows():
    client = FakeZohoClient()
    result = json.loads(
        await _handle_zoho_books(
            {"op": "find_invoice", "query": "INV21421"},
            client=client,
        )
    )

    assert result["success"] is True
    assert result["matchCount"] == 1
    assert result["selected"]["invoiceNumber"] == "INV21421"
    assert result["selected"]["total"] == 23600.0
    assert result["selected"]["taxes"][0]["amount"] == 3600.0
    assert result["selected"]["lineItems"][0]["taxPercentage"] == 18.0
    payment = result["selected"]["linkedTransactions"]["payments"][0]
    assert payment["id"] == "pay-21421"
    assert payment["number"] == "PAY-21421"
    assert payment["amount"] == 1000.0


@pytest.mark.asyncio
async def test_zoho_books_find_invoice_multiple_matches_returns_candidates():
    client = FakeZohoClient()
    result = json.loads(
        await _handle_zoho_books(
            {"op": "find_invoice", "query": "Digitas", "customerName": "Digitas"},
            client=client,
        )
    )

    assert result["success"] is True
    assert result["matchCount"] == 2
    assert result["selected"] is None
    assert [item["invoiceNumber"] for item in result["matches"]] == ["INV21421", "INV21429"]


@pytest.mark.asyncio
async def test_zoho_books_write_auto_approves_noninteractive():
    client = FakeZohoClient()
    result = json.loads(
        await _handle_zoho_books(
            {"op": "record_payment", "fields": {"invoice_id": "inv-1", "amount": 100}},
            client=client,
        )
    )

    assert result["success"] is True
    assert result["id"] == "pay-1"
    assert result["approval"] == "non_interactive_auto_approved"
    assert client.calls[0][0] == "books_record_payment"


@pytest.mark.asyncio
async def test_zoho_books_write_blocks_cron_without_approval(monkeypatch):
    monkeypatch.setenv("HERMES_CRON_SESSION", "1")
    monkeypatch.setattr(approval_module, "_get_cron_approval_mode", lambda: "deny")
    client = FakeZohoClient()

    result = json.loads(
        await _handle_zoho_books(
            {"op": "void_invoice", "invoiceId": "inv-1"},
            client=client,
        )
    )

    assert result["success"] is False
    assert "approval" in result["error"].lower()
    assert client.calls == []


@pytest.mark.asyncio
async def test_zoho_books_blocked_write_does_not_resolve_client(monkeypatch):
    monkeypatch.setenv("HERMES_CRON_SESSION", "1")
    monkeypatch.setattr(approval_module, "_get_cron_approval_mode", lambda: "deny")

    def explode(_kwargs):
        raise AssertionError("client resolution should not run before approval")

    monkeypatch.setattr("tools.zoho_runtime.resolve_tool_client", explode)

    result = json.loads(
        await _handle_zoho_books(
            {"op": "void_invoice", "invoiceId": "inv-1"},
        )
    )

    assert result["success"] is False
    assert "approval" in result["error"].lower()


@pytest.mark.asyncio
async def test_zoho_crm_search_text_and_reports():
    client = FakeZohoClient()
    search = json.loads(
        await _handle_zoho_crm(
            {"op": "search_text", "module": "lead", "query": "Alice"},
            client=client,
        )
    )
    pipeline = json.loads(
        await _handle_zoho_crm({"op": "build_pipeline_summary"}, client=client)
    )

    assert search["success"] is True
    assert search["data"][0]["id"] == "lead-1"
    assert client.calls[0][0] == "crm_search_by_text"
    assert client.calls[0][1] == "lead"
    assert pipeline["success"] is True
    assert pipeline["report"]["totalDeals"] == 1


@pytest.mark.asyncio
async def test_zoho_crm_create_update_delete_are_real_handlers():
    client = FakeZohoClient()

    created = json.loads(
        await _handle_zoho_crm(
            {"op": "create", "module": "Leads", "fields": {"Last_Name": "Smith"}},
            client=client,
        )
    )
    updated = json.loads(
        await _handle_zoho_crm(
            {
                "op": "update",
                "module": "Leads",
                "recordId": "lead-1",
                "fields": {"Last_Name": "Jones"},
            },
            client=client,
        )
    )
    deleted = json.loads(
        await _handle_zoho_crm(
            {"op": "delete", "module": "Leads", "recordId": "lead-1"},
            client=client,
        )
    )

    assert created["recordId"] == "lead-new"
    assert updated["recordId"] == "lead-1"
    assert deleted["recordId"] == "lead-1"
    assert [call[0] for call in client.calls] == [
        "crm_create_record",
        "crm_update_record",
        "crm_delete_record",
    ]


@pytest.mark.asyncio
async def test_zoho_crm_blocked_write_does_not_resolve_client(monkeypatch):
    monkeypatch.setenv("HERMES_CRON_SESSION", "1")
    monkeypatch.setattr(approval_module, "_get_cron_approval_mode", lambda: "deny")

    def explode(_kwargs):
        raise AssertionError("client resolution should not run before approval")

    monkeypatch.setattr("tools.zoho_runtime.resolve_tool_client", explode)

    result = json.loads(
        await _handle_zoho_crm(
            {"op": "delete", "module": "Leads", "recordId": "lead-1"},
        )
    )

    assert result["success"] is False
    assert "approval" in result["error"].lower()


def test_zoho_tools_are_registered_and_resolve_in_toolsets(monkeypatch):
    monkeypatch.setenv("ZOHO_CLIENT_ID", "client")
    monkeypatch.setenv("ZOHO_CLIENT_SECRET", "secret")
    monkeypatch.setenv("ZOHO_REFRESH_TOKEN", "refresh")

    books = registry.get_entry("zoho_books")
    crm = registry.get_entry("zoho_crm")
    assert books is not None
    assert crm is not None
    assert books.toolset == "zoho"
    assert crm.toolset == "zoho"
    assert "zoho_books" in resolve_toolset("zoho")
    assert "zoho_crm" in resolve_toolset("zoho")
    definitions = registry.get_definitions({"zoho_books", "zoho_crm"})
    names = {item["function"]["name"] for item in definitions}
    assert names == {"zoho_books", "zoho_crm"}
