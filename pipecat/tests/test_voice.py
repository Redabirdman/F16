"""Tests for the V0 voice bridge surface (option F scaffold).

No real SIP/Deepgram/Azure — these exercise the FastAPI contract only.
The actual Pipecat pipeline + provider integrations land in M10.
"""

from __future__ import annotations

from collections.abc import Iterator

import httpx
import pytest
from fastapi.testclient import TestClient

from f16_pipecat.backend import BackendConfig, F16BackendClient
from f16_pipecat.server import app
from f16_pipecat.voice import _reset_sessions_for_tests, get_backend_client


@pytest.fixture(autouse=True)
def _flush_sessions() -> None:
    """Each test starts with an empty in-memory session store."""
    _reset_sessions_for_tests()


def _client() -> TestClient:
    return TestClient(app)


def _mock_backend_client(handler: httpx.MockTransport) -> F16BackendClient:
    """Build a backend client whose transport is a MockTransport — no socket."""
    http = httpx.AsyncClient(transport=handler)
    config = BackendConfig(
        base_url="http://backend:3001",
        secret="test-secret",
        sig_header="x-f16-signature",
    )
    return F16BackendClient(config=config, http=http)


@pytest.fixture
def captured() -> Iterator[dict[str, object]]:
    """Override the backend dependency with a mocked-transport client and
    capture the outbound request so tests can assert the bridge call shape.
    """
    record: dict[str, object] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        import json

        record["url"] = str(request.url)
        record["method"] = request.method
        record["signature"] = request.headers.get("x-f16-signature")
        record["raw"] = bytes(request.content)
        record["body"] = json.loads(request.content)
        return httpx.Response(
            200,
            json={"replyText": "Bonjour, je vous écoute.", "sessionState": "live"},
        )

    client = _mock_backend_client(httpx.MockTransport(handler))
    app.dependency_overrides[get_backend_client] = lambda: client
    yield record
    app.dependency_overrides.pop(get_backend_client, None)


def test_start_inbound_call_returns_session_id() -> None:
    client = _client()
    res = client.post(
        "/voice/sessions/new",
        json={
            "direction": "inbound",
            "lead_id": "11111111-1111-4111-8111-111111111111",
            "customer_id": "22222222-2222-4222-8222-222222222222",
            "phone": "+33612345678",
        },
    )
    assert res.status_code == 201
    body = res.json()
    assert body["status"] == "ringing"
    assert isinstance(body["session_id"], str)
    assert len(body["session_id"]) >= 32  # UUID-ish


def test_start_outbound_call_also_accepted() -> None:
    client = _client()
    res = client.post(
        "/voice/sessions/new",
        json={
            "direction": "outbound",
            "lead_id": "11111111-1111-4111-8111-111111111111",
            "customer_id": "22222222-2222-4222-8222-222222222222",
            "phone": "+33612345678",
        },
    )
    assert res.status_code == 201
    assert res.json()["status"] == "ringing"


def test_start_call_rejects_unknown_direction() -> None:
    client = _client()
    res = client.post(
        "/voice/sessions/new",
        json={
            "direction": "sideways",
            "lead_id": "11111111-1111-4111-8111-111111111111",
            "customer_id": "22222222-2222-4222-8222-222222222222",
            "phone": "+33612345678",
        },
    )
    # pydantic validation → 422.
    assert res.status_code == 422


def test_voice_turn_relays_to_backend(captured: dict[str, object]) -> None:
    """/voice/turn now POSTs to the backend brain and returns ITS reply
    (the V0 echo is gone). The mocked transport captures the call shape."""
    client = _client()
    start = client.post(
        "/voice/sessions/new",
        json={
            "direction": "inbound",
            "lead_id": "11111111-1111-4111-8111-111111111111",
            "customer_id": "22222222-2222-4222-8222-222222222222",
            "phone": "+33612345678",
        },
    )
    sid = start.json()["session_id"]
    res = client.post(
        "/voice/turn",
        json={"session_id": sid, "transcript": "Bonjour, je voudrais un devis trottinette."},
    )
    assert res.status_code == 200
    body = res.json()
    # Reply is the backend's, NOT an echo of the transcript.
    assert body["reply_text"] == "Bonjour, je vous écoute."
    assert "devis trottinette" not in body["reply_text"]
    assert body["session_state"] == "live"

    # The bridge hit the frozen backend contract with the session's ids.
    assert captured["url"] == "http://backend:3001/v1/voice/turn"
    assert captured["method"] == "POST"
    # The bridge HMAC-SHA256-signs the raw body with the shared secret and sends
    # it in x-f16-signature (same scheme as the backend's /v1/leads webhook).
    import hashlib
    import hmac

    raw = captured["raw"]
    assert isinstance(raw, bytes)
    expected_sig = hmac.new(b"test-secret", raw, hashlib.sha256).hexdigest()
    assert captured["signature"] == expected_sig
    sent = captured["body"]
    assert isinstance(sent, dict)
    assert sent["sessionId"] == sid
    assert sent["leadId"] == "11111111-1111-4111-8111-111111111111"
    assert sent["customerId"] == "22222222-2222-4222-8222-222222222222"
    assert sent["transcript"] == "Bonjour, je voudrais un devis trottinette."


def test_voice_turn_502_when_backend_errors() -> None:
    """A backend non-2xx surfaces as 502 — the bridge never invents a reply."""

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(500, json={"error": "boom"})

    client_obj = _mock_backend_client(httpx.MockTransport(handler))
    app.dependency_overrides[get_backend_client] = lambda: client_obj
    try:
        client = _client()
        start = client.post(
            "/voice/sessions/new",
            json={
                "direction": "inbound",
                "lead_id": "11111111-1111-4111-8111-111111111111",
                "customer_id": "22222222-2222-4222-8222-222222222222",
                "phone": "+33612345678",
            },
        )
        sid = start.json()["session_id"]
        res = client.post(
            "/voice/turn",
            json={"session_id": sid, "transcript": "Allô ?"},
        )
        assert res.status_code == 502
        assert res.json()["detail"] == "backend_turn_failed"
    finally:
        app.dependency_overrides.pop(get_backend_client, None)


def test_voice_turn_404_for_unknown_session() -> None:
    client = _client()
    res = client.post(
        "/voice/turn",
        json={"session_id": "99999999-9999-4999-8999-999999999999", "transcript": "Allô ?"},
    )
    assert res.status_code == 404
    assert res.json()["detail"] == "session_not_found"


def test_end_call_is_idempotent() -> None:
    client = _client()
    start = client.post(
        "/voice/sessions/new",
        json={
            "direction": "inbound",
            "lead_id": "11111111-1111-4111-8111-111111111111",
            "customer_id": "22222222-2222-4222-8222-222222222222",
            "phone": "+33612345678",
        },
    )
    sid = start.json()["session_id"]
    res1 = client.post(f"/voice/sessions/{sid}/end")
    assert res1.status_code == 204
    # Same id again — still 204.
    res2 = client.post(f"/voice/sessions/{sid}/end")
    assert res2.status_code == 204
    # And /turn now 404s on it.
    turn = client.post("/voice/turn", json={"session_id": sid, "transcript": "Encore là ?"})
    assert turn.status_code == 404


def test_voice_turn_rejects_empty_transcript() -> None:
    client = _client()
    start = client.post(
        "/voice/sessions/new",
        json={
            "direction": "inbound",
            "lead_id": "11111111-1111-4111-8111-111111111111",
            "customer_id": "22222222-2222-4222-8222-222222222222",
            "phone": "+33612345678",
        },
    )
    sid = start.json()["session_id"]
    res = client.post("/voice/turn", json={"session_id": sid, "transcript": ""})
    assert res.status_code == 422
