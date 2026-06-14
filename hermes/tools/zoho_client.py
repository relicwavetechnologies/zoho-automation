"""Zoho Books and CRM REST client helpers for Hermes-native tools."""

from __future__ import annotations

import asyncio
import csv
import io
from collections.abc import Awaitable, Callable
from calendar import monthrange
from datetime import datetime, timedelta, timezone
from typing import Any
from urllib.parse import quote

import httpx

from tools.zoho_auth import (
    DEFAULT_ZOHO_API_BASE_URL,
    ZohoCredentials,
    ZohoTokenProvider,
)


DEFAULT_BOOKS_MAX_PAGES = 20
DEFAULT_CRM_MAX_PAGES = 50
DEFAULT_INLINE_THRESHOLD = 25
BOOKS_MODULES = {
    "contacts",
    "invoices",
    "estimates",
    "creditnotes",
    "bills",
    "salesorders",
    "purchaseorders",
    "customerpayments",
    "vendorpayments",
    "bankaccounts",
    "banktransactions",
    "expenses",
    "items",
}
CRM_MODULES = {"Leads", "Contacts", "Accounts", "Deals", "Tasks"}


class ZohoClientError(RuntimeError):
    """Base class for Zoho client failures."""


class ZohoAPIError(ZohoClientError):
    """Raised when a Zoho API request fails."""

    def __init__(
        self,
        status_code: int,
        method: str,
        url: str,
        message: str,
        *,
        retry_after_seconds: float | None = None,
        payload: Any = None,
    ) -> None:
        self.status_code = status_code
        self.method = method
        self.url = url
        self.retry_after_seconds = retry_after_seconds
        self.payload = payload
        super().__init__(f"Zoho API error {status_code} for {method} {url}: {message}")


class ZohoClient:
    """Async Zoho Books/CRM client with retries, pagination, and token refresh."""

    def __init__(
        self,
        token_provider: ZohoTokenProvider,
        *,
        api_base_url: str = DEFAULT_ZOHO_API_BASE_URL,
        organization_id: str | None = None,
        timeout: float = 60.0,
        max_retries: int = 3,
        transport: httpx.AsyncBaseTransport | None = None,
        sleep: Callable[[float], Awaitable[None]] | None = None,
        user_agent: str = "Hermes-Agent/zoho-client",
    ) -> None:
        self.token_provider = token_provider
        self.api_base_url = api_base_url.rstrip("/")
        self.organization_id = organization_id
        self.books_base = f"{self.api_base_url}/books/v3"
        self.crm_base = f"{self.api_base_url}/crm/v6"
        self.timeout = timeout
        self.max_retries = max(0, int(max_retries))
        self._transport = transport
        self._sleep = sleep or asyncio.sleep
        self.user_agent = user_agent

    @classmethod
    def from_env(cls, **kwargs: Any) -> "ZohoClient":
        credentials = ZohoCredentials.from_env()
        provider = ZohoTokenProvider(credentials)
        return cls(
            provider,
            api_base_url=credentials.api_base_url,
            organization_id=credentials.organization_id,
            **kwargs,
        )

    # ------------------------------------------------------------------
    # Generic HTTP
    # ------------------------------------------------------------------

    async def _request(
        self,
        service: str,
        method: str,
        path: str,
        *,
        params: dict[str, Any] | None = None,
        json_body: Any | None = None,
        allow_no_content: bool = False,
    ) -> Any:
        url = self._resolve_url(service, path)
        attempt = 0
        last_error: Exception | None = None

        while attempt <= self.max_retries:
            token = await self.token_provider.get_access_token(
                force_refresh=attempt > 0 and _should_refresh_token(last_error)
            )
            headers = {
                "Authorization": f"Zoho-oauthtoken {token}",
                "Accept": "application/json",
                "Content-Type": "application/json",
                "User-Agent": self.user_agent,
            }

            try:
                async with httpx.AsyncClient(
                    timeout=httpx.Timeout(self.timeout),
                    transport=self._transport,
                ) as client:
                    response = await client.request(
                        method,
                        url,
                        params=_clean_params(params),
                        json=json_body,
                        headers=headers,
                    )
            except httpx.HTTPError as exc:
                last_error = exc
                if attempt >= self.max_retries:
                    raise ZohoClientError(
                        f"Zoho request failed for {method} {url}: {exc}"
                    ) from exc
                await self._sleep(_retry_delay(None, attempt))
                attempt += 1
                continue

            if response.status_code == 204 and allow_no_content:
                return None
            if response.status_code < 400:
                return _decode_json(response)

            api_error = _build_api_error(method, url, response)
            last_error = api_error

            if response.status_code == 401 and attempt < self.max_retries:
                self.token_provider.clear_cache()
                await self._sleep(_retry_delay(response, attempt))
                attempt += 1
                continue

            if _should_retry(response) and attempt < self.max_retries:
                await self._sleep(_retry_delay(response, attempt))
                attempt += 1
                continue

            raise api_error

        raise ZohoClientError(f"Zoho request exhausted retries for {method} {url}.")

    def _resolve_url(self, service: str, path: str) -> str:
        if path.startswith("http://") or path.startswith("https://"):
            return path
        prefix = self.books_base if service == "books" else self.crm_base
        return f"{prefix}/{path.lstrip('/')}"

    # ------------------------------------------------------------------
    # Books
    # ------------------------------------------------------------------

    async def list_books_organizations(self) -> list[dict[str, Any]]:
        data = await self._request("books", "GET", "/organizations")
        organizations = []
        for org in _as_records(data.get("organizations") if isinstance(data, dict) else None):
            org_id = _as_str(org.get("organization_id")) or _as_str(org.get("organizationId"))
            if not org_id:
                continue
            organizations.append(
                {
                    "organizationId": org_id,
                    "name": _as_str(org.get("name")),
                    "isDefault": _as_bool(org.get("is_default_org"))
                    if _as_bool(org.get("is_default_org")) is not None
                    else _as_bool(org.get("is_default")),
                }
            )
        return organizations

    async def resolve_books_organization_id(
        self,
        preferred: str | None = None,
    ) -> str:
        if preferred:
            return preferred
        if self.organization_id:
            return self.organization_id
        orgs = await self.list_books_organizations()
        default_org = next((org for org in orgs if org.get("isDefault") is True), None)
        org_id = (default_org or (orgs[0] if orgs else {})).get("organizationId")
        if not org_id:
            raise ZohoClientError(
                "Zoho Books organization_id is required. Set ZOHO_ORGANIZATION_ID "
                "or ensure /organizations returns a default organization."
            )
        return str(org_id)

    async def books_get_endpoint(
        self,
        path: str,
        *,
        organization_id: str | None = None,
        params: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        org_id = await self.resolve_books_organization_id(organization_id)
        merged = {"organization_id": org_id, **(params or {})}
        data = await self._request("books", "GET", path, params=merged)
        return data if isinstance(data, dict) else {"data": data}

    async def books_post_endpoint(
        self,
        path: str,
        *,
        organization_id: str | None = None,
        body: Any | None = None,
    ) -> dict[str, Any]:
        org_id = await self.resolve_books_organization_id(organization_id)
        data = await self._request(
            "books",
            "POST",
            path,
            params={"organization_id": org_id},
            json_body=body or {},
        )
        return data if isinstance(data, dict) else {"data": data}

    async def books_list_records(
        self,
        module_name: str,
        *,
        organization_id: str | None = None,
        filters: dict[str, Any] | None = None,
        query: str | None = None,
        page: int | None = None,
        per_page: int = 25,
        max_pages: int = DEFAULT_BOOKS_MAX_PAGES,
    ) -> dict[str, Any]:
        module = _normalize_books_module(module_name)
        org_id = await self.resolve_books_organization_id(organization_id)
        per_page = max(1, min(200, int(per_page or 25)))
        query = (query or "").strip() or None

        if module == "contacts" and query and not _has_contact_name_filter(filters):
            for field in ("contact_name", "company_name"):
                page_data = await self._books_fetch_page(
                    module,
                    org_id,
                    filters={**(filters or {}), field: query},
                    query=None,
                    page=1,
                    per_page=per_page,
                )
                if page_data["items"]:
                    return {
                        "organizationId": org_id,
                        "items": page_data["items"],
                        "hasMore": page_data["hasMore"],
                        "page": 1,
                    }

        if page is not None:
            page_data = await self._books_fetch_page(
                module,
                org_id,
                filters=filters,
                query=query,
                page=page,
                per_page=per_page,
            )
            return {
                "organizationId": org_id,
                "items": page_data["items"],
                "hasMore": page_data["hasMore"],
                "page": page,
            }

        collected: list[dict[str, Any]] = []
        last_has_more = False
        last_page = 0
        for current_page in range(1, max_pages + 1):
            last_page = current_page
            page_data = await self._books_fetch_page(
                module,
                org_id,
                filters=filters,
                query=query,
                page=current_page,
                per_page=per_page,
            )
            collected.extend(page_data["items"])
            deduped = _dedupe_records(collected)
            last_has_more = bool(page_data["hasMore"])
            if len(deduped) >= per_page or not last_has_more:
                return {
                    "organizationId": org_id,
                    "items": deduped[:per_page],
                    "hasMore": last_has_more,
                    "page": current_page,
                }

        return {
            "organizationId": org_id,
            "items": _dedupe_records(collected)[:per_page],
            "hasMore": last_has_more,
            "page": last_page,
        }

    async def books_list_all_records(
        self,
        module_name: str,
        *,
        organization_id: str | None = None,
        filters: dict[str, Any] | None = None,
        query: str | None = None,
        max_pages: int = DEFAULT_BOOKS_MAX_PAGES,
    ) -> dict[str, Any]:
        raw_status = _as_str((filters or {}).get("status"))
        if raw_status and "," in raw_status:
            merged: list[dict[str, Any]] = []
            org_id = ""
            truncated = False
            for status in [s.strip() for s in raw_status.split(",") if s.strip()]:
                result = await self.books_list_all_records(
                    module_name,
                    organization_id=organization_id,
                    filters={**(filters or {}), "status": status},
                    query=query,
                    max_pages=max_pages,
                )
                org_id = org_id or str(result.get("organizationId") or "")
                truncated = truncated or bool(result.get("truncated"))
                merged.extend(_as_records(result.get("items")))
            return {
                "organizationId": org_id,
                "items": _dedupe_records(merged),
                "truncated": truncated,
            }

        module = _normalize_books_module(module_name)
        org_id = await self.resolve_books_organization_id(organization_id)
        query = (query or "").strip() or None
        collected: list[dict[str, Any]] = []
        truncated = False

        for page in range(1, max_pages + 1):
            page_data = await self._books_fetch_page(
                module,
                org_id,
                filters=filters,
                query=query,
                page=page,
                per_page=200,
            )
            collected.extend(page_data["items"])
            if not page_data["hasMore"]:
                break
            if page == max_pages:
                truncated = True

        return {
            "organizationId": org_id,
            "items": _dedupe_records(collected),
            "truncated": truncated,
        }

    async def books_get_record(
        self,
        module_name: str,
        record_id: str,
        *,
        organization_id: str | None = None,
    ) -> dict[str, Any] | None:
        module = _normalize_books_module(module_name)
        org_id = await self.resolve_books_organization_id(organization_id)
        data = await self._request(
            "books",
            "GET",
            f"/{module}/{quote(str(record_id), safe='')}",
            params={"organization_id": org_id},
        )
        if not isinstance(data, dict):
            return None
        singular = module[:-1] if module.endswith("s") else module
        return _as_record(data.get(singular)) or _as_record(data.get(module)) or data

    async def books_create_invoice(
        self,
        fields: dict[str, Any],
        *,
        organization_id: str | None = None,
    ) -> dict[str, Any]:
        data = await self.books_post_endpoint(
            "/invoices",
            organization_id=organization_id,
            body=fields,
        )
        invoice = _as_record(data.get("invoice"))
        invoice_id = _as_str(invoice.get("invoice_id")) or _as_str(invoice.get("id"))
        if not invoice_id:
            raise ZohoClientError("Zoho Books create_invoice: no invoice_id in response")
        return {"invoiceId": invoice_id, "data": invoice}

    async def books_send_invoice(
        self,
        invoice_id: str,
        *,
        email: str | None = None,
        organization_id: str | None = None,
    ) -> dict[str, Any]:
        body = {"to_mail_ids": [email]} if email else {}
        data = await self.books_post_endpoint(
            f"/invoices/{quote(str(invoice_id), safe='')}/email",
            organization_id=organization_id,
            body=body,
        )
        return {"invoiceId": invoice_id, "data": data}

    async def books_record_payment(
        self,
        fields: dict[str, Any],
        *,
        organization_id: str | None = None,
    ) -> dict[str, Any]:
        data = await self.books_post_endpoint(
            "/customerpayments",
            organization_id=organization_id,
            body=fields,
        )
        payment = _as_record(data.get("payment")) or _as_record(data.get("customerpayment"))
        payment_id = _as_str(payment.get("payment_id")) or _as_str(payment.get("id"))
        if not payment_id:
            raise ZohoClientError("Zoho Books record_payment: no payment_id in response")
        return {"paymentId": payment_id, "data": payment}

    async def books_create_expense(
        self,
        fields: dict[str, Any],
        *,
        organization_id: str | None = None,
    ) -> dict[str, Any]:
        data = await self.books_post_endpoint(
            "/expenses",
            organization_id=organization_id,
            body=fields,
        )
        expense = _as_record(data.get("expense"))
        expense_id = _as_str(expense.get("expense_id")) or _as_str(expense.get("id"))
        if not expense_id:
            raise ZohoClientError("Zoho Books create_expense: no expense_id in response")
        return {"expenseId": expense_id, "data": expense}

    async def books_create_bill(
        self,
        fields: dict[str, Any],
        *,
        organization_id: str | None = None,
    ) -> dict[str, Any]:
        data = await self.books_post_endpoint(
            "/bills",
            organization_id=organization_id,
            body=fields,
        )
        bill = _as_record(data.get("bill"))
        bill_id = _as_str(bill.get("bill_id")) or _as_str(bill.get("id"))
        if not bill_id:
            raise ZohoClientError("Zoho Books create_bill: no bill_id in response")
        return {"billId": bill_id, "data": bill}

    async def books_void_invoice(
        self,
        invoice_id: str,
        *,
        organization_id: str | None = None,
    ) -> dict[str, Any]:
        data = await self.books_post_endpoint(
            f"/invoices/{quote(str(invoice_id), safe='')}/status/void",
            organization_id=organization_id,
            body={},
        )
        return {"invoiceId": invoice_id, "data": data}

    async def _books_fetch_page(
        self,
        module: str,
        organization_id: str,
        *,
        filters: dict[str, Any] | None,
        query: str | None,
        page: int,
        per_page: int,
    ) -> dict[str, Any]:
        params: dict[str, Any] = {
            "organization_id": organization_id,
            "page": max(1, int(page)),
            "per_page": max(1, min(200, int(per_page))),
        }
        if query:
            params["search_text"] = query
        params.update(filters or {})
        raw = await self._request("books", "GET", f"/{module}", params=params)
        if not isinstance(raw, dict):
            raw = {}
        return {
            "items": _as_records(raw.get(module)),
            "hasMore": _books_has_more(raw),
            "raw": raw,
        }

    # ------------------------------------------------------------------
    # CRM
    # ------------------------------------------------------------------

    async def crm_list_records(
        self,
        module: str,
        *,
        sort_by: str | None = None,
        sort_order: str | None = None,
        fields: list[str] | None = None,
        page: int | None = None,
        per_page: int = 25,
        max_pages: int = 10,
    ) -> dict[str, Any]:
        mod = normalize_crm_module(module)
        per_page = max(1, min(200, int(per_page or 25)))

        if page is not None:
            page_data = await self._crm_fetch_page(
                mod,
                page=page,
                per_page=per_page,
                sort_by=sort_by,
                sort_order=sort_order,
                fields=fields,
            )
            return {
                "items": page_data["items"],
                "hasMore": page_data["moreRecords"],
                "page": page,
                **(
                    {"nextPageToken": page_data["nextPageToken"]}
                    if page_data.get("nextPageToken")
                    else {}
                ),
            }

        collected: list[dict[str, Any]] = []
        page_token: str | None = None
        last_has_more = False
        for current_page in range(1, max_pages + 1):
            page_data = await self._crm_fetch_page(
                mod,
                page=None if page_token else current_page,
                page_token=page_token,
                per_page=per_page,
                sort_by=sort_by,
                sort_order=sort_order,
                fields=fields,
            )
            collected.extend(page_data["items"])
            deduped = _dedupe_records(collected)
            last_has_more = bool(page_data["moreRecords"])
            page_token = page_data.get("nextPageToken")
            if len(deduped) >= per_page or not last_has_more:
                return {
                    "items": deduped[:per_page],
                    "hasMore": last_has_more,
                    "page": current_page,
                    **({"nextPageToken": page_token} if page_token else {}),
                }

        return {
            "items": _dedupe_records(collected)[:per_page],
            "hasMore": last_has_more,
            "page": max_pages,
        }

    async def crm_list_all_records(
        self,
        module: str,
        *,
        sort_by: str | None = None,
        sort_order: str | None = None,
        fields: list[str] | None = None,
        max_pages: int = DEFAULT_CRM_MAX_PAGES,
    ) -> dict[str, Any]:
        mod = normalize_crm_module(module)
        collected: list[dict[str, Any]] = []
        seen: set[str] = set()
        page_token: str | None = None
        truncated = False

        for page in range(1, max_pages + 1):
            page_data = await self._crm_fetch_page(
                mod,
                page=None if page_token else page,
                page_token=page_token,
                per_page=200,
                sort_by=sort_by,
                sort_order=sort_order,
                fields=fields,
            )
            for item in page_data["items"]:
                record_key = _record_id(item)
                if record_key in seen:
                    continue
                seen.add(record_key)
                collected.append(item)
            if not page_data["moreRecords"]:
                break
            page_token = page_data.get("nextPageToken")
            if page == max_pages:
                truncated = True

        return {"items": collected, "truncated": truncated}

    async def crm_search_records(
        self,
        module: str,
        criteria: str,
        *,
        per_page: int = 25,
        page: int = 1,
    ) -> dict[str, Any]:
        mod = normalize_crm_module(module)
        data = await self._request(
            "crm",
            "GET",
            f"/{mod}/search",
            params={
                "criteria": criteria,
                "per_page": max(1, min(200, int(per_page or 25))),
                "page": max(1, int(page or 1)),
            },
            allow_no_content=True,
        )
        if not data:
            return {"items": [], "hasMore": False, "page": page}
        info = _as_record(data.get("info")) if isinstance(data, dict) else {}
        return {
            "items": _as_records(data.get("data") if isinstance(data, dict) else None),
            "hasMore": _as_bool(info.get("more_records")) or False,
            "page": page,
        }

    async def crm_search_by_text(
        self,
        module: str,
        query: str,
        *,
        per_page: int = 25,
    ) -> dict[str, Any]:
        mod = normalize_crm_module(module)
        q = (query or "").strip()
        if not q:
            return {"items": [], "hasMore": False, "page": 1}
        fields = CRM_SEARCH_FIELDS.get(mod, ["Last_Name"])
        criteria = "or".join(f"({field}:contains:{q})" for field in fields)
        try:
            return await self.crm_search_records(mod, criteria, per_page=per_page)
        except Exception:
            return {"items": [], "hasMore": False, "page": 1}

    async def crm_get_record(
        self,
        module: str,
        record_id: str,
    ) -> dict[str, Any] | None:
        mod = normalize_crm_module(module)
        data = await self._request(
            "crm",
            "GET",
            f"/{mod}/{quote(str(record_id), safe='')}",
            allow_no_content=True,
        )
        if not data or not isinstance(data, dict):
            return None
        return _as_records(data.get("data"))[0] if _as_records(data.get("data")) else None

    async def crm_create_record(
        self,
        module: str,
        fields: dict[str, Any],
    ) -> dict[str, Any]:
        mod = normalize_crm_module(module)
        data = await self._request(
            "crm",
            "POST",
            f"/{mod}",
            json_body={"data": [fields]},
        )
        if not isinstance(data, dict):
            raise ZohoClientError("Zoho CRM create: empty response")
        first = _as_records(data.get("data"))[0] if _as_records(data.get("data")) else {}
        details = _as_record(first.get("details"))
        record_id = _as_str(details.get("id")) or _as_str(first.get("id"))
        if not record_id:
            raise ZohoClientError("Zoho CRM create: no id in response")
        return {"id": record_id, "data": first}

    async def crm_update_record(
        self,
        module: str,
        record_id: str,
        fields: dict[str, Any],
    ) -> dict[str, Any]:
        mod = normalize_crm_module(module)
        data = await self._request(
            "crm",
            "PUT",
            f"/{mod}/{quote(str(record_id), safe='')}",
            json_body={"data": [{**fields, "id": record_id}]},
        )
        return data if isinstance(data, dict) else {"data": data}

    async def crm_delete_record(
        self,
        module: str,
        record_id: str,
    ) -> dict[str, Any]:
        mod = normalize_crm_module(module)
        data = await self._request(
            "crm",
            "DELETE",
            f"/{mod}/{quote(str(record_id), safe='')}",
            allow_no_content=True,
        )
        return data if isinstance(data, dict) else {"deleted": True}

    async def _crm_fetch_page(
        self,
        module: str,
        *,
        page: int | None = None,
        page_token: str | None = None,
        per_page: int,
        sort_by: str | None,
        sort_order: str | None,
        fields: list[str] | None,
    ) -> dict[str, Any]:
        params: dict[str, Any] = {"per_page": max(1, min(200, int(per_page)))}
        if page_token:
            params["page_token"] = page_token
        elif page:
            params["page"] = max(1, int(page))
        if sort_by:
            params["sort_by"] = sort_by
        if sort_order:
            params["sort_order"] = sort_order
        field_list = fields if fields else CRM_DEFAULT_FIELDS.get(module)
        if field_list:
            params["fields"] = ",".join(field_list)

        data = await self._request("crm", "GET", f"/{module}", params=params)
        if not isinstance(data, dict):
            data = {}
        info = _as_record(data.get("info"))
        return {
            "items": _as_records(data.get("data")),
            "moreRecords": _as_bool(info.get("more_records")) or False,
            "nextPageToken": _as_str(info.get("next_page_token")),
        }


# ---------------------------------------------------------------------------
# Report builders
# ---------------------------------------------------------------------------


async def build_overdue_report(
    client: ZohoClient,
    *,
    organization_id: str | None = None,
    as_of_date: str | None = None,
    min_overdue_days: int = 1,
    invoice_date_from: str | None = None,
    invoice_date_to: str | None = None,
    inline_threshold: int = 10,
) -> dict[str, Any]:
    as_of = _parse_date(as_of_date) or datetime.now(timezone.utc)
    min_overdue = max(0, int(min_overdue_days or 0))
    from_date = _parse_date(invoice_date_from)
    to_date = _parse_date(invoice_date_to)

    result = await client.books_list_all_records(
        "invoices",
        organization_id=organization_id,
        filters={"status": "overdue"},
    )
    invoices = []
    for row in _as_records(result.get("items")):
        due_date = _parse_date(_as_str(row.get("due_date")))
        invoice_date = _parse_date(_as_str(row.get("date")))
        balance = _read_number(row, "balance", "amount_due", "outstanding_balance")
        overdue_days = _diff_days(as_of, due_date)
        if balance <= 0:
            continue
        if overdue_days < min_overdue:
            continue
        if not _date_in_range(invoice_date, from_date, to_date):
            continue
        invoices.append(
            {
                **_compact(
                    {
                        "invoiceId": _as_str(row.get("invoice_id")) or _as_str(row.get("id")),
                        "invoiceNumber": _as_str(row.get("invoice_number"))
                        or _as_str(row.get("number")),
                        "customerId": _as_str(row.get("customer_id"))
                        or _as_str(row.get("contact_id")),
                        "customerName": _as_str(row.get("customer_name"))
                        or _as_str(row.get("contact_name"))
                        or _as_str(row.get("company_name")),
                        "dueDate": _as_str(row.get("due_date")),
                        "invoiceDate": _as_str(row.get("date")),
                    }
                ),
                "currencyCode": _as_str(row.get("currency_code"))
                or _as_str(row.get("currency"))
                or "INR",
                "status": _as_str(row.get("status")) or "unknown",
                "total": _read_number(row, "total", "amount"),
                "balance": balance,
                "overdueDays": overdue_days,
            }
        )

    invoices.sort(key=lambda item: item["overdueDays"], reverse=True)
    buckets = {
        "current": 0.0,
        "days_1_30": 0.0,
        "days_31_60": 0.0,
        "days_61_90": 0.0,
        "days_91_plus": 0.0,
    }
    customer_totals: dict[str, dict[str, Any]] = {}
    currency_totals: dict[str, float] = {}

    for invoice in invoices:
        days = int(invoice["overdueDays"])
        balance = float(invoice["balance"])
        if days <= 0:
            buckets["current"] += balance
        elif days <= 30:
            buckets["days_1_30"] += balance
        elif days <= 60:
            buckets["days_31_60"] += balance
        elif days <= 90:
            buckets["days_61_90"] += balance
        else:
            buckets["days_91_plus"] += balance

        customer_key = (
            invoice.get("customerId")
            or invoice.get("customerName")
            or invoice.get("invoiceId")
            or "unknown"
        )
        existing = customer_totals.setdefault(
            str(customer_key),
            {
                "customerId": invoice.get("customerId"),
                "customerName": invoice.get("customerName"),
                "currencyCode": invoice["currencyCode"],
                "balance": 0.0,
                "invoiceCount": 0,
            },
        )
        existing["balance"] += balance
        existing["invoiceCount"] += 1
        currency_totals[invoice["currencyCode"]] = (
            currency_totals.get(invoice["currencyCode"], 0.0) + balance
        )

    top_customers = sorted(
        (_compact(customer) for customer in customer_totals.values()),
        key=lambda item: float(item.get("balance") or 0),
        reverse=True,
    )[:10]
    formatted_total = ", ".join(
        format_amount(amount, currency) for currency, amount in currency_totals.items()
    )
    summary = (
        f"Found {len(invoices)} overdue invoice(s) totalling {formatted_total}."
        if invoices
        else "No overdue invoices matched the current criteria."
    )
    if len(invoices) > inline_threshold:
        summary += f" Showing top {min(inline_threshold, len(invoices))} by overdue days."
    if result.get("truncated"):
        summary += " Source pagination limit reached; totals may be understated."

    return {
        "summary": summary,
        "asOfDate": as_of.date().isoformat(),
        "organizationId": result.get("organizationId"),
        "invoiceCount": len(invoices),
        "totalOutstanding": sum(float(v) for v in currency_totals.values()),
        "currencyTotals": currency_totals,
        "bucketTotals": buckets,
        "topCustomers": top_customers,
        "inlineInvoices": invoices[:inline_threshold],
        "sourceTruncated": bool(result.get("truncated")),
        "appliedFilters": _compact(
            {
                "minOverdueDays": min_overdue,
                "invoiceDateFrom": invoice_date_from,
                "invoiceDateTo": invoice_date_to,
            }
        ),
    }


async def build_pipeline_summary(
    client: ZohoClient,
    *,
    currency: str = "INR",
    inline_threshold: int = 10,
) -> dict[str, Any]:
    result = await client.crm_list_all_records("Deals")
    deals = _as_records(result.get("items"))
    stage_map: dict[str, dict[str, Any]] = {}
    total_pipeline = 0.0

    for deal in deals:
        stage = _as_str(deal.get("Stage")) or "Unknown"
        amount = _read_number(deal, "Amount")
        total_pipeline += amount
        existing = stage_map.setdefault(
            stage,
            {"stage": stage, "count": 0, "totalAmount": 0.0, "currency": currency, "deals": []},
        )
        existing["count"] += 1
        existing["totalAmount"] += amount
        existing["deals"].append(
            {
                "dealName": _as_str(deal.get("Deal_Name")) or "",
                "amount": amount,
                "accountName": _read_lookup_name(deal, "Account_Name"),
                "owner": _read_owner_name(deal),
                "closingDate": _as_str(deal.get("Closing_Date")) or "",
            }
        )

    stages = sorted(
        stage_map.values(),
        key=lambda item: float(item.get("totalAmount") or 0),
        reverse=True,
    )
    stage_breakdown = "; ".join(
        f"{stage['stage']}: {stage['count']} deal(s), "
        f"{format_amount(float(stage['totalAmount']), currency)}"
        for stage in stages
    )
    summary = (
        f"Pipeline: {len(deals)} deal(s) worth {format_amount(total_pipeline, currency)}. "
        f"{stage_breakdown}."
        if deals
        else "No deals found in the CRM pipeline."
    )
    if result.get("truncated"):
        summary += " Pagination limit reached; additional deals may exist."

    return {
        "summary": summary,
        "totalDeals": len(deals),
        "totalPipelineValue": total_pipeline,
        "currency": currency,
        "stages": stages,
        "inlineDeals": deals[:inline_threshold],
        "sourceTruncated": bool(result.get("truncated")),
    }


async def build_lead_report(
    client: ZohoClient,
    *,
    inline_threshold: int = 10,
) -> dict[str, Any]:
    result = await client.crm_list_all_records("Leads")
    leads = _as_records(result.get("items"))
    sources: dict[str, dict[str, Any]] = {}
    statuses: dict[str, int] = {}

    for lead in leads:
        source = _as_str(lead.get("Lead_Source")) or "Unknown"
        status = _as_str(lead.get("Lead_Status")) or "Unknown"
        statuses[status] = statuses.get(status, 0) + 1
        existing = sources.setdefault(source, {"source": source, "count": 0, "statuses": {}})
        existing["count"] += 1
        existing["statuses"][status] = existing["statuses"].get(status, 0) + 1

    source_list = sorted(sources.values(), key=lambda item: item["count"], reverse=True)
    source_breakdown = ", ".join(
        f"{source['source']}: {source['count']}" for source in source_list[:5]
    )
    summary = (
        f"Lead funnel: {len(leads)} lead(s). Top sources: {source_breakdown}."
        if leads
        else "No leads found in CRM."
    )
    if result.get("truncated"):
        summary += " Pagination limit reached; additional leads may exist."

    return {
        "summary": summary,
        "totalLeads": len(leads),
        "sources": source_list,
        "statusBreakdown": statuses,
        "inlineLeads": leads[:inline_threshold],
        "sourceTruncated": bool(result.get("truncated")),
    }


async def build_deal_forecast(
    client: ZohoClient,
    *,
    closing_from: str | None = None,
    closing_to: str | None = None,
    currency: str = "INR",
    inline_threshold: int = 10,
) -> dict[str, Any]:
    result = await client.crm_list_all_records("Deals")
    all_deals = _as_records(result.get("items"))
    from_date = _parse_date(closing_from)
    to_date = _parse_date(closing_to)
    filtered = []

    for deal in all_deals:
        closing = _parse_date(_as_str(deal.get("Closing_Date")))
        if closing is None:
            continue
        if from_date and closing < from_date:
            continue
        if to_date and closing > to_date:
            continue
        filtered.append(deal)

    by_stage: dict[str, dict[str, Any]] = {}
    total_amount = 0.0
    for deal in filtered:
        stage = _as_str(deal.get("Stage")) or "Unknown"
        amount = _read_number(deal, "Amount")
        total_amount += amount
        existing = by_stage.setdefault(stage, {"stage": stage, "count": 0, "amount": 0.0})
        existing["count"] += 1
        existing["amount"] += amount

    stage_list = sorted(by_stage.values(), key=lambda item: item["amount"], reverse=True)
    date_range = (
        f" ({closing_from} to {closing_to})"
        if closing_from and closing_to
        else f" (from {closing_from})"
        if closing_from
        else f" (until {closing_to})"
        if closing_to
        else ""
    )
    summary = (
        f"Deal forecast{date_range}: {len(filtered)} deal(s) worth "
        f"{format_amount(total_amount, currency)}."
        if filtered
        else f"No deals closing{date_range}."
    )
    if result.get("truncated"):
        summary += " Pagination limit reached; additional deals may exist."

    return {
        "summary": summary,
        "totalDeals": len(filtered),
        "totalAmount": total_amount,
        "currency": currency,
        "byStage": stage_list,
        "inlineDeals": filtered[:inline_threshold],
        "sourceTruncated": bool(result.get("truncated")),
    }


# ---------------------------------------------------------------------------
# Shared formatting/filter helpers
# ---------------------------------------------------------------------------


def parse_date_filter(value: str | None, now: datetime | None = None) -> dict[str, str]:
    current = now or datetime.now(timezone.utc)
    raw = (value or "").strip()
    lowered = raw.lower()
    if not lowered:
        today = current.date().isoformat()
        return {"from": today, "to": today}
    quarter = _parse_quarter(lowered)
    if quarter:
        return quarter
    if _is_iso_date(lowered):
        return {"from": lowered, "to": lowered}
    if len(lowered) == 4 and lowered.isdigit():
        return {"from": f"{lowered}-01-01", "to": f"{lowered}-12-31"}

    year = current.year
    month = current.month
    if lowered == "today":
        today = current.date().isoformat()
        return {"from": today, "to": today}
    if lowered == "yesterday":
        y = _date_from_parts(year, month, current.day - 1)
        return {"from": y, "to": y}
    if lowered == "this month":
        return {"from": _date_from_parts(year, month, 1), "to": _end_of_month(year, month)}
    if lowered == "last month":
        y, m = (year - 1, 12) if month == 1 else (year, month - 1)
        return {"from": _date_from_parts(y, m, 1), "to": _end_of_month(y, m)}
    if lowered == "this quarter":
        start_month = ((month - 1) // 3) * 3 + 1
        return {
            "from": _date_from_parts(year, start_month, 1),
            "to": _end_of_month(year, start_month + 2),
        }
    if lowered == "last quarter":
        start_month = ((month - 1) // 3) * 3 + 1
        last_start = start_month - 3
        q_year = year
        if last_start <= 0:
            last_start += 12
            q_year -= 1
        return {
            "from": _date_from_parts(q_year, last_start, 1),
            "to": _end_of_month(q_year, last_start + 2),
        }
    if lowered == "this year":
        return {"from": f"{year}-01-01", "to": f"{year}-12-31"}
    if lowered == "last year":
        return {"from": f"{year - 1}-01-01", "to": f"{year - 1}-12-31"}
    return {"from": raw, "to": raw}


def normalize_status(value: str | None) -> str | None:
    if value is None:
        return None
    normalized = value.strip().lower().replace("-", " ").replace("_", " ")
    status_map = {
        "unpaid": "unpaid",
        "overdue": "overdue",
        "paid": "paid",
        "draft": "draft",
        "sent": "sent",
        "void": "void",
        "voided": "void",
        "partially paid": "partially_paid",
        "open": "sent",
    }
    return status_map.get(normalized, "_".join(normalized.split()))


def build_date_range_params(
    date_from: str | None = None,
    date_to: str | None = None,
) -> dict[str, str]:
    if date_from and date_to:
        return {
            "date_start": parse_date_filter(date_from)["from"],
            "date_end": parse_date_filter(date_to)["to"],
        }
    if date_from:
        parsed = parse_date_filter(date_from)
        return {"date_start": parsed["from"], "date_end": parsed["to"]}
    if date_to:
        parsed = parse_date_filter(date_to)
        return {"date_start": parsed["from"], "date_end": parsed["to"]}
    return {}


def format_books_result(value: Any) -> Any:
    if isinstance(value, list):
        return [format_books_result(item) for item in value]
    if not isinstance(value, dict):
        return value
    formatted: dict[str, Any] = {}
    currency = _currency_from(value)
    for key, field_value in value.items():
        formatted[key] = format_books_result(field_value)
        if key.endswith("_formatted") or key.endswith("Formatted"):
            continue
        if key in AMOUNT_FIELDS:
            amount = _as_number(field_value)
            if amount is not None:
                formatted[_display_key(key)] = format_amount(amount, currency)
        if key in DATE_FIELDS and isinstance(field_value, str):
            formatted[_display_key(key)] = format_date(field_value)
    return formatted


def format_crm_result(value: Any) -> Any:
    if isinstance(value, list):
        return [format_crm_result(item) for item in value]
    if not isinstance(value, dict):
        return value
    formatted: dict[str, Any] = {}
    for key, field_value in value.items():
        if isinstance(field_value, dict) and "id" in field_value and "name" in field_value:
            formatted[key] = field_value.get("name")
            formatted[f"{key}_id"] = field_value.get("id")
        else:
            formatted[key] = format_crm_result(field_value)
    return formatted


def enrich_books_records(items: list[dict[str, Any]]) -> list[dict[str, Any]]:
    enriched = []
    for item in items:
        copy = dict(item)
        amount = _read_number(copy, "amount", "total", "sub_total", "balance")
        balance = _read_number(copy, "balance", "amount_due", "outstanding_balance", "amount")
        total = _read_number(copy, "total", "amount")
        date_value = (
            _as_str(copy.get("date"))
            or _as_str(copy.get("due_date"))
            or _as_str(copy.get("transaction_date"))
            or _as_str(copy.get("payment_date"))
        )
        copy.setdefault("_amount", amount)
        copy.setdefault("_balance", balance)
        copy.setdefault("_total", total)
        copy.setdefault("_currency", _currency_from(copy))
        if date_value:
            copy.setdefault("_date", date_value)
        enriched.append(copy)
    return enriched


def summarize_records(
    module_label: str,
    amount_keys: list[str],
    items: list[dict[str, Any]],
) -> str:
    if not items:
        return f"No {module_label.lower()} matched the current criteria."
    if not amount_keys:
        return f"Found {len(items)} {module_label.lower()}."
    totals: dict[str, float] = {}
    for item in items:
        currency = _currency_from(item)
        totals[currency] = totals.get(currency, 0.0) + _read_number(item, *amount_keys)
    total_text = ", ".join(
        f"{format_amount(total, currency)} ({currency})"
        for currency, total in totals.items()
        if total
    )
    if total_text:
        return f"Found {len(items)} {module_label.lower()}: {total_text}."
    return f"Found {len(items)} {module_label.lower()}."


def records_to_csv(rows: list[dict[str, Any]], columns: list[str] | None = None) -> str:
    if not rows:
        return ""
    headers = columns or [key for key in rows[0].keys() if not key.startswith("$")]
    handle = io.StringIO()
    writer = csv.DictWriter(handle, fieldnames=headers, extrasaction="ignore")
    writer.writeheader()
    writer.writerows(rows)
    return handle.getvalue()


def normalize_crm_module(raw: str) -> str:
    trimmed = (raw or "").strip()
    if not trimmed:
        return trimmed
    capitalized = trimmed[:1].upper() + trimmed[1:].lower()
    if capitalized in CRM_MODULES:
        return capitalized
    plural = capitalized if capitalized.endswith("s") else f"{capitalized}s"
    if plural in CRM_MODULES:
        return plural
    aliases = {
        "lead": "Leads",
        "contact": "Contacts",
        "account": "Accounts",
        "deal": "Deals",
        "task": "Tasks",
        "opportunity": "Deals",
        "company": "Accounts",
        "organisation": "Accounts",
        "organization": "Accounts",
        "prospect": "Leads",
        "customer": "Contacts",
    }
    return aliases.get(trimmed.lower(), trimmed)


def format_amount(value: float | int, currency: str = "INR") -> str:
    symbols = {"INR": "₹", "USD": "$", "EUR": "€", "GBP": "£"}
    symbol = symbols.get(currency.upper(), f"{currency.upper()} ")
    return f"{symbol}{float(value):,.2f}"


def format_date(value: str) -> str:
    parsed = _parse_date(value)
    if not parsed:
        return value
    return f"{parsed.strftime('%b')} {parsed.day}, {parsed.year}"


AMOUNT_FIELDS = {
    "amount",
    "balance",
    "total",
    "sub_total",
    "subtotal",
    "tax_total",
    "discount_total",
    "payment_made",
    "payment_received",
    "amount_due",
    "amount_applied",
    "bcy_total",
    "bcy_balance",
    "fc_total",
    "fc_balance",
    "outstanding",
    "totalOutstanding",
}
DATE_FIELDS = {
    "date",
    "due_date",
    "created_time",
    "last_modified_time",
    "invoice_date",
    "payment_date",
    "transaction_date",
}
CRM_DEFAULT_FIELDS = {
    "Leads": [
        "id",
        "First_Name",
        "Last_Name",
        "Email",
        "Company",
        "Phone",
        "Lead_Source",
        "Lead_Status",
        "Annual_Revenue",
        "City",
        "State",
        "Country",
        "Owner",
        "Created_Time",
        "Modified_Time",
    ],
    "Contacts": [
        "id",
        "First_Name",
        "Last_Name",
        "Full_Name",
        "Email",
        "Phone",
        "Account_Name",
        "Title",
        "Department",
        "Mailing_City",
        "Owner",
        "Created_Time",
        "Modified_Time",
    ],
    "Accounts": [
        "id",
        "Account_Name",
        "Website",
        "Phone",
        "Industry",
        "Annual_Revenue",
        "Account_Type",
        "Billing_City",
        "Billing_Country",
        "Owner",
        "Created_Time",
        "Modified_Time",
    ],
    "Deals": [
        "id",
        "Deal_Name",
        "Amount",
        "Stage",
        "Closing_Date",
        "Account_Name",
        "Contact_Name",
        "Probability",
        "Type",
        "Lead_Source",
        "Owner",
        "Created_Time",
        "Modified_Time",
    ],
    "Tasks": [
        "id",
        "Subject",
        "Due_Date",
        "Status",
        "Priority",
        "Who_Id",
        "What_Id",
        "Description",
        "Owner",
        "Created_Time",
        "Modified_Time",
    ],
}
CRM_SEARCH_FIELDS = {
    "Leads": ["Last_Name", "First_Name", "Email", "Company"],
    "Contacts": ["Last_Name", "First_Name", "Email", "Account_Name"],
    "Accounts": ["Account_Name", "Website"],
    "Deals": ["Deal_Name", "Account_Name"],
    "Tasks": ["Subject"],
}


def _normalize_books_module(raw: str) -> str:
    module = (raw or "").strip().lower()
    if module not in BOOKS_MODULES:
        raise ZohoClientError(f"Unsupported Zoho Books module: {raw}")
    return module


def _decode_json(response: httpx.Response) -> Any:
    if not response.content:
        return {}
    try:
        return response.json()
    except ValueError as exc:
        raise ZohoClientError("Zoho response was not valid JSON.") from exc


def _build_api_error(method: str, url: str, response: httpx.Response) -> ZohoAPIError:
    payload: Any = None
    try:
        payload = response.json()
    except ValueError:
        payload = response.text.strip()
    message = _extract_error_message(payload)
    retry_after = _parse_retry_after(response.headers.get("retry-after"))
    return ZohoAPIError(
        response.status_code,
        method,
        url,
        message,
        retry_after_seconds=retry_after,
        payload=payload,
    )


def _extract_error_message(payload: Any) -> str:
    if isinstance(payload, dict):
        code = payload.get("code")
        message = payload.get("message") or payload.get("error_description") or payload.get("error")
        if code and message:
            return f"{code}: {message}"
        if message:
            return str(message)
        if code:
            return str(code)
    text = str(payload).strip()
    return text[:500] if text else "unknown error"


def _should_retry(response: httpx.Response) -> bool:
    return response.status_code == 429 or 500 <= response.status_code < 600


def _should_refresh_token(error: Exception | None) -> bool:
    return isinstance(error, ZohoAPIError) and error.status_code == 401


def _retry_delay(response: httpx.Response | None, attempt: int) -> float:
    retry_after = _parse_retry_after(response.headers.get("retry-after")) if response else None
    if retry_after is not None:
        return retry_after
    return min(8.0, 0.5 * (2**attempt))


def _parse_retry_after(value: str | None) -> float | None:
    if not value:
        return None
    try:
        return max(0.0, float(value))
    except ValueError:
        return None


def _clean_params(params: dict[str, Any] | None) -> dict[str, str] | None:
    if not params:
        return None
    cleaned: dict[str, str] = {}
    for key, value in params.items():
        primitive = _to_primitive(value)
        if primitive is not None and primitive != "":
            cleaned[key] = primitive
    return cleaned


def _to_primitive(value: Any) -> str | None:
    if value is None:
        return None
    if isinstance(value, (str, int, float, bool)):
        return str(value)
    return None


def _books_has_more(raw: dict[str, Any]) -> bool:
    page_context = _as_record(raw.get("page_context"))
    return _as_bool(page_context.get("has_more_page")) or False


def _has_contact_name_filter(filters: dict[str, Any] | None) -> bool:
    filters = filters or {}
    return bool(_as_str(filters.get("contact_name")) or _as_str(filters.get("company_name")))


def _as_record(value: Any) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def _as_records(value: Any) -> list[dict[str, Any]]:
    if not isinstance(value, list):
        return []
    return [item for item in value if isinstance(item, dict)]


def _as_str(value: Any) -> str | None:
    return value if isinstance(value, str) else None


def _as_bool(value: Any) -> bool | None:
    return value if isinstance(value, bool) else None


def _as_number(value: Any) -> float | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return float(value)
    if isinstance(value, str):
        try:
            return float(value)
        except ValueError:
            return None
    return None


def _read_number(record: dict[str, Any], *keys: str) -> float:
    for key in keys:
        value = _as_number(record.get(key))
        if value is not None:
            return value
    return 0.0


def _record_id(item: dict[str, Any]) -> str:
    for key in (
        "invoice_id",
        "contact_id",
        "estimate_id",
        "creditnote_id",
        "bill_id",
        "salesorder_id",
        "purchaseorder_id",
        "payment_id",
        "transaction_id",
        "expense_id",
        "item_id",
        "account_id",
        "id",
    ):
        value = item.get(key)
        if isinstance(value, (str, int)):
            return str(value)
    return str(sorted(item.items()))


def _dedupe_records(items: list[dict[str, Any]]) -> list[dict[str, Any]]:
    seen: set[str] = set()
    output: list[dict[str, Any]] = []
    for item in items:
        key = _record_id(item)
        if key in seen:
            continue
        seen.add(key)
        output.append(item)
    return output


def _currency_from(record: dict[str, Any]) -> str:
    value = record.get("currency_code") or record.get("currencyCode") or record.get("currency")
    return value.strip() if isinstance(value, str) and value.strip() else "INR"


def _display_key(key: str) -> str:
    return f"{key}_formatted" if "_" in key else f"{key}Formatted"


def _parse_date(raw: str | None) -> datetime | None:
    if not raw:
        return None
    value = raw.strip()
    try:
        if value.endswith("Z"):
            value = value[:-1] + "+00:00"
        parsed = datetime.fromisoformat(value)
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=timezone.utc)
        return parsed
    except ValueError:
        return None


def _diff_days(as_of: datetime, due: datetime | None) -> int:
    if not due:
        return 0
    return int((as_of - due).total_seconds() // 86400)


def _date_in_range(
    value: datetime | None,
    start: datetime | None,
    end: datetime | None,
) -> bool:
    if value is None:
        return True
    if start and value < start:
        return False
    if end and value > end:
        return False
    return True


def _compact(mapping: dict[str, Any]) -> dict[str, Any]:
    return {key: value for key, value in mapping.items() if value is not None}


def _read_owner_name(record: dict[str, Any]) -> str:
    owner = record.get("Owner")
    if isinstance(owner, dict):
        return _as_str(owner.get("name")) or "Unknown"
    return "Unknown"


def _read_lookup_name(record: dict[str, Any], field: str) -> str:
    value = record.get(field)
    if isinstance(value, str):
        return value
    if isinstance(value, dict):
        return _as_str(value.get("name")) or ""
    return ""


def _is_iso_date(value: str) -> bool:
    if len(value) != 10:
        return False
    try:
        datetime.fromisoformat(value)
        return True
    except ValueError:
        return False


def _parse_quarter(value: str) -> dict[str, str] | None:
    parts = value.replace("-", " ").split()
    if len(parts) != 2:
        return None
    if parts[0].startswith("q") and parts[0][1:].isdigit() and parts[1].isdigit():
        quarter = int(parts[0][1:])
        year = int(parts[1])
    elif parts[0].isdigit() and parts[1].startswith("q") and parts[1][1:].isdigit():
        quarter = int(parts[1][1:])
        year = int(parts[0])
    else:
        return None
    if quarter < 1 or quarter > 4:
        return None
    start_month = (quarter - 1) * 3 + 1
    return {
        "from": _date_from_parts(year, start_month, 1),
        "to": _end_of_month(year, start_month + 2),
    }


def _date_from_parts(year: int, month: int, day: int) -> str:
    while month > 12:
        year += 1
        month -= 12
    while month <= 0:
        year -= 1
        month += 12
    base = datetime(year, month, 1, tzinfo=timezone.utc)
    return (base + timedelta(days=day - 1)).date().isoformat()


def _end_of_month(year: int, month: int) -> str:
    while month > 12:
        year += 1
        month -= 12
    while month <= 0:
        year -= 1
        month += 12
    return datetime(year, month, monthrange(year, month)[1], tzinfo=timezone.utc).date().isoformat()
