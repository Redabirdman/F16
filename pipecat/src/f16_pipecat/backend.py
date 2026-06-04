"""Thin async client for the F16 backend's voice turn endpoint.

Pipecat is a dumb I/O bridge: STT transcript in, TTS reply text out. ALL
business logic, prompts, and conversation state live in the F16 backend's
shared Sales Agent. This module is the single HTTP seam between the two.

Contract (FROZEN by the backend, built in parallel for M10):

    POST {F16_BACKEND_BASE_URL}/v1/voice/turn
    headers: x-f16-signature: HMAC-SHA256(F16_WEBHOOK_SECRET, raw_body) hex
             content-type: application/json
    body:    {sessionId, leadId, customerId, transcript}
    → 200    {replyText, sessionState in {"live","ended","escalated"}}

The backend authenticates exactly like its /v1/leads webhook: an HMAC-SHA256
signature over the RAW request body, constant-time compared. So we sign the
exact bytes we POST (`content=`, not `json=`) and send the hex digest in
`x-f16-signature`. F16_WEBHOOK_SECRET MUST equal the backend's
HMAC_WEBHOOK_SECRET.

The client is constructed from env but accepts an injectable `httpx.AsyncClient`
so tests can mock the transport with `httpx.MockTransport` (no live network).
"""

from __future__ import annotations

import hashlib
import hmac
import json
import os
from dataclasses import dataclass

import httpx
from pydantic import BaseModel, Field

from f16_pipecat.logging import logger

# The backend voice endpoint authenticates each POST with an HMAC-SHA256
# signature over the RAW request body, sent in the `x-f16-signature` header
# (the SAME scheme as the /v1/leads webhook). We sign with F16_WEBHOOK_SECRET,
# which MUST equal the backend's HMAC_WEBHOOK_SECRET. The header name is
# env-overridable for ops flexibility.
_DEFAULT_SIG_HEADER = "x-f16-signature"
_DEFAULT_BASE_URL = "http://backend:3001"
_TURN_PATH = "/v1/voice/turn"
_SESSION_PATH = "/v1/voice/session"
_DEFAULT_TIMEOUT_S = 10.0
# Header carrying the shared-secret that authenticates the session-lookup GET.
_SESSION_SECRET_HEADER = "x-f16-internal-secret"


class BackendTurnResult(BaseModel):
    """Parsed `/v1/voice/turn` response."""

    reply_text: str = Field(description="French text TTS should speak back.")
    session_state: str = Field(description="live | ended | escalated.")


class BackendSession(BaseModel):
    """Parsed `/v1/voice/session/{id}` response — the call's F16 identity."""

    lead_id: str = Field(description="F16 lead id this voice session belongs to.")
    customer_id: str = Field(description="F16 customer id matched on phone.")


@dataclass(slots=True)
class BackendConfig:
    """Resolved connection settings for the F16 backend voice endpoint."""

    base_url: str
    secret: str
    sig_header: str
    session_secret: str = ""
    timeout_s: float = _DEFAULT_TIMEOUT_S

    @classmethod
    def from_env(cls) -> BackendConfig:
        """Build config from the process environment.

        Env keys (see .env.template):
          F16_BACKEND_BASE_URL  — backend origin (no trailing /v1/voice/turn)
          F16_WEBHOOK_SECRET    — HMAC secret (must equal backend HMAC_WEBHOOK_SECRET)
          F16_WEBHOOK_SECRET_HEADER — optional signature header-name override
          F16_SESSION_LOOKUP_SECRET — shared secret for GET /v1/voice/session/{id}
        """
        return cls(
            base_url=os.environ.get("F16_BACKEND_BASE_URL", _DEFAULT_BASE_URL).rstrip("/"),
            secret=os.environ.get("F16_WEBHOOK_SECRET", ""),
            sig_header=os.environ.get("F16_WEBHOOK_SECRET_HEADER", _DEFAULT_SIG_HEADER),
            session_secret=os.environ.get("F16_SESSION_LOOKUP_SECRET", ""),
        )


class BackendTurnError(RuntimeError):
    """Raised when the backend turn call fails (non-2xx or malformed body)."""


class BackendSessionError(RuntimeError):
    """Raised when the session lookup fails (non-2xx, malformed, or unreachable)."""


class F16BackendClient:
    """Async HTTP client for the backend voice brain.

    The underlying `httpx.AsyncClient` is injectable for tests. In production
    `from_env()` builds a real client; tests pass one wired to a
    `httpx.MockTransport` so no socket is ever opened.
    """

    def __init__(self, config: BackendConfig, http: httpx.AsyncClient) -> None:
        self._config = config
        self._http = http

    @classmethod
    def from_env(cls) -> F16BackendClient:
        config = BackendConfig.from_env()
        http = httpx.AsyncClient(timeout=config.timeout_s)
        return cls(config=config, http=http)

    async def aclose(self) -> None:
        await self._http.aclose()

    async def turn(
        self,
        *,
        session_id: str,
        lead_id: str,
        customer_id: str,
        transcript: str,
    ) -> BackendTurnResult:
        """POST one utterance to the backend and return its reply.

        Raises `BackendTurnError` on transport failure, non-2xx, or a body
        that does not match the frozen contract.
        """
        url = f"{self._config.base_url}{_TURN_PATH}"
        payload = {
            "sessionId": session_id,
            "leadId": lead_id,
            "customerId": customer_id,
            "transcript": transcript,
        }
        # Sign the EXACT bytes we POST (content=, not json=) so the backend's
        # HMAC over its raw body matches ours. Compact separators keep it stable.
        body_bytes = json.dumps(payload, separators=(",", ":")).encode("utf-8")
        signature = hmac.new(
            self._config.secret.encode("utf-8"), body_bytes, hashlib.sha256
        ).hexdigest()
        headers = {
            "content-type": "application/json",
            self._config.sig_header: signature,
        }
        try:
            resp = await self._http.post(url, content=body_bytes, headers=headers)
        except httpx.HTTPError as exc:  # connect/read/timeout
            logger.error(f"voice: backend turn transport error session={session_id}: {exc}")
            raise BackendTurnError(f"backend_unreachable: {exc}") from exc

        if resp.status_code >= 400:
            logger.error(
                f"voice: backend turn http {resp.status_code} session={session_id} "
                f"body={resp.text[:200]}"
            )
            raise BackendTurnError(f"backend_status_{resp.status_code}")

        try:
            data = resp.json()
            reply_text = str(data["replyText"])
            session_state = str(data["sessionState"])
        except (ValueError, KeyError, TypeError) as exc:
            logger.error(f"voice: backend turn malformed body session={session_id}: {exc}")
            raise BackendTurnError("backend_malformed_response") from exc

        return BackendTurnResult(reply_text=reply_text, session_state=session_state)

    async def get_session(self, session_id: str) -> BackendSession:
        """Look up a voice session's F16 identity (leadId + customerId).

        Asterisk's AudioSocket leg carries only the call UUID (== sessionId); the
        backend created the session at call-setup time and holds the lead/customer
        mapping. We GET it here so the runner can stamp each `/v1/voice/turn`.

        Authenticated with a shared secret in `x-f16-internal-secret` (NOT the
        HMAC scheme — this is a GET with no body to sign). Raises
        `BackendSessionError` on transport failure, non-2xx, or a body that does
        not match the contract.
        """
        url = f"{self._config.base_url}{_SESSION_PATH}/{session_id}"
        headers = {_SESSION_SECRET_HEADER: self._config.session_secret}
        try:
            resp = await self._http.get(url, headers=headers)
        except httpx.HTTPError as exc:
            logger.error(f"voice: session lookup transport error session={session_id}: {exc}")
            raise BackendSessionError(f"backend_unreachable: {exc}") from exc

        if resp.status_code >= 400:
            logger.error(
                f"voice: session lookup http {resp.status_code} session={session_id} "
                f"body={resp.text[:200]}"
            )
            raise BackendSessionError(f"backend_status_{resp.status_code}")

        try:
            data = resp.json()
            lead_id = str(data["leadId"])
            customer_id = str(data["customerId"])
        except (ValueError, KeyError, TypeError) as exc:
            logger.error(f"voice: session lookup malformed body session={session_id}: {exc}")
            raise BackendSessionError("backend_malformed_response") from exc

        return BackendSession(lead_id=lead_id, customer_id=customer_id)


__all__ = [
    "BackendConfig",
    "BackendSession",
    "BackendSessionError",
    "BackendTurnError",
    "BackendTurnResult",
    "F16BackendClient",
]
