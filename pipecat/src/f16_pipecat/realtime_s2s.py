"""Speech-to-speech voice pipeline (M10 V2 POC) — OpenAI gpt-realtime.

Replaces the cascaded STT → backend → TTS pipeline (~3-4s latency floor) with a
single OpenAI Realtime speech-to-speech model that listens, thinks, speaks AND
handles turn-taking/barge-in in one streaming connection (~0.8s time-to-first-
audio). The model drives the live conversation; the F16 backend stays the BRAIN
via async function-calls (added in step 2 — see `register_backend_tools`).

Gated by env `F16_VOICE_S2S=1` (the runner branches to this instead of the
cascade). Reuses the SAME OVH → Asterisk → AudioSocket → Pipecat transport we
already debugged — only the middle (STT/LLM/TTS nodes) is swapped.

AUDIO: the AudioSocket leg is 8 kHz. We negotiate g711 μ-law (PCMU, 8 kHz) with
OpenAI so both ends are telephony-native and no 8k↔24k resampling is needed.
(This is the #1 thing to confirm on the first live call; if it misbehaves, fall
back to PCM and let Pipecat's MediaSender resample.)

ENV:
  OPENAI_API_KEY        — platform.openai.com key WITH Realtime access (billing on)
  F16_VOICE_S2S         — "1" to enable this path (read by runner)
  F16_VOICE_S2S_MODEL   — default "gpt-realtime"
  F16_VOICE_S2S_VOICE   — default "marin" (OpenAI realtime voice id)
"""

from __future__ import annotations

import os
from typing import TYPE_CHECKING

from f16_pipecat.logging import logger

if TYPE_CHECKING:  # pragma: no cover - typing only
    from pipecat.pipeline.pipeline import Pipeline

    from f16_pipecat.pipeline import VoiceTransport

DEFAULT_S2S_MODEL = "gpt-realtime"
DEFAULT_S2S_VOICE = "marin"


def s2s_enabled() -> bool:
    """True when the speech-to-speech path is turned on via env."""
    return os.environ.get("F16_VOICE_S2S", "0").strip().lower() in ("1", "true", "yes", "on")


def _build_instructions(first_name: str | None) -> str:
    """The French Sales Agent persona, expressed as OpenAI Realtime session
    instructions. In S2S the conversation logic lives HERE (plus tools), so this
    ports the WhatsApp Sales Agent's persona + qualifying goal into a spoken,
    low-latency brief. Anything regulated or stateful (quoting, compliance,
    saving data) is delegated to backend tools, not improvised here.
    """
    who = f" Le client s'appelle {first_name}." if first_name else ""
    return (
        "Tu es l'assistante commerciale d'Assuryal, un courtier d'assurance français."
        f"{who} Tu appelles le client pour l'aider à assurer sa trottinette électrique "
        "et préparer un devis.\n\n"
        "STYLE ORAL (CRITIQUE — tu es au téléphone, en direct) :\n"
        "- Parle en français naturel, chaleureux et concis, comme une vraie conseillère.\n"
        "- UNE phrase courte à la fois, UNE seule question directe. Jamais de listes.\n"
        "- Pas de monologue : laisse le client répondre, et rebondis brièvement.\n"
        "- Si le client te coupe, arrête-toi et écoute.\n\n"
        "OBJECTIF — qualifier le lead, en récoltant une info à la fois :\n"
        "1) confirmer qu'il veut assurer une trottinette ; 2) le prix d'achat ; "
        "3) la date d'achat ; 4) où il la gare la nuit ; 5) son usage (quotidien ?).\n"
        "Reste sur ce fil. Ne donne PAS de prix de devis toi-même ni de conseil "
        "réglementé : pour un devis ou une garantie précise, dis que tu prépares ça "
        "et (plus tard) utilise les outils prévus. Commence par saluer brièvement."
    )


def build_s2s_pipeline(
    *,
    transport: VoiceTransport,
    session_id: str,
    lead_id: str,
    customer_id: str,
    first_name: str | None = None,
) -> tuple[Pipeline, object]:
    """Assemble the speech-to-speech pipeline:

        transport.input() → OpenAIRealtimeLLMService → transport.output()

    The Realtime service owns STT+LLM+TTS+turn-detection internally. Returns
    (pipeline, llm_service) so the caller can register backend tools + trigger the
    opening line. Imports are LAZY so importing this module never needs the
    OpenAI SDK; constructing the service stores config only (no socket until run).
    """
    from pipecat.pipeline.pipeline import Pipeline
    from pipecat.services.openai.realtime.events import (
        AudioConfiguration,
        AudioInput,
        AudioOutput,
        InputAudioTranscription,
        PCMAudioFormat,
        SessionProperties,
        TurnDetection,
    )
    from pipecat.services.openai.realtime.llm import OpenAIRealtimeLLMService

    api_key = os.environ.get("OPENAI_API_KEY", "")
    if not api_key:
        raise RuntimeError("OPENAI_API_KEY missing — required for the S2S voice path")

    model = os.environ.get("F16_VOICE_S2S_MODEL", DEFAULT_S2S_MODEL)
    voice = os.environ.get("F16_VOICE_S2S_VOICE", DEFAULT_S2S_VOICE)

    session = SessionProperties(
        instructions=_build_instructions(first_name),
        output_modalities=["audio"],
        audio=AudioConfiguration(
            input=AudioInput(
                # Linear PCM — matches the slin the AudioSocket transport produces.
                # (g711 μ-law was rejected-equivalent: the model received PCM bytes
                # labelled μ-law → garbage → no speech detected → no reply. Pipecat
                # handles any 8k↔OpenAI-rate resampling.)
                format=PCMAudioFormat(),
                # Server-side VAD = OpenAI detects end-of-turn + lets the caller
                # barge-in (interrupt) the agent. This is the built-in smooth
                # turn-taking that the cascade lacked.
                turn_detection=TurnDetection(
                    type="server_vad",
                    threshold=0.5,
                    prefix_padding_ms=300,
                    silence_duration_ms=500,
                ),
                # Transcribe the caller's audio too (for our thread/dump-thread
                # logging + later persistence); does not affect the spoken reply.
                transcription=InputAudioTranscription(model="whisper-1", language="fr"),
            ),
            output=AudioOutput(format=PCMAudioFormat(), voice=voice),
        ),
    )

    # NOTE on the model in the URL: the service itself appends `?model=<model>` to
    # base_url (see OpenAIRealtimeLLMService.__init__: full_url = f"{base_url}?model=…").
    # So we must NOT pass base_url already containing ?model= (that double-appends
    # AND the wss URL then leaks into the parent's REST client → "Invalid URL POST
    # /v1/engines/…"). Pass only api_key + model; let the service build the WS URL.
    llm = OpenAIRealtimeLLMService(api_key=api_key, model=model, session_properties=session)

    logger.info(
        f"voice-s2s: built OpenAI Realtime pipeline session={session_id} "
        f"model={model} voice={voice} (pcm 24k; service appends ?model=)"
    )
    pipeline = Pipeline([transport.input(), llm, transport.output()])
    return pipeline, llm


__all__ = ["s2s_enabled", "build_s2s_pipeline", "DEFAULT_S2S_MODEL", "DEFAULT_S2S_VOICE"]
