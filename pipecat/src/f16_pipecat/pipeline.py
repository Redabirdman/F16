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
  * The STT/TTS provider PLUGINS are constructed lazily inside the
    `build_*_service()` builders — the speech SDKs (deepgram-sdk, azure) are
    imported INSIDE the builders, so importing this module never drags them in.
    The builders read API keys from config and instantiate the real Pipecat
    services (construction is offline; no socket opens until the pipeline runs).

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
# Deepgram Aura-2 French female voice. Per Deepgram's TTS model catalog the
# only Aura-2 FRENCH voices are `aura-2-agathe-fr` (female) and
# `aura-2-hector-fr` (male); Agathe is the natural-female default we speak with.
# (The older "aura-2-thalia-fr" id is invalid — Thalia is an English-only voice.)
DEEPGRAM_TTS_MODEL_FR = "aura-2-agathe-fr"
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

    Returns a live `DeepgramSTTService` configured for French Nova-3. The API
    key is read from config (never hardcoded); model + language are passed via
    pipecat's `Settings` object (the canonical API in 1.3.0).

    Imports stay LAZY (inside the function) so importing this module never
    requires the speech SDKs — only constructing a service does. Construction
    itself stores config and does NOT open any network connection.
    """
    from pipecat.services.deepgram.stt import DeepgramSTTService
    from pipecat.transcriptions.language import Language

    return DeepgramSTTService(
        api_key=config.deepgram_api_key,
        settings=DeepgramSTTService.Settings(
            model=config.stt_model,  # nova-3
            language=Language.FR,
        ),
    )


def build_tts_service(config: VoicePipelineConfig) -> FrameProcessor:
    """Construct the TTS processor for the configured provider.

    Deepgram (default): `DeepgramTTSService` speaking the Aura-2 French voice
    (`DEEPGRAM_TTS_MODEL_FR` = aura-2-agathe-fr). Azure (fallback, when
    TTS_PROVIDER=azure): `AzureTTSService` with fr-FR-DeniseNeural in the
    configured region.

    API keys are read from config (never hardcoded). Imports stay LAZY so the
    module imports without the speech SDKs; construction stores config only and
    performs no network I/O.
    """
    if config.tts_provider is TtsProvider.AZURE:
        from pipecat.services.azure.tts import AzureTTSService

        return AzureTTSService(
            api_key=config.azure_speech_key,
            region=config.azure_speech_region,
            settings=AzureTTSService.Settings(
                voice=config.azure_tts_voice,  # fr-FR-DeniseNeural
            ),
        )

    from pipecat.services.deepgram.tts import DeepgramTTSService

    return DeepgramTTSService(
        api_key=config.deepgram_api_key,
        settings=DeepgramTTSService.Settings(
            voice=config.deepgram_tts_model,  # aura-2-agathe-fr
        ),
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
    real Pipecat services built by the `build_*_service()` helpers; they read
    API keys from `config` and construct offline (no socket until the pipeline
    runs). The processor chain shape is fully exercised in tests.
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
        build_stt_service(config),  # Deepgram Nova-3 FR
        turn_processor,
        build_tts_service(config),  # Deepgram Aura-2 FR | Azure Neural FR
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
