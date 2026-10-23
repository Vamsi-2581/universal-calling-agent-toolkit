# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Vasik Mansuri
from __future__ import annotations

import asyncio
import dataclasses
import json
from pathlib import Path
from typing import Any

import pytest

from calling_agent_toolkit import (
    AudioFormat,
    MediaStreamRequest,
    OutboundCallRequest,
    ProviderError,
    TransferTarget,
    WebhookRequest,
)
from calling_agent_toolkit.http import HttpRequest, HttpResponse, basic_auth, call_api
from calling_agent_toolkit.media_session import event_to_wire
from calling_agent_toolkit.providers.plivo import PlivoCallControl
from calling_agent_toolkit.providers.twilio import TwilioCallControl

CONTRACTS = Path(__file__).resolve().parents[3] / "contracts"


def load(path: str) -> Any:
    return json.loads((CONTRACTS / path).read_text())


def secret(value: str) -> Any:
    async def resolve() -> str:
        return value

    return resolve


def make_adapter(provider: str, config: dict[str, Any], http: Any) -> Any:
    if provider == "twilio":
        return TwilioCallControl(account_sid=config["accountSid"], auth_token=secret(config["authToken"]), http=http, now=lambda: 1000)
    return PlivoCallControl(auth_id=config["authId"], auth_token=secret(config["authToken"]), http=http, now=lambda: 1000)


async def run(adapter: Any, op: str, args: dict[str, Any]) -> Any:
    if op == "startOutboundCall":
        s = await adapter.start_outbound_call(OutboundCallRequest(args["to"], args["from"], args["answer"]))
        return {"callId": s.call_id, "provider": s.provider, "direction": s.direction, "status": s.status, "from": s.from_, "to": s.to}
    if op == "endCall":
        return await adapter.end_call(args["callId"])
    if op == "transferCall":
        return await adapter.transfer_call(args["callId"], TransferTarget(args["target"]["to"]))
    if op == "sendDtmf":
        return await adapter.send_dtmf(args["callId"], args["digits"])
    if op == "startMediaStream":
        r = args["request"]
        f = r.get("format")
        req = MediaStreamRequest(
            url=r["url"],
            tracks=r["tracks"],
            bidirectional=r["bidirectional"],
            format=None if f is None else AudioFormat(f["encoding"], f["sampleRate"], f["channels"]),
            provider_options=r.get("providerOptions", {}),
        )
        h = await adapter.start_media_stream(args["callId"], req)
        return {"callId": h.call_id, "streamId": h.stream_id}
    if op == "stopMediaStream":
        return await adapter.stop_media_stream(args["callId"], args["streamId"])
    if op == "parseWebhook":
        events = await adapter.parse_webhook(WebhookRequest("POST", "https://example.com/cb", {}, args["rawBody"]))
        return [event_to_wire(e) for e in events]
    raise AssertionError(f"unknown op {op}")


CASES = [(p, load(f"fixtures/providers/{p}/rest.json")) for p in ("twilio", "plivo")]
PARAMS = [(p, fixture["config"], case) for p, fixture in CASES for case in fixture["cases"]]


@pytest.mark.parametrize(("provider", "config", "case"), PARAMS, ids=lambda v: v["name"] if isinstance(v, dict) and "name" in v else str(v)[:10])
async def test_rest_fixtures(provider: str, config: dict[str, Any], case: dict[str, Any]) -> None:
    sent: list[HttpRequest] = []

    async def http(req: HttpRequest) -> HttpResponse:
        sent.append(req)
        r = case["response"]
        return HttpResponse(r["status"], r["body"])

    adapter = make_adapter(provider, config, http)
    error: ProviderError | None = None
    value: Any = None
    try:
        value = await run(adapter, case["op"], case["args"])
    except ProviderError as err:
        error = err

    expect_request = case["expectRequest"]
    if expect_request is None:
        assert sent == []
    else:
        assert len(sent) == 1
        req = sent[0]
        user = config.get("accountSid") or config["authId"]
        assert (req.method, req.url) == (expect_request["method"], expect_request["url"])
        assert req.headers["Authorization"] == basic_auth(user, config["authToken"])
        assert req.headers.get("Content-Type") == expect_request["contentType"]
        body = expect_request["body"]
        if body is None:
            assert req.body is None
        elif isinstance(body, str):
            assert req.body == body
        else:
            assert req.body is not None and json.loads(req.body) == body

    if "expectError" in case:
        assert error is not None, value
        assert error.code == case["expectError"], error.message
        if "expectProviderCode" in case:
            assert error.provider_code == case["expectProviderCode"]
        if "expectRetryable" in case:
            assert error.retryable is case["expectRetryable"]
    else:
        assert error is None, error
        assert value == case["expect"]


async def test_call_api_timeout() -> None:
    async def slow(req: HttpRequest) -> HttpResponse:
        await asyncio.sleep(1)
        return HttpResponse(200, "")

    with pytest.raises(ProviderError) as info:
        await call_api("p", slow, HttpRequest("GET", "https://x"), timeout_s=0.01)
    assert (info.value.code, info.value.retryable) == ("timeout", True)


async def test_call_api_network_failure() -> None:
    async def down(req: HttpRequest) -> HttpResponse:
        raise OSError("connection refused")

    with pytest.raises(ProviderError) as info:
        await call_api("p", down, HttpRequest("GET", "https://x"))
    assert info.value.code == "provider_unavailable"


async def test_token_only_in_authorization_header() -> None:
    sent: list[HttpRequest] = []

    async def http(req: HttpRequest) -> HttpResponse:
        sent.append(req)
        return HttpResponse(200, "{}")

    await TwilioCallControl(account_sid="AC1", auth_token=secret("super-secret-token"), http=http).end_call("CA1")
    headers = dict(sent[0].headers)
    auth = headers.pop("Authorization")
    assert "super-secret-token" not in repr(dataclasses.replace(sent[0], headers=headers))
    assert auth == basic_auth("AC1", "super-secret-token")
