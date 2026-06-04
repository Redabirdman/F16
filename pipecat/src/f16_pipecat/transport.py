"""Real telephony transport bridging jambonz audio to Pipecat frames (M10).

Architecture:

    OVH SIP trunk → jambonz gateway ──(bidirectional WebSocket)──▶ THIS server
                                       ◀──────────────────────────

jambonz streams the call audio to us over a single WebSocket and plays back
whatever audio we send on the SAME socket. We reuse Pipecat's
`FastAPIWebsocketTransport` (the canonical telephony WS transport, identical
shape to the Twilio/Telnyx/Plivo integrations) and supply a thin
`JambonzFrameSerializer` that speaks jambonz's wire format. There is NO
business logic here — only audio framing.

jambonz bidirectional-audio wire format (researched, NOT guessed)
-----------------------------------------------------------------
With the `listen` verb configured for streaming bidirectional audio
(``bidirectionalAudio: { enabled: true, streaming: true, sampleRate: N }``):

  * **Metadata**: ONE text (JSON) frame is sent immediately after the socket
    opens, containing the call attributes normally sent on the call webhook
    (callSid, from, to, ...) PLUS `sampleRate` and `mixType`, and any custom
    `metadata` object set on the verb. We read sessionId/leadId/customerId
    from that custom `metadata` (the backend sets it when it answers the call).
  * **Caller → us**: raw **L16 (16-bit signed PCM, little-endian) mono** audio
    as **binary** WebSocket frames, at the `sampleRate` from the verb.
  * **Us → caller (streaming mode)**: raw **L16 PCM mono** audio as **binary**
    WebSocket frames, streamed straight to the caller. (Non-streaming mode uses
    `playAudio` JSON+base64; we deliberately use STREAMING mode for low latency.)
  * **Barge-in / interruption**: to stop buffered playout we send a
    `{"type":"killAudio"}` JSON text frame.

Sources:
  - https://docs.jambonz.org/verbs/verbs/listen  (bidirectional streaming,
    L16 PCM, configurable sampleRate, metadata-as-first-text-frame,
    playAudio/killAudio control frames)
  - https://github.com/jambonz/test-listen-server  (reference WS server)

Pipecat's `FastAPIWebsocketTransport` already does all the socket plumbing
(receive loop, send, timeouts, audio-clock pacing). We only translate bytes ⇄
frames. This is exactly how pipecat ships Twilio/Telnyx/Plivo support, so we
inherit their battle-tested transport rather than hand-rolling raw audio I/O.
"""

from __future__ import annotations

import json
from typing import TYPE_CHECKING, Any

from pipecat.frames.frames import (
    AudioRawFrame,
    Frame,
    InputAudioRawFrame,
    InterruptionFrame,
)
from pipecat.serializers.base_serializer import FrameSerializer

from f16_pipecat.logging import logger

if TYPE_CHECKING:  # pragma: no cover - typing only
    from fastapi import WebSocket


# jambonz audio is L16 (16-bit signed PCM) mono. The sample rate is whatever
# the backend set in the `listen` verb; we default to 8 kHz (telephony narrow-
# band, the OVH/SIP norm) but ALWAYS prefer the rate jambonz announces in the
# metadata frame.
JAMBONZ_DEFAULT_SAMPLE_RATE = 8000
_PCM_BYTES_PER_SAMPLE = 2  # int16


class JambonzCallMetadata:
    """Parsed session identity from jambonz's first text frame.

    The backend, when it answers the call and emits the `listen` verb, sets a
    custom ``metadata`` object on the verb carrying our per-call identity. We
    surface those three ids; everything else (callSid, from, to, sampleRate…)
    is logged but not required by the pipeline.
    """

    __slots__ = ("session_id", "lead_id", "customer_id", "sample_rate", "raw")

    def __init__(
        self,
        *,
        session_id: str,
        lead_id: str,
        customer_id: str,
        sample_rate: int,
        raw: dict[str, Any],
    ) -> None:
        self.session_id = session_id
        self.lead_id = lead_id
        self.customer_id = customer_id
        self.sample_rate = sample_rate
        self.raw = raw

    @classmethod
    def parse(cls, data: str | bytes) -> JambonzCallMetadata | None:
        """Parse the jambonz metadata text frame.

        Returns ``None`` if the frame is not valid JSON or does not carry the
        required session ids — the caller treats that as "reject the call".

        jambonz nests our custom verb metadata under a top-level ``metadata``
        key. We accept the ids either there OR at the top level (some jambonz
        configs flatten custom metadata), and tolerate both camelCase
        (jambonz native) and snake_case spellings.

        # TODO(live): confirm against a live jambonz whether our custom verb
        # metadata lands under `metadata` (documented) vs flattened at the top
        # level. We read BOTH so either shape works.
        """
        try:
            obj = json.loads(data)
        except (ValueError, TypeError):
            return None
        if not isinstance(obj, dict):
            return None

        nested = obj.get("metadata")
        meta: dict[str, Any] = nested if isinstance(nested, dict) else obj

        def pick(*keys: str) -> str:
            for src in (meta, obj):
                for key in keys:
                    val = src.get(key)
                    if isinstance(val, str) and val:
                        return val
            return ""

        session_id = pick("sessionId", "session_id")
        lead_id = pick("leadId", "lead_id")
        customer_id = pick("customerId", "customer_id")
        if not (session_id and lead_id and customer_id):
            return None

        # jambonz announces the inbound audio sample rate at top level.
        rate_raw = obj.get("sampleRate", meta.get("sampleRate", JAMBONZ_DEFAULT_SAMPLE_RATE))
        try:
            sample_rate = int(rate_raw)
        except (ValueError, TypeError):
            sample_rate = JAMBONZ_DEFAULT_SAMPLE_RATE

        return cls(
            session_id=session_id,
            lead_id=lead_id,
            customer_id=customer_id,
            sample_rate=sample_rate,
            raw=obj,
        )


class JambonzFrameSerializer(FrameSerializer):
    """Translate between jambonz's WS wire format and Pipecat frames.

    Wire contract (streaming bidirectional audio):
      * deserialize: binary L16 PCM mono → `InputAudioRawFrame`; the first text
        frame (metadata) and any other text frames are swallowed (returns
        ``None``) — metadata is consumed by the runner BEFORE the pipeline
        starts, not on the audio path.
      * serialize: `AudioRawFrame` (TTS output) → binary L16 PCM bytes;
        `InterruptionFrame` → `{"type":"killAudio"}` text frame so jambonz
        flushes any buffered playout for barge-in.

    jambonz expects the audio we send to be at `bidirectionalAudio.sampleRate`.
    We construct the serializer with the negotiated rate (from the metadata
    frame) and tell pipecat's output transport to run at the same rate, so no
    resampling is needed here — the bytes we hand back are already correct.
    """

    def __init__(self, *, sample_rate: int = JAMBONZ_DEFAULT_SAMPLE_RATE) -> None:
        super().__init__()
        self._sample_rate = sample_rate

    @property
    def sample_rate(self) -> int:
        return self._sample_rate

    # NOTE: we intentionally do NOT override `setup(frame: StartFrame)`. The
    # base no-op is sufficient — we trust the jambonz rate passed to __init__
    # (authoritative for the SIP leg), so there is nothing to negotiate at
    # StartFrame time.

    async def serialize(self, frame: Frame) -> str | bytes | None:
        if isinstance(frame, InterruptionFrame):
            # Barge-in: stop whatever jambonz is currently playing out.
            return json.dumps({"type": "killAudio"})

        if isinstance(frame, AudioRawFrame):
            audio = frame.audio
            if not audio:
                return None
            # Streaming mode: hand jambonz raw L16 PCM as a BINARY frame. The
            # pipeline's output transport is configured at the jambonz rate, so
            # `frame.sample_rate` already matches and no resample is required.
            return bytes(audio)

        # Everything else (control frames, transport messages) is not part of
        # the jambonz wire format — drop it.
        return None

    async def deserialize(self, data: str | bytes) -> Frame | None:
        if isinstance(data, str):
            # Text frames after connect are jambonz control/status JSON (the
            # metadata frame is consumed by the runner before the pipeline
            # starts). Nothing on the audio path to do.
            return None

        if not data:
            return None
        # Binary frame = raw L16 PCM mono from the caller.
        return InputAudioRawFrame(
            audio=bytes(data),
            sample_rate=self._sample_rate,
            num_channels=1,
        )


def build_jambonz_transport(
    websocket: WebSocket,
    *,
    sample_rate: int = JAMBONZ_DEFAULT_SAMPLE_RATE,
    session_timeout_secs: int | None = None,
) -> Any:
    """Build a Pipecat WS transport wired to jambonz's L16 wire format.

    Returns a `FastAPIWebsocketTransport` whose `.input()` / `.output()`
    satisfy the pipeline's `VoiceTransport` Protocol. Heavy imports are LAZY so
    importing this module stays cheap.

    Args:
        websocket: the accepted FastAPI WebSocket from jambonz.
        sample_rate: the L16 rate negotiated via the metadata frame.
        session_timeout_secs: optional idle-timeout guard for a stuck call.
    """
    from pipecat.transports.websocket.fastapi import (
        FastAPIWebsocketParams,
        FastAPIWebsocketTransport,
    )

    serializer = JambonzFrameSerializer(sample_rate=sample_rate)
    params = FastAPIWebsocketParams(
        audio_in_enabled=True,
        audio_out_enabled=True,
        audio_in_sample_rate=sample_rate,
        audio_out_sample_rate=sample_rate,
        audio_in_channels=1,
        audio_out_channels=1,
        # Streaming mode wants raw PCM binary, NOT WAV-wrapped.
        add_wav_header=False,
        serializer=serializer,
        session_timeout=session_timeout_secs,
    )
    logger.info(f"jambonz-transport: built (L16 PCM mono @ {sample_rate} Hz)")
    return FastAPIWebsocketTransport(websocket=websocket, params=params)


__all__ = [
    "JAMBONZ_DEFAULT_SAMPLE_RATE",
    "JambonzCallMetadata",
    "JambonzFrameSerializer",
    "build_jambonz_transport",
]
