from __future__ import annotations

import base64
import builtins
import json
import re
from collections.abc import Mapping
from typing import Any

from .errors import ProviderError

JsonObject = dict[str, Any]

_BASE64 = re.compile(r"^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$")
_DIGITS = re.compile(r"^[0-9]+$")
DTMF_DIGIT = re.compile(r"^[0-9*#A-Da-d]$")


def get_header(headers: Mapping[str, str | None], name: str) -> str | None:
    """Case-insensitive header lookup."""
    wanted = name.lower()
    for key, value in headers.items():
        if key.lower() == wanted:
            return value
    return None


class MessageReader:
    """Typed field access for provider JSON. Every failure is a malformed_message naming the field."""

    def __init__(self, provider: str) -> None:
        self.provider = provider

    def fail(self, message: str) -> ProviderError:
        return ProviderError(code="malformed_message", provider=self.provider, message=message)

    def json(self, message: str | bytes, event_field: str = "event") -> JsonObject:
        if isinstance(message, bytes):
            try:
                text = message.decode("utf-8")
            except UnicodeDecodeError:
                raise self.fail("Message is not valid UTF-8.") from None
        else:
            text = message
        try:
            parsed = json.loads(text)
        except ValueError:
            raise self.fail("Message is not valid JSON.") from None
        if not isinstance(parsed, dict):
            raise self.fail("Message is not a JSON object.")
        if not isinstance(parsed.get(event_field), str):
            raise self.fail(f'Message has no string "{event_field}" field.')
        return parsed

    def object(self, o: JsonObject, key: str, path: str | None = None) -> JsonObject:
        value = o.get(key)
        if not isinstance(value, dict):
            raise self.fail(f"{path or key} must be an object.")
        return value

    def string(self, o: JsonObject, key: str, path: str | None = None) -> str:
        value = o.get(key)
        if not isinstance(value, str):
            raise self.fail(f"{path or key} must be a string.")
        return value

    def id(self, o: JsonObject, key: str, path: str | None = None) -> str:
        value = self.string(o, key, path)
        if not value:
            raise self.fail(f"{path or key} must not be empty.")
        return value

    def optional_string(self, o: JsonObject, key: str, path: str | None = None) -> str | None:
        return None if o.get(key) is None else self.string(o, key, path)

    def int(self, o: JsonObject, key: str, path: str | None = None) -> builtins.int:
        """Non-negative integer, given as a JSON number or a decimal string (Twilio sends strings)."""
        value = o.get(key)
        if isinstance(value, bool):
            pass
        elif isinstance(value, builtins.int) and 0 <= value <= 2**53 - 1:
            return value
        elif isinstance(value, float) and value.is_integer() and 0 <= value <= 2**53 - 1:
            return builtins.int(value)
        elif isinstance(value, str) and _DIGITS.match(value) and builtins.int(value) <= 2**53 - 1:
            return builtins.int(value)
        raise self.fail(f"{path or key} must be a non-negative integer.")

    def optional_int(self, o: JsonObject, key: str, path: str | None = None) -> builtins.int | None:
        return None if o.get(key) is None else self.int(o, key, path)

    def string_list(self, o: JsonObject, key: str, path: str | None = None) -> list[str]:
        value = o.get(key)
        if not isinstance(value, list) or not all(isinstance(v, str) for v in value):
            raise self.fail(f"{path or key} must be an array of strings.")
        return value

    def base64(self, o: JsonObject, key: str, path: str | None = None) -> bytes:
        value = self.string(o, key, path)
        if not _BASE64.match(value):
            raise self.fail(f"{path or key} is not valid base64.")
        return base64.b64decode(value)
