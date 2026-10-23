"""Provider-independent email capture from normalized transcript events.

It never speaks or prompts: results tell the host agent what to say next.
"""

from __future__ import annotations

import asyncio
import json
import re
from dataclasses import dataclass
from typing import Any, Literal, Protocol

from .errors import ProviderError


@dataclass(frozen=True, slots=True)
class TranscriptEvent:
    """Normalized STT output. Only `final` events are acted on; partials are ignored."""

    event_id: str
    tenant_id: str
    session_id: str
    #: Stable id of the caller utterance; revisions of the same utterance share it.
    turn_id: str
    kind: Literal["partial", "final"]
    text: str
    #: Higher revision of the same turn supersedes lower ones.
    revision: int = 0
    #: 0..1 when the STT provider reports it, otherwise None. Never invented.
    confidence: float | None = None
    received_at_ms: float = 0


ClarifyReason = Literal[
    "incomplete_domain", "ambiguous_local_part", "missing_local_part", "invalid_format", "low_confidence"
]


@dataclass(frozen=True, slots=True)
class EmailFound:
    email: str
    literal: bool
    kind: Literal["email"] = "email"


@dataclass(frozen=True, slots=True)
class EmailClarify:
    reason: ClarifyReason
    heard: str
    kind: Literal["clarify"] = "clarify"


# ---------------------------------------------------------------------------------------------
# Extraction (pure; mirrored exactly in TypeScript)

_LITERAL = re.compile(r"[a-z0-9._%+-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}")
_CUE = re.compile(r"\b(?:e-?mail|mail|address)\b")
_PHRASES = (
    (re.compile(r"\bat the rate of\b"), " @ "),
    (re.compile(r"\bat the rate\b"), " @ "),
    (re.compile(r"\bat sign\b"), " @ "),
    (re.compile(r"\bat symbol\b"), " @ "),
    (re.compile(r"\bfull stop\b"), " . "),
    (re.compile(r"\bunder score\b"), " _ "),
    (re.compile(r"\b([a-z0-9]) as in [a-z]+\b"), r"\1"),
)
_WORDS = {
    "at": "@", "dot": ".", "period": ".", "point": ".", "underscore": "_", "hyphen": "-", "dash": "-",
    "plus": "+", "zero": "0", "one": "1", "two": "2", "three": "3", "four": "4", "five": "5", "six": "6",
    "seven": "7", "eight": "8", "nine": "9",
}
#: Words that end a spoken address on the left; anything else there makes the local part ambiguous.
_STOP = frozenset({
    "is", "it's", "its", "it", "email", "e-mail", "mail", "address", "my", "the", "to", "use", "send", "try",
    "reach", "contact", "be", "was", "id", "that's", "thats", "yes", "yeah", "sure", "ok", "okay", "so", "um",
    "uh", "and", "actually", "no", "correction", "here", "can", "you", "number", "mine", "under", "instead",
    "please", "write", "type", "i",
})
_SEPARATORS = frozenset({".", "_", "-", "+"})
_WORD = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")
_SINGLE = re.compile(r"^[a-z0-9]$")
_STRIP_CHARS = ",.!?;:\"'()"


def _tokenize(lower: str) -> list[str]:
    text = lower
    for pattern, replacement in _PHRASES:
        text = pattern.sub(replacement, text)
    tokens = (t if t == "@" else t.strip(_STRIP_CHARS) for t in text.split())
    return [_WORDS.get(t, t) for t in tokens if t]


def _at(tokens: list[str], i: int) -> str | None:
    return tokens[i] if 0 <= i < len(tokens) else None


def _is_word(t: str | None) -> bool:
    return t is not None and _WORD.match(t) is not None


def _is_single(t: str | None) -> bool:
    return t is not None and _SINGLE.match(t) is not None


def _from_at(tokens: list[str], at: int) -> EmailFound | EmailClarify:
    domain: list[str] = []
    j = at + 1
    if _is_word(_at(tokens, j)):
        domain.append(tokens[j])
        j += 1
        while _at(tokens, j) == "." and _is_word(_at(tokens, j + 1)):
            domain.append(tokens[j + 1])
            j += 2

    local: list[str] = []
    k = at - 1
    first = _at(tokens, k)
    if _is_word(first) and first not in _STOP:
        local.insert(0, tokens[k])
        k -= 1
        while k >= 0:
            t = tokens[k]
            if t in _SEPARATORS and _is_word(_at(tokens, k - 1)):
                local[0:0] = [tokens[k - 1], t]
                k -= 2
            elif _is_single(t) and _is_single(local[0]):
                local.insert(0, t)
                k -= 1
            else:
                break

    heard = "".join(local) + "@" + ".".join(domain)
    if not local:
        reason: ClarifyReason = "invalid_format" if (_at(tokens, at - 1) or "") in _SEPARATORS else "missing_local_part"
        return EmailClarify(reason, heard)
    if len(domain) < 2:
        return EmailClarify("incomplete_domain", heard)
    if not re.fullmatch(r"[a-z]{2,}", domain[-1]):
        return EmailClarify("invalid_format", heard)
    before = _at(tokens, k)
    if _is_word(before) and before not in _STOP:
        return EmailClarify("ambiguous_local_part", heard)
    return EmailFound(heard, literal=False)


def extract_email(text: str) -> EmailFound | EmailClarify | None:
    """Find an email address in one utterance. Never fills in missing characters."""
    lower = text.lower()
    literal = _LITERAL.search(lower)
    if literal:
        return EmailFound(literal.group(0), literal=True)
    tokens = _tokenize(lower)
    clarify: EmailClarify | None = None
    for i, token in enumerate(tokens):
        if token != "@":
            continue
        found = _from_at(tokens, i)
        if isinstance(found, EmailFound):
            return found
        clarify = clarify or found
    return clarify if _CUE.search(lower) else None


# ---------------------------------------------------------------------------------------------
# Session state and engine

EmailStatus = Literal["none", "asked", "declined", "candidate", "confirmed"]
#: Results are plain dicts in the schema's camelCase wire form, identical to the TypeScript package.
EmailCaptureResult = dict[str, Any]


def initial_state(tenant_id: str, session_id: str) -> dict[str, Any]:
    """JSON-serializable state, same shape as the TypeScript EmailState."""
    return {
        "tenantId": tenant_id,
        "sessionId": session_id,
        "status": "none",
        "email": None,
        "candidate": None,
        "candidateTurnId": None,
        "declinedDeferred": None,
        "turnRevisions": {},
        "processedEventIds": [],
    }


class EmailStateStore(Protocol):
    async def get(self, tenant_id: str, session_id: str) -> dict[str, Any] | None: ...
    async def set(self, state: dict[str, Any]) -> None: ...
    async def delete(self, tenant_id: str, session_id: str) -> None: ...


def _key(tenant_id: str, session_id: str) -> str:
    return json.dumps([tenant_id, session_id])


class InMemoryEmailStateStore:
    """Process-local store. Stores JSON copies so behaviour matches an external store."""

    def __init__(self) -> None:
        self._states: dict[str, str] = {}

    async def get(self, tenant_id: str, session_id: str) -> dict[str, Any] | None:
        raw = self._states.get(_key(tenant_id, session_id))
        return None if raw is None else dict(json.loads(raw))

    async def set(self, state: dict[str, Any]) -> None:
        self._states[_key(state["tenantId"], state["sessionId"])] = json.dumps(state)

    async def delete(self, tenant_id: str, session_id: str) -> None:
        self._states.pop(_key(tenant_id, session_id), None)


_REFUSAL = re.compile(
    r"\b(?:skip|rather not|prefer not|don't want|do not want|no thanks|no thank you|not now|later|"
    r"don't have|do not have|another time)\b"
)
_DEFERRAL = re.compile(r"\b(?:later|not now|another time)\b")
_CORRECTION = re.compile(r"\b(?:actually|correction|change it|change my email|update it|instead|that's wrong|wrong)\b")
_MAX_EVENT_IDS = 256
_MAX_TURNS = 64


class EmailCapture:
    def __init__(self, *, store: EmailStateStore | None = None, min_confidence: float = 0.5) -> None:
        self._store: EmailStateStore = store or InMemoryEmailStateStore()
        self._min_confidence = min_confidence
        self._locks: dict[str, asyncio.Lock] = {}

    async def get_state(self, tenant_id: str, session_id: str) -> dict[str, Any]:
        return await self._store.get(tenant_id, session_id) or initial_state(tenant_id, session_id)

    async def question_asked(self, tenant_id: str, session_id: str) -> list[EmailCaptureResult]:
        """Call when the agent asks for the email; enables refusal detection."""

        def mutate(state: dict[str, Any]) -> list[EmailCaptureResult]:
            if state["status"] in ("none", "declined"):
                state["status"] = "asked"
            return []

        return await self._update(tenant_id, session_id, mutate)

    async def confirm(self, tenant_id: str, session_id: str) -> list[EmailCaptureResult]:
        """Call after the caller confirms the read-back candidate."""

        def mutate(state: dict[str, Any]) -> list[EmailCaptureResult]:
            email = state["candidate"]
            if email is None:
                return []
            state.update(email=email, candidate=None, candidateTurnId=None, status="confirmed")
            return [{"type": "confirmed", "email": email}]

        return await self._update(tenant_id, session_id, mutate)

    async def reject(self, tenant_id: str, session_id: str) -> list[EmailCaptureResult]:
        """Call when the caller says the read-back candidate is wrong."""

        def mutate(state: dict[str, Any]) -> list[EmailCaptureResult]:
            state.update(candidate=None, candidateTurnId=None, status="asked" if state["email"] is None else "confirmed")
            return []

        return await self._update(tenant_id, session_id, mutate)

    async def handle(self, event: TranscriptEvent) -> list[EmailCaptureResult]:
        if not (event.event_id and event.tenant_id and event.session_id and event.turn_id):
            raise ProviderError(
                code="malformed_message",
                provider="email_capture",
                message="Transcript events need event_id, tenant_id, session_id and turn_id.",
            )
        if event.kind != "final":
            return []
        return await self._update(event.tenant_id, event.session_id, lambda state: self._apply(state, event))

    def _apply(self, state: dict[str, Any], event: TranscriptEvent) -> list[EmailCaptureResult]:
        if event.event_id in state["processedEventIds"]:
            return []
        state["processedEventIds"] = [*state["processedEventIds"], event.event_id][-_MAX_EVENT_IDS:]
        revisions: dict[str, int] = state["turnRevisions"]
        previous = revisions.get(event.turn_id)
        if previous is not None and event.revision <= previous:
            return []
        revisions.pop(event.turn_id, None)
        revisions[event.turn_id] = event.revision
        for old in list(revisions)[: max(0, len(revisions) - _MAX_TURNS)]:
            del revisions[old]

        lower = event.text.lower()
        found = extract_email(event.text)
        turn_id = event.turn_id
        if found is None:
            if state["status"] != "asked" or not _REFUSAL.search(lower):
                return []
            deferred = _DEFERRAL.search(lower) is not None
            state.update(status="declined", declinedDeferred=deferred)
            return [{"type": "declined", "deferred": deferred, "turnId": turn_id}]
        if isinstance(found, EmailClarify):
            return [{"type": "clarification_needed", "reason": found.reason, "heard": found.heard, "turnId": turn_id}]
        if event.confidence is not None and event.confidence < self._min_confidence:
            return [{"type": "clarification_needed", "reason": "low_confidence", "heard": found.email, "turnId": turn_id}]
        if found.email == state["candidate"] or (found.email == state["email"] and state["candidate"] is None):
            return []
        revises_candidate_turn = state["candidateTurnId"] == turn_id
        if state["email"] is not None and not _CORRECTION.search(lower) and not revises_candidate_turn:
            return [{"type": "kept_confirmed", "email": state["email"], "heard": found.email, "turnId": turn_id}]
        state.update(status="candidate", candidate=found.email, candidateTurnId=turn_id)
        return [{
            "type": "candidate",
            "email": found.email,
            "literal": found.literal,
            "turnId": turn_id,
            "replacesConfirmed": state["email"] is not None,
        }]

    async def _update(self, tenant_id: str, session_id: str, mutate: Any) -> list[EmailCaptureResult]:
        """Serialize read-modify-write per tenant/session so concurrent events cannot interleave."""
        key = _key(tenant_id, session_id)
        lock = self._locks.setdefault(key, asyncio.Lock())
        try:
            async with lock:
                state = await self.get_state(tenant_id, session_id)
                results: list[EmailCaptureResult] = mutate(state)
                await self._store.set(state)
                return results
        finally:
            if not lock.locked() and self._locks.get(key) is lock:
                del self._locks[key]
