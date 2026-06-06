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

from pipecat.frames.frames import (
    Frame,
    InputAudioRawFrame,
    InterimTranscriptionFrame,
    InterruptionFrame,
    TranscriptionFrame,
    TTSSpeakFrame,
)
from pipecat.processors.frame_processor import FrameDirection, FrameProcessor

from f16_pipecat.backend import F16BackendClient
from f16_pipecat.logging import logger


class _VoiceDebugTap(FrameProcessor):
    """Pass-through probe that counts audio frames + logs STT transcripts.

    Inserted around the STT service only when F16_VOICE_TAP is set, so we can see
    on a live call whether audio actually reaches the STT (and at what rate) and
    whether the STT emits any (interim/final) transcripts. Off by default.
    """

    def __init__(self, label: str) -> None:
        super().__init__()
        self._label = label
        self._audio = 0

    async def process_frame(self, frame: Frame, direction: FrameDirection) -> None:
        await super().process_frame(frame, direction)
        if isinstance(frame, InputAudioRawFrame):
            self._audio += 1
            if self._audio == 1 or self._audio % 250 == 0:
                logger.info(
                    f"voice-tap[{self._label}]: audio_frames={self._audio} "
                    f"rate={frame.sample_rate} ch={frame.num_channels} bytes={len(frame.audio)}"
                )
        elif isinstance(frame, (TranscriptionFrame, InterimTranscriptionFrame)):
            kind = "FINAL" if isinstance(frame, TranscriptionFrame) else "interim"
            logger.info(f"voice-tap[{self._label}]: {kind} transcript={frame.text!r}")
        await self.push_frame(frame, direction)


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

# Greeting spoken the moment the call is answered (proves the outbound audio
# path immediately and gives the caller a prompt to speak). Overridable via
# F16_VOICE_GREETING; set it empty to disable the greeting. Assuryal is the
# consumer brand the agent speaks as.
DEFAULT_VOICE_GREETING_FR = (
    "Bonjour, ici l'assistante d'Assuryal. Comment puis-je vous aider aujourd'hui ?"
)


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
    greeting_text: str = DEFAULT_VOICE_GREETING_FR
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
            greeting_text=os.environ.get("F16_VOICE_GREETING", DEFAULT_VOICE_GREETING_FR),
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
        # Finalized fragments of the CURRENT utterance, flushed to the brain on
        # end-of-speech (Deepgram `speech_final`). See process_frame.
        self._utterance_parts: list[str] = []

    async def process_frame(self, frame: Frame, direction: FrameDirection) -> None:
        await super().process_frame(frame, direction)

        # Barge-in: when the caller talks over the bot, the VAD turn subsystem
        # broadcasts an InterruptionFrame. Drop any half-accumulated fragments
        # from the PRIOR (now-abandoned) utterance so the next speech_final
        # flush is the fresh interrupting utterance only.
        if isinstance(frame, InterruptionFrame):
            self._utterance_parts = []
            await self.push_frame(frame, direction)
            return

        if isinstance(frame, TranscriptionFrame):
            # Deepgram emits MULTIPLE finalized fragments per spoken utterance
            # (one per `is_final` segment, e.g. on each micro-pause). Firing the
            # brain on every fragment produced several OVERLAPPING replies for one
            # thing the caller said — the "racing reply that jumps the line" +
            # clipped words as each reply interrupted the last. Instead we
            # ACCUMULATE fragments and invoke the brain ONCE per utterance, when
            # Deepgram signals end-of-speech via `speech_final` (driven by the STT
            # `endpointing` window). Interim results arrive as the separate
            # `InterimTranscriptionFrame` class and pass through below.
            fragment = (frame.text or "").strip()
            if fragment:
                self._utterance_parts.append(fragment)
            # If the frame carries no Deepgram result (non-Deepgram STT / tests),
            # fall back to flushing immediately so we never strand an utterance.
            result = frame.result
            speech_final = (
                bool(getattr(result, "speech_final", False)) if result is not None else True
            )
            if speech_final and self._utterance_parts:
                utterance = " ".join(self._utterance_parts)
                self._utterance_parts = []
                await self._handle_transcript(utterance, direction)
            return

        # Anything else (audio, control) flows through unchanged.
        await self.push_frame(frame, direction)

    async def _handle_transcript(self, transcript: str, direction: FrameDirection) -> None:
        import time

        _t0 = time.monotonic()
        result = await self._backend.turn(
            session_id=self._session_id,
            lead_id=self._lead_id,
            customer_id=self._customer_id,
            transcript=transcript,
        )
        _backend_ms = int((time.monotonic() - _t0) * 1000)
        logger.info(
            f"voice-pipeline: session={self._session_id} state={result.session_state} "
            f"reply_chars={len(result.reply_text)} backend_round_trip_ms={_backend_ms}"
        )
        # Push the brain's reply downstream for TTS to vocalize. We use
        # TTSSpeakFrame (NOT a bare TextFrame): TextFrames are buffered by the
        # TTS sentence aggregator until an end-of-turn signal that we never send
        # here, so the reply would never be synthesized. TTSSpeakFrame forces
        # immediate synthesis — the same mechanism the on-answer greeting uses.
        await self.push_frame(TTSSpeakFrame(result.reply_text), direction)


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
            # ~300 ms of silence ends the utterance (sets `speech_final`), which
            # the BackendTurnProcessor uses to fire the brain ONCE per turn.
            # Low enough to feel responsive, high enough not to chop mid-sentence.
            endpointing=300,
            # Spoken numbers → digits ("deux cents euros" → "200 euros"). The
            # quoting funnel is number-heavy (price, date, value) and Deepgram
            # mishears spelled-out French numbers over 8 kHz telephony; numerals
            # makes the transcript the backend brain sees consistent with digits.
            numerals=True,
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


def build_vad_turn_stages() -> list[FrameProcessor]:
    """VAD + user-turn processors that give BARGE-IN on the live telephony leg.

    Returns ``[VADProcessor, UserTurnProcessor]`` to splice in right after
    ``transport.input()`` (they run on raw 8 kHz audio, BEFORE the STT). The
    ``VADProcessor`` runs Silero VAD on each frame and emits VAD speech
    start/stop frames; the ``UserTurnProcessor`` consumes the VAD-start via
    ``VADUserTurnStartStrategy`` and — because ``enable_interruptions`` defaults
    to True — broadcasts a ``StartInterruptionFrame`` the moment the caller
    starts talking, cutting the bot's TTS off (the barge-in Ridaa asked for).
    Both processors pass audio through, so the STT downstream still sees it.

    Gated by ``F16_VOICE_VAD`` (default ON) so barge-in can be disabled live
    without a code change. Silero needs onnxruntime (pipecat ``silero`` extra);
    imports stay LAZY so this module imports without it and the test suite never
    loads the model. If the deps are missing we log + return ``[]`` so the call
    degrades to STT-event turn-taking (no barge-in) rather than failing.
    """
    if os.environ.get("F16_VOICE_VAD", "1").strip().lower() in ("0", "false", "no", "off"):
        logger.info("voice: VAD barge-in disabled (F16_VOICE_VAD)")
        return []
    try:
        from pipecat.audio.vad.silero import SileroVADAnalyzer
        from pipecat.audio.vad.vad_analyzer import VADParams
        from pipecat.processors.audio.vad_processor import VADProcessor
        from pipecat.turns.user_start.vad_user_turn_start_strategy import (
            VADUserTurnStartStrategy,
        )
        from pipecat.turns.user_stop.speech_timeout_user_turn_stop_strategy import (
            SpeechTimeoutUserTurnStopStrategy,
        )
        from pipecat.turns.user_turn_processor import UserTurnProcessor
        from pipecat.turns.user_turn_strategies import UserTurnStrategies

        from f16_pipecat.audiosocket import AUDIOSOCKET_SAMPLE_RATE
    except ImportError as exc:  # pragma: no cover - dep-availability guard
        logger.warning(f"voice: VAD deps unavailable ({exc}); barge-in disabled")
        return []

    # Telephony-tuned VAD for the 8 kHz slin PSTN leg: short stop window for a
    # snappy end-of-turn; confidence/min_volume raised a touch so PSTN line
    # noise doesn't false-trigger a turn.
    vad = SileroVADAnalyzer(
        sample_rate=AUDIOSOCKET_SAMPLE_RATE,
        params=VADParams(confidence=0.7, start_secs=0.2, stop_secs=0.3, min_volume=0.6),
    )
    user_turn = UserTurnProcessor(
        user_turn_strategies=UserTurnStrategies(
            start=[VADUserTurnStartStrategy()],  # enable_interruptions=True (default)
            stop=[SpeechTimeoutUserTurnStopStrategy(user_speech_timeout=0.6)],
        ),
    )
    logger.info("voice: VAD barge-in enabled (Silero @ 8 kHz, stop_secs=0.3)")
    return [VADProcessor(vad_analyzer=vad), user_turn]


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
    stt_service = build_stt_service(config)  # Deepgram Nova-3 FR
    stages: list[FrameProcessor] = [transport.input()]
    # VAD + user-turn processors (barge-in) run on raw audio BEFORE the STT.
    stages += build_vad_turn_stages()
    if os.environ.get("F16_VOICE_TAP"):
        # Probe audio-into-STT and transcripts-out-of-STT on a live call.
        stages += [_VoiceDebugTap("pre-stt"), stt_service, _VoiceDebugTap("post-stt")]
    else:
        stages.append(stt_service)
    stages += [
        turn_processor,
        build_tts_service(config),  # Deepgram Aura-2 FR | Azure Neural FR
        transport.output(),
    ]
    return Pipeline(stages)


__all__ = [
    "AZURE_TTS_VOICE_FR",
    "DEEPGRAM_STT_MODEL_FR",
    "DEEPGRAM_TTS_MODEL_FR",
    "DEFAULT_VOICE_GREETING_FR",
    "BackendTurnProcessor",
    "TtsProvider",
    "VoicePipelineConfig",
    "VoiceTransport",
    "build_pipeline",
    "build_stt_service",
    "build_tts_service",
    "build_vad_turn_stages",
]
