"""Tests for the Asterisk AudioSocket transport + TCP server (M10).

NO real network to Asterisk, NO real Deepgram, NO real pipecat pipeline. We:
  * drive the pure framing codec directly (encode/decode roundtrip, UUID<->str),
  * stand up the real `asyncio` TCP server with a STUBBED per-call handler and
    a fake Asterisk client (UUID frame + audio frames + terminate) to prove the
    server reads the UUID, looks up the session, and writes audio back, and
  * unit-test `run_audiosocket_call`'s wiring against a mock backend + stubbed
    transport/pipeline (no STT/TTS/socket touched).
"""

from __future__ import annotations

import asyncio
import struct
import uuid
from typing import Any

import httpx
import pytest

from f16_pipecat import audiosocket as as_mod
from f16_pipecat import runner as runner_mod
from f16_pipecat.audiosocket import (
    TYPE_AUDIO,
    TYPE_TERMINATE,
    TYPE_UUID,
    AudioSocketProtocolError,
    encode_audio_frame,
    encode_frame,
    encode_terminate,
    read_frame,
    serve_audiosocket,
    uuid_bytes_to_str,
    uuid_str_to_bytes,
)
from f16_pipecat.backend import BackendConfig, F16BackendClient
from f16_pipecat.runner import MissingCallMetadataError, run_audiosocket_call


def _pcm16(*samples: int) -> bytes:
    """Little-endian slin (16-bit PCM) bytes for the given int16 samples."""
    return struct.pack(f"<{len(samples)}h", *samples)


async def _reader_from(payload: bytes) -> asyncio.StreamReader:
    """Build an `asyncio.StreamReader` pre-loaded with `payload` then EOF."""
    reader = asyncio.StreamReader()
    reader.feed_data(payload)
    reader.feed_eof()
    return reader


# --------------------------------------------------------------------------
# Framing codec: encode/decode roundtrip
# --------------------------------------------------------------------------


def test_encode_frame_header_is_type_then_be_uint16_length() -> None:
    out = encode_frame(TYPE_AUDIO, b"\x01\x02\x03")
    assert out[0] == TYPE_AUDIO
    assert out[1:3] == (3).to_bytes(2, "big")
    assert out[3:] == b"\x01\x02\x03"


def test_encode_audio_and_terminate_helpers() -> None:
    pcm = _pcm16(1, 2, 3)
    assert encode_audio_frame(pcm) == encode_frame(TYPE_AUDIO, pcm)
    assert encode_terminate() == encode_frame(TYPE_TERMINATE, b"")


def test_encode_frame_rejects_oversized_payload() -> None:
    with pytest.raises(AudioSocketProtocolError):
        encode_frame(TYPE_AUDIO, b"\x00" * 0x10000)


def test_encode_frame_rejects_bad_type() -> None:
    with pytest.raises(AudioSocketProtocolError):
        encode_frame(0x100, b"")


async def test_read_frame_roundtrips_multiple_frames() -> None:
    call_uuid = uuid.uuid4()
    stream = (
        encode_frame(TYPE_UUID, call_uuid.bytes)
        + encode_audio_frame(_pcm16(10, 20, 30))
        + encode_terminate()
    )
    reader = await _reader_from(stream)

    t1, p1 = await read_frame(reader)  # type: ignore[misc]
    assert t1 == TYPE_UUID
    assert p1 == call_uuid.bytes

    t2, p2 = await read_frame(reader)  # type: ignore[misc]
    assert t2 == TYPE_AUDIO
    assert p2 == _pcm16(10, 20, 30)

    t3, p3 = await read_frame(reader)  # type: ignore[misc]
    assert t3 == TYPE_TERMINATE
    assert p3 == b""

    # Clean EOF after the last frame.
    assert await read_frame(reader) is None


async def test_read_frame_truncated_header_raises() -> None:
    reader = asyncio.StreamReader()
    reader.feed_data(b"\x10\x00")  # 2 of 3 header bytes
    reader.feed_eof()
    with pytest.raises(AudioSocketProtocolError):
        await read_frame(reader)


async def test_read_frame_truncated_payload_raises() -> None:
    reader = asyncio.StreamReader()
    # Declares 4-byte payload but only supplies 2.
    reader.feed_data(encode_frame(TYPE_AUDIO, b"\x00\x00\x00\x00")[:-2])
    reader.feed_eof()
    with pytest.raises(AudioSocketProtocolError):
        await read_frame(reader)


# --------------------------------------------------------------------------
# UUID 16-bytes <-> canonical string
# --------------------------------------------------------------------------


def test_uuid_bytes_to_str_roundtrip() -> None:
    call_uuid = uuid.uuid4()
    as_str = uuid_bytes_to_str(call_uuid.bytes)
    assert as_str == str(call_uuid)
    assert uuid_str_to_bytes(as_str) == call_uuid.bytes


def test_uuid_bytes_to_str_rejects_wrong_length() -> None:
    with pytest.raises(AudioSocketProtocolError):
        uuid_bytes_to_str(b"\x00" * 15)


# --------------------------------------------------------------------------
# TCP server: a fake Asterisk client drives a STUBBED per-call handler
# --------------------------------------------------------------------------


async def test_tcp_server_reads_uuid_looks_up_session_and_writes_audio_back() -> None:
    """A fake Asterisk client connects, sends a UUID frame + two audio frames +
    terminate. The (real) TCP server reads the UUID, the stubbed runner looks up
    the session via a mock backend and writes the audio back as 0x10 frames
    (standing in for STT→backend→TTS). 0x00 ends the call."""
    call_uuid = uuid.uuid4()
    seen: dict[str, Any] = {}

    def backend_handler(request: httpx.Request) -> httpx.Response:
        # GET /v1/voice/session/{uuid} with the shared-secret header.
        seen["lookup_url"] = str(request.url)
        seen["lookup_secret"] = request.headers.get("x-f16-internal-secret")
        return httpx.Response(200, json={"leadId": "lead-9", "customerId": "cust-9"})

    backend = F16BackendClient(
        config=BackendConfig(
            base_url="http://backend:3001",
            secret="s",
            sig_header="x-f16-signature",
            session_secret="lookup-secret",
        ),
        http=httpx.AsyncClient(transport=httpx.MockTransport(backend_handler)),
    )

    # Stub the per-call runner: it does the session lookup (exercising the
    # backend) and echoes inbound audio back as 0x10 frames (no STT/TTS/pipeline).
    async def fake_run(
        reader: asyncio.StreamReader,
        writer: asyncio.StreamWriter,
        *,
        session_id: str,
        **_: Any,
    ) -> None:
        seen["session_id"] = session_id
        session = await backend.get_session(session_id)
        seen["lead_id"] = session.lead_id
        seen["customer_id"] = session.customer_id
        while True:
            result = await read_frame(reader)
            if result is None:
                break
            frame_type, payload = result
            if frame_type == TYPE_TERMINATE:
                break
            if frame_type == TYPE_AUDIO:
                writer.write(encode_audio_frame(payload))  # echo back
                await writer.drain()

    server = await serve_audiosocket("127.0.0.1", 0, handler=as_mod.handle_connection)
    # Patch the runner the handler calls lazily.
    import f16_pipecat.runner as runner_module

    orig = runner_module.run_audiosocket_call
    runner_module.run_audiosocket_call = fake_run  # type: ignore[assignment]
    try:
        port = server.sockets[0].getsockname()[1]
        reader, writer = await asyncio.open_connection("127.0.0.1", port)

        # Fake Asterisk: UUID first, then two audio frames, then terminate.
        writer.write(encode_frame(TYPE_UUID, call_uuid.bytes))
        writer.write(encode_audio_frame(_pcm16(1, 2, 3)))
        writer.write(encode_audio_frame(_pcm16(4, 5, 6)))
        await writer.drain()

        t1, p1 = await read_frame(reader)  # type: ignore[misc]
        t2, p2 = await read_frame(reader)  # type: ignore[misc]
        assert (t1, p1) == (TYPE_AUDIO, _pcm16(1, 2, 3))
        assert (t2, p2) == (TYPE_AUDIO, _pcm16(4, 5, 6))

        # End the call.
        writer.write(encode_terminate())
        await writer.drain()
        writer.close()
        await asyncio.sleep(0.05)  # let the server-side handler finish
    finally:
        runner_module.run_audiosocket_call = orig  # type: ignore[assignment]
        server.close()
        await server.wait_closed()
        await backend.aclose()

    assert seen["session_id"] == str(call_uuid)
    assert seen["lead_id"] == "lead-9"
    assert seen["customer_id"] == "cust-9"
    assert seen["lookup_url"] == f"http://backend:3001/v1/voice/session/{call_uuid}"
    assert seen["lookup_secret"] == "lookup-secret"


async def test_handle_connection_drops_call_without_uuid() -> None:
    """If the peer sends TERMINATE before any UUID, the handler never invokes
    the runner and closes cleanly."""
    called = {"ran": False}

    async def fake_run(*_a: Any, **_k: Any) -> None:  # pragma: no cover
        called["ran"] = True

    import f16_pipecat.runner as runner_module

    orig = runner_module.run_audiosocket_call
    runner_module.run_audiosocket_call = fake_run  # type: ignore[assignment]
    server = await serve_audiosocket("127.0.0.1", 0, handler=as_mod.handle_connection)
    try:
        port = server.sockets[0].getsockname()[1]
        _reader, writer = await asyncio.open_connection("127.0.0.1", port)
        writer.write(encode_terminate())  # no UUID
        await writer.drain()
        writer.close()
        await asyncio.sleep(0.05)
    finally:
        runner_module.run_audiosocket_call = orig  # type: ignore[assignment]
        server.close()
        await server.wait_closed()

    assert called["ran"] is False


# --------------------------------------------------------------------------
# run_audiosocket_call wiring: lookup → build transport + pipeline → run
# --------------------------------------------------------------------------


def _mock_backend() -> F16BackendClient:
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path.startswith("/v1/voice/session/"):
            return httpx.Response(200, json={"leadId": "lead-7", "customerId": "cust-7"})
        return httpx.Response(200, json={"replyText": "Bonjour.", "sessionState": "live"})

    return F16BackendClient(
        config=BackendConfig(
            base_url="http://backend:3001",
            secret="s",
            sig_header="x-f16-signature",
            session_secret="lookup-secret",
        ),
        http=httpx.AsyncClient(transport=httpx.MockTransport(handler)),
    )


async def test_run_audiosocket_call_resolves_identity_and_runs(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """`run_audiosocket_call` should look up lead/customer from the session id,
    build the AudioSocket transport, build the pipeline with the call ids, and
    run the worker to completion — all stubbed (no STT/TTS/socket)."""
    calls: dict[str, Any] = {}

    def fake_build_transport(reader: Any, writer: Any, *, call_ended: Any) -> Any:
        calls["transport_built"] = True
        calls["call_ended"] = call_ended
        return object()

    def fake_build_pipeline(**kwargs: Any) -> Any:
        calls["pipeline_kwargs"] = kwargs
        return object()

    ran = {"completed": False}

    async def fake_run_to_completion(pipeline: Any, call_ended: Any) -> None:
        ran["completed"] = True

    monkeypatch.setattr(runner_mod, "build_audiosocket_transport", fake_build_transport)
    import f16_pipecat.pipeline as pipeline_mod

    monkeypatch.setattr(pipeline_mod, "build_pipeline", fake_build_pipeline)
    monkeypatch.setattr(runner_mod, "_run_pipeline_to_completion", fake_run_to_completion)

    backend = _mock_backend()
    sid = str(uuid.uuid4())
    reader = await _reader_from(b"")

    class _FakeWriter:
        def write(self, _data: bytes) -> None: ...
        async def drain(self) -> None: ...
        def close(self) -> None: ...
        async def wait_closed(self) -> None: ...
        def is_closing(self) -> bool:
            return False

    await run_audiosocket_call(
        reader,
        _FakeWriter(),
        session_id=sid,
        backend=backend,  # type: ignore[arg-type]
    )

    assert calls["transport_built"] is True
    pk = calls["pipeline_kwargs"]
    assert pk["session_id"] == sid
    assert pk["lead_id"] == "lead-7"  # resolved via the session lookup
    assert pk["customer_id"] == "cust-7"
    assert pk["backend"] is backend
    assert ran["completed"] is True
    # Injected backend is NOT closed by the runner (caller owns it).
    await backend.aclose()


async def test_run_audiosocket_call_uses_explicit_ids_without_lookup(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """When lead/customer are passed explicitly, no session lookup happens."""
    calls: dict[str, Any] = {}

    monkeypatch.setattr(runner_mod, "build_audiosocket_transport", lambda *_a, **_k: object())
    import f16_pipecat.pipeline as pipeline_mod

    def fake_build_pipeline(**kwargs: Any) -> Any:
        calls["pipeline_kwargs"] = kwargs
        return object()

    monkeypatch.setattr(pipeline_mod, "build_pipeline", fake_build_pipeline)

    async def fake_run_to_completion(pipeline: Any, call_ended: Any) -> None: ...

    monkeypatch.setattr(runner_mod, "_run_pipeline_to_completion", fake_run_to_completion)

    def handler(request: httpx.Request) -> httpx.Response:  # pragma: no cover
        raise AssertionError("session lookup must not be called when ids are explicit")

    backend = F16BackendClient(
        config=BackendConfig(
            base_url="http://backend:3001", secret="s", sig_header="x-f16-signature"
        ),
        http=httpx.AsyncClient(transport=httpx.MockTransport(handler)),
    )
    reader = await _reader_from(b"")

    class _FakeWriter:
        def write(self, _data: bytes) -> None: ...
        async def drain(self) -> None: ...

    await run_audiosocket_call(
        reader,
        _FakeWriter(),  # type: ignore[arg-type]
        session_id="sess-x",
        lead_id="lead-x",
        customer_id="cust-x",
        backend=backend,
    )
    pk = calls["pipeline_kwargs"]
    assert pk["lead_id"] == "lead-x"
    assert pk["customer_id"] == "cust-x"
    await backend.aclose()


async def test_run_audiosocket_call_raises_when_lookup_fails() -> None:
    """A failed session lookup surfaces as MissingCallMetadataError."""

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(404, json={"error": "not_found"})

    backend = F16BackendClient(
        config=BackendConfig(
            base_url="http://backend:3001",
            secret="s",
            sig_header="x-f16-signature",
            session_secret="lookup-secret",
        ),
        http=httpx.AsyncClient(transport=httpx.MockTransport(handler)),
    )
    reader = await _reader_from(b"")

    class _FakeWriter:
        def write(self, _data: bytes) -> None: ...
        async def drain(self) -> None: ...

    with pytest.raises(MissingCallMetadataError):
        await run_audiosocket_call(
            reader,
            _FakeWriter(),  # type: ignore[arg-type]
            session_id=str(uuid.uuid4()),
            backend=backend,
        )
    await backend.aclose()
