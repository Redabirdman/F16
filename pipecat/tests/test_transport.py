"""Tests for the jambonz transport + serializer (M10).

These exercise the wire-format translation in isolation — NO live jambonz, NO
sockets. The serializer is pure (bytes ⇄ frames), so it can be driven directly.
"""

from __future__ import annotations

import json
import struct

import pytest
from pipecat.frames.frames import (
    InputAudioRawFrame,
    InterruptionFrame,
    OutputAudioRawFrame,
    TextFrame,
)

from f16_pipecat.transport import (
    JAMBONZ_DEFAULT_SAMPLE_RATE,
    JambonzCallMetadata,
    JambonzFrameSerializer,
)


def _pcm16(*samples: int) -> bytes:
    """Little-endian L16 PCM bytes for the given int16 samples."""
    return struct.pack(f"<{len(samples)}h", *samples)


# --------------------------------------------------------------------------
# Metadata parsing (jambonz first text frame)
# --------------------------------------------------------------------------


def test_metadata_parses_nested_camelcase() -> None:
    """jambonz nests our verb metadata under `metadata`; sampleRate at top."""
    raw = json.dumps(
        {
            "callSid": "cs-1",
            "from": "+33611112222",
            "sampleRate": 16000,
            "mixType": "mono",
            "metadata": {
                "sessionId": "sess-1",
                "leadId": "lead-1",
                "customerId": "cust-1",
            },
        }
    )
    meta = JambonzCallMetadata.parse(raw)
    assert meta is not None
    assert meta.session_id == "sess-1"
    assert meta.lead_id == "lead-1"
    assert meta.customer_id == "cust-1"
    assert meta.sample_rate == 16000


def test_metadata_parses_flattened_snakecase() -> None:
    """Tolerate a flattened, snake_case shape too (defensive)."""
    raw = json.dumps(
        {
            "session_id": "sess-2",
            "lead_id": "lead-2",
            "customer_id": "cust-2",
        }
    )
    meta = JambonzCallMetadata.parse(raw)
    assert meta is not None
    assert meta.session_id == "sess-2"
    assert meta.lead_id == "lead-2"
    assert meta.customer_id == "cust-2"
    # No sampleRate announced → telephony default.
    assert meta.sample_rate == JAMBONZ_DEFAULT_SAMPLE_RATE


def test_metadata_rejects_missing_ids() -> None:
    raw = json.dumps({"callSid": "cs-1", "metadata": {"sessionId": "sess-1"}})
    assert JambonzCallMetadata.parse(raw) is None


def test_metadata_rejects_non_json() -> None:
    assert JambonzCallMetadata.parse("not-json") is None
    assert JambonzCallMetadata.parse(b"\x00\x01\x02") is None


# --------------------------------------------------------------------------
# Deserialize: binary L16 PCM in → InputAudioRawFrame
# --------------------------------------------------------------------------


async def test_deserialize_binary_pcm_becomes_input_audio_frame() -> None:
    ser = JambonzFrameSerializer(sample_rate=16000)
    pcm = _pcm16(0, 100, -100, 32767)
    frame = await ser.deserialize(pcm)
    assert isinstance(frame, InputAudioRawFrame)
    assert frame.audio == pcm
    assert frame.sample_rate == 16000
    assert frame.num_channels == 1


async def test_deserialize_text_frame_is_ignored_on_audio_path() -> None:
    """Post-connect text frames (control/status) are not audio — dropped."""
    ser = JambonzFrameSerializer()
    assert await ser.deserialize(json.dumps({"type": "status"})) is None


async def test_deserialize_empty_binary_is_dropped() -> None:
    ser = JambonzFrameSerializer()
    assert await ser.deserialize(b"") is None


# --------------------------------------------------------------------------
# Serialize: TTS audio out → binary PCM; interruption → killAudio
# --------------------------------------------------------------------------


async def test_serialize_output_audio_becomes_binary_pcm() -> None:
    ser = JambonzFrameSerializer(sample_rate=8000)
    pcm = _pcm16(1, 2, 3, 4)
    out = await ser.serialize(OutputAudioRawFrame(audio=pcm, sample_rate=8000, num_channels=1))
    assert isinstance(out, bytes)
    assert out == pcm  # raw L16 binary, no JSON wrapper


async def test_serialize_interruption_becomes_killaudio_json() -> None:
    ser = JambonzFrameSerializer()
    out = await ser.serialize(InterruptionFrame())
    assert isinstance(out, str)
    assert json.loads(out) == {"type": "killAudio"}


async def test_serialize_empty_audio_is_dropped() -> None:
    ser = JambonzFrameSerializer()
    out = await ser.serialize(OutputAudioRawFrame(audio=b"", sample_rate=8000, num_channels=1))
    assert out is None


async def test_serialize_unrelated_frame_is_dropped() -> None:
    ser = JambonzFrameSerializer()
    assert await ser.serialize(TextFrame("bonjour")) is None


# --------------------------------------------------------------------------
# Transport builder: shape + Protocol satisfaction (no socket)
# --------------------------------------------------------------------------


def test_build_transport_satisfies_voice_transport_protocol() -> None:
    """`build_jambonz_transport` returns something with input()/output() that
    the pipeline's `VoiceTransport` Protocol accepts. A fake WS object is
    enough — construction opens no socket."""
    from f16_pipecat.pipeline import VoiceTransport
    from f16_pipecat.transport import build_jambonz_transport

    class _FakeWS:
        client_state = None
        application_state = None

    transport = build_jambonz_transport(_FakeWS(), sample_rate=16000)  # type: ignore[arg-type]
    assert isinstance(transport, VoiceTransport)
    # input()/output() return FrameProcessors (callable, no socket opened).
    assert transport.input() is not None
    assert transport.output() is not None


@pytest.mark.parametrize("rate", [8000, 16000, 24000])
def test_serializer_round_trips_rate(rate: int) -> None:
    ser = JambonzFrameSerializer(sample_rate=rate)
    assert ser.sample_rate == rate
