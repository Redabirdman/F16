"""Tests for the V0 voice bridge surface (option F scaffold).

No real SIP/Deepgram/Azure — these exercise the FastAPI contract only.
The actual Pipecat pipeline + provider integrations land in M10.
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from f16_pipecat.server import app
from f16_pipecat.voice import _reset_sessions_for_tests


@pytest.fixture(autouse=True)
def _flush_sessions() -> None:
    """Each test starts with an empty in-memory session store."""
    _reset_sessions_for_tests()


def _client() -> TestClient:
    return TestClient(app)


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


def test_voice_turn_echoes_transcript() -> None:
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
    assert "Bonjour, je voudrais un devis trottinette." in body["reply_text"]
    assert body["session_state"] == "live"


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
