"""Tests for the per-call runner + the jambonz `/voice/ws` endpoint (M10).

NO live jambonz, NO real Deepgram/Azure, NO real sockets to the outside world.
We drive the FastAPI WebSocket via Starlette's TestClient with a fake jambonz
client (metadata frame + audio frames), and unit-test `run_voice_call`'s wiring
against a mock backend + a stubbed pipecat worker/runner.
"""

from __future__ import annotations

import json
import struct
from typing import Any

import httpx
import pytest
from fastapi.testclient import TestClient

from f16_pipecat import runner as runner_mod
from f16_pipecat.backend import BackendConfig, F16BackendClient
from f16_pipecat.runner import MissingCallMetadataError, run_voice_call
from f16_pipecat.server import app
from f16_pipecat.transport import JambonzCallMetadata


def _pcm16(*samples: int) -> bytes:
    return struct.pack(f"<{len(samples)}h", *samples)


def _meta_frame(
    *,
    session_id: str = "sess-1",
    lead_id: str = "lead-1",
    customer_id: str = "cust-1",
    sample_rate: int = 16000,
) -> str:
    return json.dumps(
        {
            "callSid": "cs-1",
            "sampleRate": sample_rate,
            "mixType": "mono",
            "metadata": {
                "sessionId": session_id,
                "leadId": lead_id,
                "customerId": customer_id,
            },
        }
    )


def _mock_backend() -> F16BackendClient:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200, json={"replyText": "Bonjour, je vous écoute.", "sessionState": "live"}
        )

    config = BackendConfig(base_url="http://backend:3001", secret="s", sig_header="x-f16-signature")
    return F16BackendClient(
        config=config,
        http=httpx.AsyncClient(transport=httpx.MockTransport(handler)),
    )


# --------------------------------------------------------------------------
# /voice/ws endpoint: metadata gate + audio bridging (run_voice_call stubbed)
# --------------------------------------------------------------------------


def test_ws_echoes_audio_when_metadata_valid(monkeypatch: pytest.MonkeyPatch) -> None:
    """A fake jambonz client sends metadata + two audio frames; the (stubbed)
    runner surfaces the audio and writes audio back. We assert the route reads
    metadata correctly and that audio flows IN and BACK OUT over the socket."""
    seen: dict[str, Any] = {}

    async def fake_run(websocket: Any, **kwargs: Any) -> None:
        # Capture the identity the route parsed from the metadata frame.
        seen["session_id"] = kwargs.get("session_id")
        seen["lead_id"] = kwargs.get("lead_id")
        seen["customer_id"] = kwargs.get("customer_id")
        meta = kwargs.get("metadata")
        seen["rate"] = meta.sample_rate if meta else None
        # Drain inbound audio frames and echo each straight back (binary),
        # standing in for the transport surfacing audio into the pipeline and
        # the pipeline writing TTS audio out.
        received: list[bytes] = []
        while True:
            msg = await websocket.receive()
            if msg.get("type") == "websocket.disconnect":
                break
            data = msg.get("bytes")
            if data is None:
                # client signalled end via a text sentinel
                break
            received.append(data)
            await websocket.send_bytes(data)
        seen["received"] = received

    monkeypatch.setattr(runner_mod, "run_voice_call", fake_run)

    client = TestClient(app)
    with client.websocket_connect("/voice/ws") as ws:
        ws.send_text(_meta_frame(sample_rate=24000))
        ws.send_bytes(_pcm16(1, 2, 3))
        echoed1 = ws.receive_bytes()
        ws.send_bytes(_pcm16(4, 5, 6))
        echoed2 = ws.receive_bytes()
        # End the call by sending a text sentinel the fake runner treats as EOF.
        ws.send_text("__end__")

    assert seen["session_id"] == "sess-1"
    assert seen["lead_id"] == "lead-1"
    assert seen["customer_id"] == "cust-1"
    assert seen["rate"] == 24000
    # Audio surfaced into the pipeline and came back out unchanged.
    assert echoed1 == _pcm16(1, 2, 3)
    assert echoed2 == _pcm16(4, 5, 6)
    assert seen["received"] == [_pcm16(1, 2, 3), _pcm16(4, 5, 6)]


def test_ws_rejects_call_with_missing_metadata(monkeypatch: pytest.MonkeyPatch) -> None:
    """If jambonz's first frame lacks the ids, the route closes (1008) and
    never invokes the runner."""
    called = {"ran": False}

    async def fake_run(*_a: Any, **_k: Any) -> None:  # pragma: no cover
        called["ran"] = True

    monkeypatch.setattr(runner_mod, "run_voice_call", fake_run)

    client = TestClient(app)
    from starlette.websockets import WebSocketDisconnect

    with client.websocket_connect("/voice/ws") as ws:
        ws.send_text(json.dumps({"callSid": "cs-1"}))  # no ids
        with pytest.raises(WebSocketDisconnect) as exc:
            ws.receive_bytes()
    assert exc.value.code == 1008
    assert called["ran"] is False


# --------------------------------------------------------------------------
# read_call_metadata: text vs bytes first frame
# --------------------------------------------------------------------------


async def test_read_call_metadata_from_text_frame() -> None:
    class _WS:
        async def receive(self) -> dict[str, Any]:
            return {"type": "websocket.receive", "text": _meta_frame()}

    meta = await runner_mod.read_call_metadata(_WS())  # type: ignore[arg-type]
    assert meta.session_id == "sess-1"
    assert meta.sample_rate == 16000


async def test_read_call_metadata_missing_payload_raises() -> None:
    class _WS:
        async def receive(self) -> dict[str, Any]:
            return {"type": "websocket.receive", "text": None, "bytes": None}

    with pytest.raises(MissingCallMetadataError):
        await runner_mod.read_call_metadata(_WS())  # type: ignore[arg-type]


# --------------------------------------------------------------------------
# run_voice_call wiring: builds transport + pipeline + runs, closes backend
# --------------------------------------------------------------------------


async def test_run_voice_call_builds_and_runs_pipeline(monkeypatch: pytest.MonkeyPatch) -> None:
    """`run_voice_call` should build the jambonz transport at the negotiated
    rate, build the pipeline with the call ids + injected backend, and run the
    worker to completion — all stubbed so no STT/TTS/socket is touched."""
    calls: dict[str, Any] = {}

    def fake_build_transport(ws: Any, *, sample_rate: int, session_timeout_secs: Any = None) -> Any:
        calls["transport_rate"] = sample_rate
        return object()  # opaque transport stand-in

    def fake_build_pipeline(**kwargs: Any) -> Any:
        calls["pipeline_kwargs"] = kwargs
        return object()  # opaque pipeline stand-in

    ran = {"completed": False}

    async def fake_run_to_completion(pipeline: Any, transport: Any) -> None:
        ran["completed"] = True

    # Patch the names the runner imports lazily.
    monkeypatch.setattr(runner_mod, "build_jambonz_transport", fake_build_transport)
    import f16_pipecat.pipeline as pipeline_mod

    monkeypatch.setattr(pipeline_mod, "build_pipeline", fake_build_pipeline)
    monkeypatch.setattr(runner_mod, "_run_pipeline_to_completion", fake_run_to_completion)

    backend = _mock_backend()
    meta = JambonzCallMetadata(
        session_id="sess-9",
        lead_id="lead-9",
        customer_id="cust-9",
        sample_rate=24000,
        raw={},
    )

    await run_voice_call(object(), metadata=meta, backend=backend)  # type: ignore[arg-type]

    assert calls["transport_rate"] == 24000
    pk = calls["pipeline_kwargs"]
    assert pk["session_id"] == "sess-9"
    assert pk["lead_id"] == "lead-9"
    assert pk["customer_id"] == "cust-9"
    assert pk["backend"] is backend
    assert ran["completed"] is True
    # Injected backend is NOT closed by the runner (caller owns it).
    await backend.aclose()


async def test_run_voice_call_requires_ids() -> None:
    with pytest.raises(MissingCallMetadataError):
        await run_voice_call(object())  # type: ignore[arg-type]
