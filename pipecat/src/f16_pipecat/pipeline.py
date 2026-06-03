"""Cascaded voice pipeline assembly for the F16 Pipecat bridge (M10).

Architecture (cascaded, brain in the BACKEND):

    phone ──RTP──▶ transport.input
                      │  audio frames
                      ▼
                 STT  (Deepgram Nova-3, language=fr)   → TranscriptionFrame
                      │
                      ▼
        BackendTurnProcessor  ── POST /v1/voice/turn ──▶ F16 backend brain
                      │  ◀── replyText ───────────────── (shared Sales Agent)
                      ▼  TextFrame
                 TTS  (Deepgram Aura-2 FR  |  Azure Neural FR fallback)
                      │  audio frames
                      ▼
                 transport.output ──RTP──▶ phone

Design rules for this module:
  * NO business logic, NO prompts here — only I/O orchestration. Every
    conversational decision is made by the backend brain.
  * The TRANSPORT is abstract/injectable (`VoiceTransport`) so tests run
    against a mock with no live SIP/WebSocket connection.
  * The STT/TTS provider PLUGINS are attached lazily behind TODO(creds)
    seams: importing them at module load needs API keys (and the
    deepgram-sdk pinned here cannot import the STT plugin), so we never do
    it at import time. `build_pipeline()` is where real creds wire in.

ENV (see .env.template):
  DEEPGRAM_API_KEY  — powers BOTH Deepgram STT and Deepgram TTS.
  TTS_PROVIDER      — "deepgram" (default) | "azure".  Ridaa consolidated on
                      Deepgram for billing simplicity; Azure is fallback only.
  AZURE_SPEECH_KEY / AZURE_SPEECH_REGION — only read when TTS_PROVIDER=azure.

NOTE: this repo's `.env.template` is updated in tandem. If template edits are
ever blocked, the env contract above is the source of truth.
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from enum import StrEnum
from typing import TYPE_CHECKING, Protocol, runtime_checkable

from pipecat.frames.frames import Frame, TextFrame, TranscriptionFrame
from pipecat.processors.frame_processor import FrameDirection, FrameProcessor

from f16_pipecat.backend import F16BackendClient
from f16_pipecat.logging import logger

if TYPE_CHECKING:  # pragma: no cover - typing only
    from pipecat.pipeline.pipeline import Pipeline


# --------------------------------------------------------------------------
# Config
# --------------------------------------------------------------------------


class TtsProvider(StrEnum):
    """Which TTS engine the pipeline speaks with."""

    DEEPGRAM = "deepgram"
    AZURE = "azure"


# Locked French model identifiers (per project_voice_stack memory).
DEEPGRAM_STT_MODEL_FR = "nova-3"
DEEPGRAM_TTS_MODEL_FR = "aura-2-thalia-fr"  # Aura-2 French voice
AZURE_TTS_VOICE_FR = "fr-FR-DeniseNeural"
PIPELINE_LANGUAGE = "fr"


@dataclass(slots=True)
class VoicePipelineConfig:
    """Immutable selection of STT/TTS engines + language for one call.

    Built from env via `from_env()`. STT is always Deepgram Nova-3 FR; TTS
    defaults to Deepgram (Aura-2 FR) and falls back to Azure Neural FR only
    when `TTS_PROVIDER=azure`.
    """

    language: str = PIPELINE_LANGUAGE
    stt_model: str = DEEPGRAM_STT_MODEL_FR
    tts_provider: TtsProvider = TtsProvider.DEEPGRAM
    deepgram_tts_model: str = DEEPGRAM_TTS_MODEL_FR
    azure_tts_voice: str = AZURE_TTS_VOICE_FR
    # Credentials are read but never logged.
    deepgram_api_key: str = field(default="", repr=False)
    azure_speech_key: str = field(default="", repr=False)
    azure_speech_region: str = field(default="westeurope", repr=False)

    @classmethod
    def from_env(cls) -> VoicePipelineConfig:
        raw = os.environ.get("TTS_PROVIDER", TtsProvider.DEEPGRAM.value).strip().lower()
        try:
            provider = TtsProvider(raw)
        except ValueError:
            logger.warning(f"voice: unknown TTS_PROVIDER={raw!r}; defaulting to deepgram")
            provider = TtsProvider.DEEPGRAM
        return cls(
            tts_provider=provider,
            deepgram_api_key=os.environ.get("DEEPGRAM_API_KEY", ""),
            azure_speech_key=os.environ.get("AZURE_SPEECH_KEY", ""),
            azure_speech_region=os.environ.get("AZURE_SPEECH_REGION", "westeurope"),
        )

    @property
    def uses_azure_fallback(self) -> bool:
        return self.tts_provider is TtsProvider.AZURE


# --------------------------------------------------------------------------
# Transport seam (abstract / injectable — no live SIP in tests)
# --------------------------------------------------------------------------


@runtime_checkable
class VoiceTransport(Protocol):
    """Minimal transport contract the pipeline needs.

    Real implementation wraps the OVH-SIP <-> Pipecat audio bridge
    (e.g. a websocket / RTP transport). Tests supply a mock object that
    satisfies this Protocol without opening any socket.
    """

    def input(self) -> FrameProcessor:
        """Upstream source: audio frames coming FROM the caller."""
        ...

    def output(self) -> FrameProcessor:
        """Downstream sink: audio frames going TO the caller."""
        ...


# --------------------------------------------------------------------------
# Backend turn processor (the one custom processor — still no business logic)
# --------------------------------------------------------------------------


class BackendTurnProcessor(FrameProcessor):
    """Bridges STT output to the backend brain and the brain's reply to TTS.

    On each finalized `TranscriptionFrame` it POSTs the transcript to the
    backend `/v1/voice/turn` and pushes the returned reply downstream as a
    `TextFrame` for the TTS service to speak. All other frames pass through
    untouched. The processor holds NO conversational state — session
    identity (sessionId/leadId/customerId) is fixed for the call's lifetime.
    """

    def __init__(
        self,
        *,
        backend: F16BackendClient,
        session_id: str,
        lead_id: str,
        customer_id: str,
        only_finalized: bool = True,
    ) -> None:
        super().__init__()
        self._backend = backend
        self._session_id = session_id
        self._lead_id = lead_id
        self._customer_id = customer_id
        self._only_finalized = only_finalized

    async def process_frame(self, frame: Frame, direction: FrameDirection) -> None:
        await super().process_frame(frame, direction)

        if isinstance(frame, TranscriptionFrame):
            # STT may emit interim + final frames; only act on finals to
            # avoid POSTing partial utterances to the brain.
            if self._only_finalized and not getattr(frame, "finalized", True):
                await self.push_frame(frame, direction)
                return
            await self._handle_transcript(frame.text, direction)
            return

        # Anything else (audio, control) flows through unchanged.
        await self.push_frame(frame, direction)

    async def _handle_transcript(self, transcript: str, direction: FrameDirection) -> None:
        result = await self._backend.turn(
            session_id=self._session_id,
            lead_id=self._lead_id,
            customer_id=self._customer_id,
            transcript=transcript,
        )
        logger.info(
            f"voice-pipeline: session={self._session_id} state={result.session_state} "
            f"reply_chars={len(result.reply_text)}"
        )
        # Push the brain's reply downstream for TTS to vocalize.
        await self.push_frame(TextFrame(result.reply_text), direction)


# --------------------------------------------------------------------------
# Pipeline assembly
# --------------------------------------------------------------------------


def build_stt_service(config: VoicePipelineConfig) -> FrameProcessor:
    """Construct the Deepgram Nova-3 FR STT processor.

    TODO(creds): wire the real plugin once DEEPGRAM_API_KEY is provisioned
    AND deepgram-sdk is aligned with pipecat's STT client. The currently
    pinned deepgram-sdk cannot import `DeepgramSTTService`
    (missing `AsyncDeepgramClient`), so this import is intentionally lazy
    and guarded — it MUST NOT run at module import time or in tests.

        from pipecat.services.deepgram.stt import DeepgramSTTService
        from pipecat.transcriptions.language import Language
        return DeepgramSTTService(
            api_key=config.deepgram_api_key,
            model=config.stt_model,          # nova-3
            language=Language.FR,
        )
    """
    raise NotImplementedError(
        "TODO(creds): attach DeepgramSTTService once DEEPGRAM_API_KEY + "
        "deepgram-sdk alignment are in place. See build_stt_service docstring."
    )


def build_tts_service(config: VoicePipelineConfig) -> FrameProcessor:
    """Construct the TTS processor for the configured provider.

    TODO(creds): both branches need live keys. Imports are lazy so config
    selection (the part under test) never requires credentials.

    Deepgram (default):
        from pipecat.services.deepgram.tts import DeepgramTTSService
        return DeepgramTTSService(
            api_key=config.deepgram_api_key,
            voice=config.deepgram_tts_model,   # aura-2 FR
        )

    Azure (fallback, TTS_PROVIDER=azure):
        from pipecat.services.azure.tts import AzureTTSService
        return AzureTTSService(
            api_key=config.azure_speech_key,
            region=config.azure_speech_region,
            voice=config.azure_tts_voice,      # fr-FR-DeniseNeural
        )
    """
    raise NotImplementedError(
        f"TODO(creds): attach {config.tts_provider.value} TTS service. "
        "See build_tts_service docstring for the exact constructor."
    )


def build_pipeline(
    *,
    config: VoicePipelineConfig,
    transport: VoiceTransport,
    backend: F16BackendClient,
    session_id: str,
    lead_id: str,
    customer_id: str,
) -> Pipeline:
    """Assemble the cascaded pipeline:

        transport.input → STT → BackendTurnProcessor → TTS → transport.output

    The transport + backend are injected (tests pass mocks). STT/TTS are
    real Pipecat services attached behind TODO(creds) seams. The processor
    chain shape itself is fully exercised in tests; only the live provider
    plugins require credentials to instantiate.
    """
    from pipecat.pipeline.pipeline import Pipeline

    turn_processor = BackendTurnProcessor(
        backend=backend,
        session_id=session_id,
        lead_id=lead_id,
        customer_id=customer_id,
    )
    stages: list[FrameProcessor] = [
        transport.input(),
        build_stt_service(config),  # TODO(creds)
        turn_processor,
        build_tts_service(config),  # TODO(creds)
        transport.output(),
    ]
    return Pipeline(stages)


__all__ = [
    "AZURE_TTS_VOICE_FR",
    "DEEPGRAM_STT_MODEL_FR",
    "DEEPGRAM_TTS_MODEL_FR",
    "BackendTurnProcessor",
    "TtsProvider",
    "VoicePipelineConfig",
    "VoiceTransport",
    "build_pipeline",
    "build_stt_service",
    "build_tts_service",
]
