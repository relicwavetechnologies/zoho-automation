"""Hermetic fakes for RAG tests — no network, no credentials.

``FakeAsyncClient`` mimics the slice of ``httpx.AsyncClient`` the RAG modules use
(``request`` / ``post`` / ``aclose``), routing by (method, url-substring) to canned
responses and recording every call for assertions.
"""

from __future__ import annotations

import json as _json
from typing import Any, Callable, Optional


class FakeResponse:
    def __init__(self, status_code: int = 200, payload: Any = None, text: Optional[str] = None):
        self.status_code = status_code
        self._payload = payload if payload is not None else {}
        self.text = text if text is not None else _json.dumps(self._payload)

    def json(self) -> Any:
        if isinstance(self._payload, (dict, list)):
            return self._payload
        return _json.loads(self.text)


class FakeAsyncClient:
    """Routes by a matcher callable or a list of (method, needle, response) rules."""

    def __init__(
        self,
        *,
        routes: Optional[list[tuple[str, str, FakeResponse]]] = None,
        handler: Optional[Callable[[str, str, Optional[dict]], FakeResponse]] = None,
        default: Optional[FakeResponse] = None,
    ):
        self._routes = routes or []
        self._handler = handler
        self._default = default or FakeResponse(200, {})
        self.calls: list[dict] = []

    async def request(self, method: str, url: str, *, headers=None, json=None):  # noqa: A002
        self.calls.append({"method": method, "url": url, "headers": headers, "json": json})
        if self._handler is not None:
            return self._handler(method, url, json)
        for m, needle, resp in self._routes:
            if m == method and needle in url:
                return resp
        return self._default

    async def post(self, url: str, *, headers=None, json=None):  # noqa: A002
        return await self.request("POST", url, headers=headers, json=json)

    async def get(self, url: str, *, headers=None, json=None):  # noqa: A002
        return await self.request("GET", url, headers=headers, json=json)

    async def aclose(self) -> None:  # pragma: no cover - injected clients aren't closed
        pass
