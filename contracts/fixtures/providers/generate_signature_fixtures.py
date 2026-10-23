"""Generate webhook-signature fixtures using the official Twilio and Plivo Python SDKs as the reference.

Run from the repository root:
    uv run --no-project --python 3.13 --with twilio --with plivo python -I contracts/fixtures/providers/generate_signature_fixtures.py

Tokens are fake. The toolkit packages are not imported, so the fixtures are an independent check.
"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
from urllib.parse import parse_qs

from plivo.utils.signature_v3 import get_signature_v3, construct_get_url, construct_post_url
from twilio.request_validator import RequestValidator

HERE = Path(__file__).resolve().parent
FORM = "application/x-www-form-urlencoded"


class MultiDict(dict[str, list[str]]):
    def getlist(self, key: str) -> list[str]:
        return self[key]


def form(body: str) -> MultiDict:
    return MultiDict(parse_qs(body, keep_blank_values=True))


def twilio_cases() -> list[dict[str, object]]:
    token = "twilio-test-token-not-real"
    v = RequestValidator(token)
    cases: list[dict[str, object]] = []

    def add(name: str, method: str, url: str, body: str, content_type: str | None, sig: str, header: str) -> None:
        headers = {header: sig}
        if content_type:
            headers["content-type"] = content_type
        params: object = form(body) if content_type == FORM else (body if "bodySHA256=" in url else {})
        valid = v.validate(url, params, sig)
        cases.append({
            "name": name,
            "authToken": token,
            "request": {"method": method, "url": url, "headers": headers, "rawBody": body},
            "valid": valid,
        })

    url = "https://example.com/voice?tenant=a%20b"
    body = "CallSid=CA00000000000000000000000000000001&From=%2B15551234567&To=%2B15557654321&CallStatus=ringing"
    sig = v.compute_signature(url, form(body))
    add("form post", "POST", url, body, FORM, sig, "X-Twilio-Signature")
    add("form post, request url carries default port", "POST", "https://example.com:443/voice?tenant=a%20b", body, FORM, sig, "X-Twilio-Signature")
    add("form post, tampered body", "POST", url, body.replace("ringing", "completed"), FORM, sig, "X-Twilio-Signature")
    add("form post, wrong token", "POST", url, body, FORM, RequestValidator("other").compute_signature(url, form(body)), "X-Twilio-Signature")

    repeated = "B=x&A=2&A=1&A=2&Empty="
    add("repeated and blank params", "POST", url, repeated, FORM, v.compute_signature(url, form(repeated)), "X-Twilio-Signature")

    json_body = '{"CallSid":"CA00000000000000000000000000000001","CallStatus":"completed"}'
    json_url = "https://example.com/events?bodySHA256=" + hashlib.sha256(json_body.encode()).hexdigest()
    json_sig = v.compute_signature(json_url, {})
    add("json body with bodySHA256", "POST", json_url, json_body, "application/json", json_sig, "X-Twilio-Signature")
    add("json body tampered", "POST", json_url, json_body.replace("completed", "busy"), "application/json", json_sig, "X-Twilio-Signature")

    ws_url = "wss://example.com/media?callId=abc"
    add("media stream websocket handshake", "GET", ws_url, "", None, v.compute_signature(ws_url, {}), "x-twilio-signature")
    add("media stream handshake, missing signature", "GET", ws_url, "", None, "", "x-twilio-signature")
    return cases


def plivo_cases() -> list[dict[str, object]]:
    token = "plivo-test-token-not-real"
    nonce = "05429567804466091622"
    cases: list[dict[str, object]] = []

    def sign(method: str, url: str, body: str, auth: str = token) -> str:
        params = {k: v for k, v in parse_qs(body, keep_blank_values=True).items()}
        base = construct_get_url(url, params) if method == "GET" else construct_post_url(url, params)
        return get_signature_v3(auth.encode(), base.decode(), nonce.encode()).decode()

    def add(name: str, method: str, url: str, body: str, sig: str, valid: bool) -> None:
        headers = {"X-Plivo-Signature-V3": sig, "X-Plivo-Signature-V3-Nonce": nonce}
        if method == "POST":
            headers["content-type"] = FORM
        cases.append({
            "name": name,
            "authToken": token,
            "request": {"method": method, "url": url, "headers": headers, "rawBody": body},
            "valid": valid,
        })

    body = "CallUUID=11111111-2222-3333-4444-555555555555&From=15551234567&To=15557654321&Event=StartApp"
    url = "https://example.com/answer?b=2&a=1"
    sig = sign("POST", url, body)
    add("post with query and form params", "POST", url, body, sig, True)
    add("post without query", "POST", "https://example.com/answer", body, sign("POST", "https://example.com/answer", body), True)
    add("post with query, empty body", "POST", url, "", sign("POST", url, ""), True)
    add("get with query", "GET", "https://example.com/hangup?CallUUID=abc&Duration=12", "", sign("GET", "https://example.com/hangup?CallUUID=abc&Duration=12", ""), True)
    add("one of several signatures matches", "POST", url, body, "bm90LWEtc2lnbmF0dXJl," + sig, True)
    add("tampered body", "POST", url, body.replace("StartApp", "Hangup"), sig, False)
    add("wrong token", "POST", url, body, sign("POST", url, body, "other"), False)
    return cases


def write(provider: str, cases: list[dict[str, object]], source: str) -> None:
    doc = {
        "description": f"{provider} webhook signature cases. `valid` and every signature were produced by {source}.",
        "cases": cases,
    }
    (HERE / provider / "signatures.json").write_text(json.dumps(doc, indent=2) + "\n")


if __name__ == "__main__":
    write("twilio", twilio_cases(), "twilio.request_validator.RequestValidator (official twilio-python SDK)")
    write("plivo", plivo_cases(), "plivo.utils.signature_v3 (official plivo-python SDK)")
