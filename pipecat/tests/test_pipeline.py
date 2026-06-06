"""Tests for the cascaded voice pipeline assembly (M10).

These exercise the pure orchestration seams — config selection and the
BackendTurnProcessor — WITHOUT any live SIP/Deepgram/Azure connection. The
backend is a mocked-transport httpx client; the transport is a mock object.
"""

from __future__ import annotations

import json
from typing import Any

import httpx
import pytest

# Real pipecat frame/direction types are importable in this env (1.3.0).
from pipecat.frames.frames import (
    InterimTranscriptionFrame,
    TranscriptionFrame,
    TTSSpeakFrame,
)
from pipecat.processors.frame_processor import FrameDirection

from f16_pipecat.backend import BackendConfig, BackendTurnError, F16BackendClient
from f16_pipecat.pipeline import (
    AZURE_TTS_VOICE_FR,
    DEEPGRAM_STT_MODEL_FR,
    DEEPGRAM_TTS_MODEL_FR,
    BackendTurnProcessor,
    TtsProvider,
    VoicePipelineConfig,
    build_stt_service,
    build_tts_service,
)

# --------------------------------------------------------------------------
# Helpers
# --------------------------------------------------------------------------


def _backend(handler: httpx.MockTransport) -> F16BackendClient:
    return F16BackendClient(
        config=BackendConfig(
            base_url="http://backend:3001",
            secret="s",
            sig_header="x-f16-signature",
        ),
        http=httpx.AsyncClient(transport=handler),
    )


# --------------------------------------------------------------------------
# Config selection: deepgram default vs azure fallback
# --------------------------------------------------------------------------


def test_config_defaults_to_deepgram_tts(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("TTS_PROVIDER", raising=False)
    monkeypatch.setenv("DEEPGRAM_API_KEY", "dg-key")
    config = VoicePipelineConfig.from_env()
    assert config.tts_provider is TtsProvider.DEEPGRAM
    assert config.uses_azure_fallback is False
    # STT is always Deepgram Nova-3 FR.
    assert config.stt_model == DEEPGRAM_STT_MODEL_FR == "nova-3"
    assert config.deepgram_tts_model == DEEPGRAM_TTS_MODEL_FR
    assert config.language == "fr"
    assert config.deepgram_api_key == "dg-key"


def test_config_selects_azure_fallback(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("TTS_PROVIDER", "azure")
    monkeypatch.setenv("AZURE_SPEECH_KEY", "az-key")
    monkeypatch.setenv("AZURE_SPEECH_REGION", "francecentral")
    config = VoicePipelineConfig.from_env()
    assert config.tts_provider is TtsProvider.AZURE
    assert config.uses_azure_fallback is True
    assert config.azure_tts_voice == AZURE_TTS_VOICE_FR
    assert config.azure_speech_key == "az-key"
    assert config.azure_speech_region == "francecentral"


def test_config_unknown_provider_falls_back_to_deepgram(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("TTS_PROVIDER", "elevenlabs")
    config = VoicePipelineConfig.from_env()
    assert config.tts_provider is TtsProvider.DEEPGRAM


def test_build_stt_service_constructs_deepgram_nova3_fr() -> None:
    """STT builder returns a live Deepgram Nova-3 FR service. Construction stores
    the (dummy) key and config only — no network I/O — so this is test-safe."""
    from pipecat.services.deepgram.stt import DeepgramSTTService

    svc = build_stt_service(
        VoicePipelineConfig(tts_provider=TtsProvider.DEEPGRAM, deepgram_api_key="dg-dummy")
    )
    assert isinstance(svc, DeepgramSTTService)


def test_build_tts_service_constructs_deepgram_aura2_fr() -> None:
    """Default (deepgram) TTS builder returns a Deepgram Aura-2 FR service."""
    from pipecat.services.deepgram.tts import DeepgramTTSService

    svc = build_tts_service(
        VoicePipelineConfig(tts_provider=TtsProvider.DEEPGRAM, deepgram_api_key="dg-dummy")
    )
    assert isinstance(svc, DeepgramTTSService)


def test_build_tts_service_constructs_azure_fallback() -> None:
    """Azure fallback (TTS_PROVIDER=azure) TTS builder returns an Azure service."""
    from pipecat.services.azure.tts import AzureTTSService

    svc = build_tts_service(
        VoicePipelineConfig(
            tts_provider=TtsProvider.AZURE,
            azure_speech_key="az-dummy",
            azure_speech_region="francecentral",
        )
    )
    assert isinstance(svc, AzureTTSService)


def test_aura2_voice_id_is_a_valid_french_voice() -> None:
    """Guard the locked Aura-2 voice id: must be the French Agathe voice
    (aura-2-<name>-fr), not the invalid English-only id used previously."""
    assert DEEPGRAM_TTS_MODEL_FR == "aura-2-agathe-fr"
    assert DEEPGRAM_TTS_MODEL_FR.endswith("-fr")


# --------------------------------------------------------------------------
# BackendTurnProcessor: transcript → backend → TextFrame, via mock transport
# --------------------------------------------------------------------------


class _CapturingProcessor(BackendTurnProcessor):
    """Subclass that records frames it pushes downstream (instead of needing
    a fully linked Pipeline). Keeps the test focused on the bridge logic."""

    def __init__(self, **kwargs: Any) -> None:
        super().__init__(**kwargs)
        self.pushed: list[Any] = []

    async def push_frame(
        self, frame: Any, direction: FrameDirection = FrameDirection.DOWNSTREAM
    ) -> None:
        self.pushed.append(frame)


async def test_processor_relays_transcription_to_backend_as_ttsspeakframe() -> None:
    record: dict[str, Any] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        record["url"] = str(request.url)
        record["raw"] = bytes(request.content)
        record["body"] = json.loads(request.content)
        record["signature"] = request.headers.get("x-f16-signature")
        return httpx.Response(
            200, json={"replyText": "Très bien, je note.", "sessionState": "live"}
        )

    proc = _CapturingProcessor(
        backend=_backend(httpx.MockTransport(handler)),
        session_id="sess-1",
        lead_id="lead-1",
        customer_id="cust-1",
    )

    frame = TranscriptionFrame(
        text="Je veux assurer ma trottinette.",
        user_id="cust-1",
        timestamp="2026-06-03T10:00:00Z",
        finalized=True,
    )
    await proc.process_frame(frame, FrameDirection.DOWNSTREAM)

    # Backend was called with the frozen contract + session ids.
    assert record["url"] == "http://backend:3001/v1/voice/turn"
    # HMAC-SHA256 of the raw body with the shared secret, in x-f16-signature.
    import hashlib
    import hmac

    expected_sig = hmac.new(b"s", record["raw"], hashlib.sha256).hexdigest()
    assert record["signature"] == expected_sig
    assert record["body"]["sessionId"] == "sess-1"
    assert record["body"]["leadId"] == "lead-1"
    assert record["body"]["customerId"] == "cust-1"
    assert record["body"]["transcript"] == "Je veux assurer ma trottinette."

    # The brain's reply was pushed downstream as a TTSSpeakFrame (forces the TTS
    # service to synthesize immediately; a bare TextFrame would be buffered by
    # the sentence aggregator and never spoken).
    speak_frames = [f for f in proc.pushed if isinstance(f, TTSSpeakFrame)]
    assert len(speak_frames) == 1
    assert speak_frames[0].text == "Très bien, je note."


async def test_processor_ignores_interim_transcripts() -> None:
    def handler(request: httpx.Request) -> httpx.Response:  # pragma: no cover
        raise AssertionError("backend must not be called for interim frames")

    proc = _CapturingProcessor(
        backend=_backend(httpx.MockTransport(handler)),
        session_id="sess-1",
        lead_id="lead-1",
        customer_id="cust-1",
    )
    # Interims arrive as InterimTranscriptionFrame (a distinct class) — the
    # processor must pass them through WITHOUT invoking the brain. A final
    # transcript is a TranscriptionFrame, which is always acted on.
    interim = InterimTranscriptionFrame(
        text="Je veux...",
        user_id="cust-1",
        timestamp="2026-06-03T10:00:00Z",
    )
    await proc.process_frame(interim, FrameDirection.DOWNSTREAM)
    # Interim frame passed through, no reply produced.
    assert proc.pushed == [interim]


async def test_processor_propagates_backend_error() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(503, json={"error": "down"})

    proc = _CapturingProcessor(
        backend=_backend(httpx.MockTransport(handler)),
        session_id="sess-1",
        lead_id="lead-1",
        customer_id="cust-1",
    )
    frame = TranscriptionFrame(
        text="Allô ?",
        user_id="cust-1",
        timestamp="2026-06-03T10:00:00Z",
        finalized=True,
    )
    with pytest.raises(BackendTurnError):
        await proc.process_frame(frame, FrameDirection.DOWNSTREAM)
