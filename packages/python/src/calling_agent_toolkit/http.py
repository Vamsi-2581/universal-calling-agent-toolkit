"""Minimal injectable HTTP layer for provider REST APIs. Tests pass a mock; production uses urllib (no deps)."""

from __future__ import annotations

import asyncio
import base64
import json
import urllib.error
import urllib.request
from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass, field
from typing import Any, Literal

from .errors import ProviderError, ProviderErrorCode


@dataclass(frozen=True)
class HttpRequest:
    method: Literal["GET", "POST", "DELETE"]
    url: str
    headers: Mapping[str, str] = field(default_factory=dict)
    body: str | None = None


@dataclass(frozen=True)
class HttpResponse:
    status: int
    body: str


HttpClient = Callable[[HttpRequest], Awaitable[HttpResponse]]


async def urllib_http_client(request: HttpRequest, timeout_s: float = 10.0) -> HttpResponse:
    """Default client: stdlib urllib in a worker thread."""

    def send() -> HttpResponse:
        req = urllib.request.Request(
            request.url,
            data=None if request.body is None else request.body.encode(),
            headers=dict(request.headers),
            method=request.method,
        )
        try:
            with urllib.request.urlopen(req, timeout=timeout_s) as res:  # noqa: S310 - provider HTTPS endpoints only
                return HttpResponse(res.status, res.read().decode())
        except urllib.error.HTTPError as err:
            return HttpResponse(err.code, err.read().decode(errors="replace"))

    return await asyncio.to_thread(send)


def basic_auth(user: str, secret: str) -> str:
    return "Basic " + base64.b64encode(f"{user}:{secret}".encode()).decode()


def _code_for_status(status: int) -> ProviderErrorCode:
    if status in (401, 403):
        return "authentication_failed"
    if status == 429:
        return "rate_limited"
    if status >= 500:
        return "provider_unavailable"
    if status in (400, 404, 422):
        return "invalid_configuration"
    return "unknown"


def error_from_response(provider: str, res: HttpResponse) -> ProviderError:
    """Map an HTTP error response to a ProviderError. Only the provider's own message is kept, truncated."""
    try:
        parsed = json.loads(res.body)
    except ValueError:
        parsed = None
    obj: dict[str, Any] = parsed if isinstance(parsed, dict) else {}
    raw_code = obj.get("code")
    detail = obj.get("message") if isinstance(obj.get("message"), str) else obj.get("error") if isinstance(obj.get("error"), str) else ""
    return ProviderError(
        code=_code_for_status(res.status),
        provider=provider,
        message=f"{provider} API returned HTTP {res.status}" + (f": {str(detail)[:200]}" if detail else ""),
        provider_code=str(raw_code) if isinstance(raw_code, (int, str)) and not isinstance(raw_code, bool) else None,
    )


async def call_api(provider: str, client: HttpClient, request: HttpRequest, *, timeout_s: float = 10.0) -> HttpResponse:
    """Send a request with a timeout; non-2xx responses become typed ProviderErrors."""
    try:
        res = await asyncio.wait_for(client(request), timeout=timeout_s)
    except ProviderError:
        raise
    except asyncio.TimeoutError as err:
        raise ProviderError(code="timeout", provider=provider, message=f"{provider} API did not respond in time.") from err
    except (OSError, urllib.error.URLError) as err:
        raise ProviderError(code="provider_unavailable", provider=provider, message=f"{provider} API request failed.") from err
    if not 200 <= res.status < 300:
        raise error_from_response(provider, res)
    return res


def json_body(provider: str, res: HttpResponse) -> dict[str, Any]:
    try:
        parsed = json.loads(res.body)
    except ValueError:
        parsed = None
    if not isinstance(parsed, dict):
        raise ProviderError(code="protocol_violation", provider=provider, message=f"{provider} API returned an unexpected response body.")
    return parsed
