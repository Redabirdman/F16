"""Asterisk AudioSocket transport for the F16 Pipecat voice bridge (M10).

Architecture (Asterisk is the TCP CLIENT; WE listen):

    OVH SIP trunk → Asterisk ──(TCP connect OUT)──▶ THIS server (0.0.0.0:9092)
                              ◀──────────────────────  (full-duplex)

Asterisk's ``AudioSocket()`` dialplan app / channel driver opens a plain TCP
connection to us and streams the call's audio over it. We LISTEN; per inbound
connection we read the call UUID, look the session up in the F16 backend, build
a Pipecat pipeline backed by an AudioSocket transport, and run the call to
completion. There is NO business logic here — only audio framing + lifecycle.

AudioSocket wire format (built EXACTLY to the Asterisk protocol)
---------------------------------------------------------------
Every message is a TLV frame::

    [1 byte type][2 bytes payload length, uint16 BIG-ENDIAN][payload...]

Frame types:
  * ``0x00`` TERMINATE  — payload empty; hang up / end the call.
  * ``0x01`` UUID       — payload = 16 RAW bytes. The FIRST frame after connect
                          carries the 16-byte call UUID == our F16 sessionId.
  * ``0x03`` DTMF       — payload = 1 ASCII byte (the digit pressed).
  * ``0x10`` AUDIO      — payload = ``slin``: signed-linear 16-bit PCM, MONO,
                          8000 Hz, LITTLE-endian. 20 ms = 160 samples = 320 B.
  * ``0xff`` ERROR      — payload = 1 byte error code.

Sample rate: the AudioSocket leg is ALWAYS 8 kHz slin mono. We configure the
pipeline IO at 8 kHz; Deepgram STT accepts 8 kHz natively, and Pipecat's output
``MediaSender`` resamples the TTS audio (typically 24 kHz from Aura-2) down to
the transport's 8 kHz before ``write_audio_frame`` hands the bytes to Asterisk.

Transport design
----------------
``AudioSocketTransport`` mirrors Pipecat's ``WebsocketServerTransport`` pattern
but over a single, already-accepted ``asyncio`` reader/writer pair instead of a
WebSocket:

  * ``AudioSocketInputTransport`` (``BaseInputTransport``) runs a read loop that
    decodes frames off the reader; ``0x10`` audio → ``push_audio_frame`` (feeds
    STT); ``0x00``/EOF → signals the call to end; ``0x03`` DTMF is logged.
  * ``AudioSocketOutputTransport`` (``BaseOutputTransport``) overrides
    ``write_audio_frame`` to wrap the (already 8 kHz) PCM as a ``0x10`` frame and
    write it back to the same socket. The base class chunks + resamples + paces.

Heavy Pipecat imports are LAZY (inside functions/closures) so importing this
module at app boot stays cheap.
"""

from __future__ import annotations

import asyncio
import uuid
from typing import TYPE_CHECKING

from f16_pipecat.logging import logger

if TYPE_CHECKING:  # pragma: no cover - typing only
    from pipecat.transports.base_transport import BaseTransport


# --------------------------------------------------------------------------
# Protocol constants
# --------------------------------------------------------------------------

# AudioSocket frame type bytes.
TYPE_TERMINATE = 0x00
TYPE_UUID = 0x01
TYPE_DTMF = 0x03
TYPE_AUDIO = 0x10
TYPE_ERROR = 0xFF

# The AudioSocket audio leg is always slin: 16-bit signed PCM, mono, 8 kHz,
# little-endian. 20 ms = 160 samples = 320 bytes.
AUDIOSOCKET_SAMPLE_RATE = 8000
AUDIOSOCKET_CHANNELS = 1
_PCM_BYTES_PER_SAMPLE = 2  # int16

# 3-byte fixed header: type (1) + big-endian uint16 length (2).
_HEADER_LEN = 3
# uint16 payload length ceiling (the length field is 2 bytes).
_MAX_PAYLOAD = 0xFFFF
_UUID_BYTES = 16

# Default listen address. Asterisk reaches this Windows-host server via WSL
# mirrored networking at 127.0.0.1:9092; we bind 0.0.0.0 so any interface works.
DEFAULT_AUDIOSOCKET_HOST = "0.0.0.0"  # noqa: S104 — intentional all-interfaces bind
DEFAULT_AUDIOSOCKET_PORT = 9092


# --------------------------------------------------------------------------
# Framing codec (pure — no I/O)
# --------------------------------------------------------------------------


class AudioSocketProtocolError(ValueError):
    """Raised when an AudioSocket frame is malformed (bad header/length)."""


def encode_frame(frame_type: int, payload: bytes = b"") -> bytes:
    """Encode one AudioSocket frame: ``[type][len BE u16][payload]``.

    Args:
        frame_type: one of the ``TYPE_*`` constants (0..255).
        payload: the raw payload bytes (<= 65535).

    Raises:
        AudioSocketProtocolError: if the type or payload length is out of range.
    """
    if not 0 <= frame_type <= 0xFF:
        raise AudioSocketProtocolError(f"frame type out of range: {frame_type}")
    if len(payload) > _MAX_PAYLOAD:
        raise AudioSocketProtocolError(f"payload too large: {len(payload)} bytes")
    return bytes((frame_type,)) + len(payload).to_bytes(2, "big") + payload


def encode_audio_frame(pcm: bytes) -> bytes:
    """Wrap raw slin PCM bytes as a ``0x10`` audio frame."""
    return encode_frame(TYPE_AUDIO, pcm)


def encode_terminate() -> bytes:
    """The ``0x00`` terminate frame (empty payload) that ends the call."""
    return encode_frame(TYPE_TERMINATE)


def uuid_bytes_to_str(raw: bytes) -> str:
    """Convert the 16 raw UUID bytes from a ``0x01`` frame to canonical string.

    Raises:
        AudioSocketProtocolError: if ``raw`` is not exactly 16 bytes.
    """
    if len(raw) != _UUID_BYTES:
        raise AudioSocketProtocolError(f"UUID payload must be 16 bytes, got {len(raw)}")
    return str(uuid.UUID(bytes=raw))


def uuid_str_to_bytes(value: str) -> bytes:
    """Convert a canonical UUID string back to its 16 raw bytes (test helper)."""
    return uuid.UUID(value).bytes


async def read_frame(reader: asyncio.StreamReader) -> tuple[int, bytes] | None:
    """Read exactly one AudioSocket frame from ``reader``.

    Returns ``(frame_type, payload)``, or ``None`` on a clean EOF (peer closed
    the socket). Raises ``AudioSocketProtocolError`` only on a partial/garbled
    header mid-stream.
    """
    try:
        header = await reader.readexactly(_HEADER_LEN)
    except asyncio.IncompleteReadError as exc:
        # Zero bytes => clean EOF; partial header => truncated frame.
        if not exc.partial:
            return None
        raise AudioSocketProtocolError("truncated AudioSocket frame header") from exc

    frame_type = header[0]
    payload_len = int.from_bytes(header[1:3], "big")
    if payload_len == 0:
        return frame_type, b""

    try:
        payload = await reader.readexactly(payload_len)
    except asyncio.IncompleteReadError as exc:
        raise AudioSocketProtocolError("truncated AudioSocket frame payload") from exc
    return frame_type, payload


# --------------------------------------------------------------------------
# Transport: bridges the framed TCP stream <-> Pipecat audio frames
# --------------------------------------------------------------------------


def build_audiosocket_transport(
    reader: asyncio.StreamReader,
    writer: asyncio.StreamWriter,
    *,
    call_ended: asyncio.Event,
) -> BaseTransport:
    """Build an AudioSocket transport bound to one accepted TCP connection.

    The returned object's ``input()`` / ``output()`` satisfy the pipeline's
    ``VoiceTransport`` Protocol. IO runs at 8 kHz slin mono; the output transport
    relies on Pipecat's ``MediaSender`` to resample TTS audio down to 8 kHz
    before framing.

    The pipecat-backed transport classes live in ``audiosocket_transport`` and
    are imported HERE (lazily) so importing this module — and ``server.py`` at
    app boot — never drags in pipecat's transport machinery.

    Args:
        reader: the connection's ``asyncio.StreamReader``.
        writer: the connection's ``asyncio.StreamWriter``.
        call_ended: event the input read loop sets on TERMINATE/EOF so the
            runner can stop the pipeline.
    """
    from f16_pipecat.audiosocket_transport import make_audiosocket_transport

    return make_audiosocket_transport(reader, writer, call_ended=call_ended)


# --------------------------------------------------------------------------
# TCP server: one connection == one call
# --------------------------------------------------------------------------


async def handle_connection(
    reader: asyncio.StreamReader,
    writer: asyncio.StreamWriter,
) -> None:
    """Drive ONE Asterisk AudioSocket connection through the voice pipeline.

    Steps:
      1. Read the first ``0x01`` UUID frame → 16-byte call UUID == sessionId.
      2. Look the session up in the F16 backend (leadId + customerId).
      3. Build the AudioSocket transport + cascaded pipeline and run it.
      4. On TERMINATE / EOF / error, end the call cleanly and close the socket.

    All heavy work (backend lookup, pipeline) is delegated to the runner; this
    function owns only the connect → identify → run → cleanup lifecycle.
    """
    peer = writer.get_extra_info("peername")
    logger.info(f"audiosocket: connection from {peer}")

    # Imported lazily so the TCP server module stays import-light.
    from f16_pipecat.runner import run_audiosocket_call

    session_id: str | None = None
    try:
        session_id = await _read_session_uuid(reader)
        if session_id is None:
            logger.warning("audiosocket: no UUID frame before audio/EOF — dropping call")
            return
        await run_audiosocket_call(reader, writer, session_id=session_id)
    except Exception as exc:  # noqa: BLE001 — never let one bad call kill the server
        logger.error(f"audiosocket: call failed session={session_id}: {exc}")
    finally:
        await _close_writer(writer)
        logger.info(f"audiosocket: call ended session={session_id}")


async def _read_session_uuid(reader: asyncio.StreamReader) -> str | None:
    """Read frames until the ``0x01`` UUID arrives; return the sessionId string.

    Asterisk sends the UUID as the first frame; we tolerate (and skip) any stray
    leading frames, and bail with ``None`` on TERMINATE/EOF before a UUID.
    """
    while True:
        result = await read_frame(reader)
        if result is None:
            return None
        frame_type, payload = result
        if frame_type == TYPE_UUID:
            return uuid_bytes_to_str(payload)
        if frame_type == TYPE_TERMINATE:
            return None
        # Anything before the UUID (unexpected) is skipped.
        logger.debug(f"audiosocket: pre-UUID frame type=0x{frame_type:02x} skipped")


async def _close_writer(writer: asyncio.StreamWriter) -> None:
    """Send a terminate frame (best effort) and close the socket cleanly."""
    try:
        if not writer.is_closing():
            writer.write(encode_terminate())
            await writer.drain()
    except (ConnectionError, RuntimeError):
        pass
    try:
        writer.close()
        await writer.wait_closed()
    except (ConnectionError, RuntimeError):
        pass


async def serve_audiosocket(
    host: str = DEFAULT_AUDIOSOCKET_HOST,
    port: int = DEFAULT_AUDIOSOCKET_PORT,
    *,
    handler: object | None = None,
) -> asyncio.AbstractServer:
    """Start the AudioSocket TCP server and return the running ``asyncio`` server.

    Caller is responsible for ``serve_forever()`` / closing it. ``handler`` is
    overridable for tests (defaults to :func:`handle_connection`).
    """
    conn_handler = handler or handle_connection
    server = await asyncio.start_server(conn_handler, host, port)  # type: ignore[arg-type]
    logger.info(f"audiosocket: listening on {host}:{port}")
    return server


__all__ = [
    "AUDIOSOCKET_CHANNELS",
    "AUDIOSOCKET_SAMPLE_RATE",
    "DEFAULT_AUDIOSOCKET_HOST",
    "DEFAULT_AUDIOSOCKET_PORT",
    "TYPE_AUDIO",
    "TYPE_DTMF",
    "TYPE_ERROR",
    "TYPE_TERMINATE",
    "TYPE_UUID",
    "AudioSocketProtocolError",
    "build_audiosocket_transport",
    "encode_audio_frame",
    "encode_frame",
    "encode_terminate",
    "handle_connection",
    "read_frame",
    "serve_audiosocket",
    "uuid_bytes_to_str",
    "uuid_str_to_bytes",
]
