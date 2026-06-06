"""Per-call runner: drive the cascaded pipeline for one Asterisk AudioSocket leg.

This is the entrypoint the AudioSocket TCP server (`audiosocket.handle_connection`)
calls once it has read the 16-byte call UUID (== sessionId) from the connection.
It:

  1. resolves the call's F16 identity (leadId/customerId) — either from the
     explicit args or by looking the session up in the backend
     (GET /v1/voice/session/{sessionId}),
  2. builds the AudioSocket transport bound to this connection's reader/writer
     (8 kHz slin mono),
  3. builds the F16 backend client + the cascaded pipeline
     (transport.input → STT → BackendTurnProcessor → TTS → transport.output),
  4. runs it to completion (the transport's read loop sets an "ended" event on
     TERMINATE/EOF, which stops the pipeline), and
  5. tears everything down (closes the backend client) when the call ends.

NO business logic lives here — the brain is the backend. This module is pure
lifecycle wiring. Heavy pipecat imports are LAZY so importing the module (e.g.
from the app at boot) stays light.
"""

from __future__ import annotations

import asyncio
from typing import TYPE_CHECKING

from f16_pipecat.audiosocket import AUDIOSOCKET_SAMPLE_RATE, build_audiosocket_transport
from f16_pipecat.logging import logger

if TYPE_CHECKING:  # pragma: no cover - typing only
    from f16_pipecat.backend import F16BackendClient
    from f16_pipecat.pipeline import VoicePipelineConfig


class MissingCallMetadataError(RuntimeError):
    """Raised when a call's F16 identity (lead/customer) cannot be resolved."""


async def run_audiosocket_call(
    reader: asyncio.StreamReader,
    writer: asyncio.StreamWriter,
    *,
    session_id: str,
    lead_id: str | None = None,
    customer_id: str | None = None,
    config: VoicePipelineConfig | None = None,
    backend: F16BackendClient | None = None,
) -> None:
    """Run the full cascaded pipeline for one AudioSocket call to completion.

    `session_id` is the call UUID Asterisk sent in its first frame. `lead_id` /
    `customer_id` may be passed explicitly (tests / future callers); when absent
    they are resolved via `backend.get_session(session_id)`.

    `backend` and `config` are injectable for tests; in production they default
    to env-built instances. The backend client is closed on exit ONLY when we
    built it ourselves (an injected client is left for the caller to manage).

    Heavy pipecat imports are deferred to inside this function.
    """
    from f16_pipecat.backend import F16BackendClient
    from f16_pipecat.pipeline import VoicePipelineConfig, build_pipeline

    cfg = config or VoicePipelineConfig.from_env()
    owns_backend = backend is None
    client = backend or F16BackendClient.from_env()

    try:
        lid, cid = await _resolve_identity(
            client, session_id=session_id, lead_id=lead_id, customer_id=customer_id
        )

        # Event the transport's read loop sets on TERMINATE/EOF so we can stop.
        call_ended = asyncio.Event()
        transport = build_audiosocket_transport(reader, writer, call_ended=call_ended)

        from f16_pipecat.realtime_s2s import build_s2s_pipeline, s2s_enabled

        if s2s_enabled():
            # SPEECH-TO-SPEECH path (M10 V2 POC): one OpenAI Realtime model owns
            # STT+LLM+TTS+turn-taking. No greeting frame — this is an OUTBOUND
            # call, so the callee answers ("Allô ?") and the model's server-VAD
            # responds with its opening line. Backend stays the brain via tools
            # (added next increment).
            pipeline, _llm = build_s2s_pipeline(
                transport=transport,
                session_id=session_id,
                lead_id=lid,
                customer_id=cid,
                first_name=None,
            )
            logger.info(f"voice-runner: starting S2S call session={session_id}")
            # Make the bot speak first: it's an outbound call (callee just said
            # "Allô"), and the opening also primes the AudioSocket so inbound audio
            # flows. The model follows its session instructions (Assuryal persona).
            await _run_pipeline_to_completion(
                pipeline,
                call_ended,
                opening_messages=[
                    {
                        "role": "user",
                        "content": (
                            "[L'appel vient d'être décroché par le client.] "
                            "Présente-toi en une phrase et demande comment tu peux aider."
                        ),
                    }
                ],
            )
        else:
            pipeline = build_pipeline(
                config=cfg,
                transport=transport,
                backend=client,
                session_id=session_id,
                lead_id=lid,
                customer_id=cid,
            )

            logger.info(
                f"voice-runner: starting call session={session_id} "
                f"rate={AUDIOSOCKET_SAMPLE_RATE} tts={cfg.tts_provider.value} "
                f"greeting_chars={len(cfg.greeting_text)}"
            )
            await _run_pipeline_to_completion(pipeline, call_ended, greeting_text=cfg.greeting_text)
    finally:
        logger.info(f"voice-runner: call ended session={session_id}")
        if owns_backend:
            await client.aclose()


async def _resolve_identity(
    client: F16BackendClient,
    *,
    session_id: str,
    lead_id: str | None,
    customer_id: str | None,
) -> tuple[str, str]:
    """Return (lead_id, customer_id), looking them up in the backend if needed."""
    if lead_id and customer_id:
        return lead_id, customer_id
    from f16_pipecat.backend import BackendSessionError

    try:
        session = await client.get_session(session_id)
    except BackendSessionError as exc:
        raise MissingCallMetadataError(
            f"session lookup failed for session={session_id}: {exc}"
        ) from exc
    return session.lead_id, session.customer_id


async def _run_pipeline_to_completion(
    pipeline: object,
    call_ended: asyncio.Event,
    *,
    greeting_text: str = "",
    opening_messages: list[dict[str, str]] | None = None,
) -> None:
    """Build the worker + runner and block until the call's pipeline ends.

    The pipeline runs until the transport surfaces a terminal frame
    (AudioSocket TERMINATE/EOF → the input read loop sets `call_ended`, and the
    transport disconnect drives an EndFrame through the pipeline). We race the
    runner against `call_ended` so a peer hangup promptly tears the call down.

    SAMPLE RATE (critical): the AudioSocket leg is 8 kHz slin. The worker stamps
    the StartFrame with `PipelineParams.audio_in/out_sample_rate`, and every
    service that wasn't pinned a rate (notably Deepgram STT/TTS) inherits it from
    that StartFrame. PipelineParams DEFAULTS are 16 kHz in / 24 kHz out, so
    leaving them unset opened the Deepgram STT socket at 16 kHz while the
    transport fed it 8 kHz audio → garbled → no transcript → silence. We pin both
    to the AudioSocket rate so STT/TTS agree with the transport.

    GREETING: when `greeting_text` is non-empty we queue a `TTSSpeakFrame` the
    moment the pipeline starts (StartFrame reaches the sink), so the bot speaks
    on answer — proving the outbound audio path and prompting the caller.

    Interruption handling (barge-in): a Silero VAD + UserTurnProcessor pair is
    spliced into the pipeline right after transport.input() by
    `pipeline.build_vad_turn_stages()` (gated by F16_VOICE_VAD, default on). The
    VAD detects the caller starting to speak and the turn processor broadcasts a
    StartInterruptionFrame, cutting the bot's TTS off — crisp barge-in on the
    live SIP leg. When VAD is disabled/unavailable the call still runs, just
    without barge-in.
    """
    from pipecat.frames.frames import OutputAudioRawFrame, TTSSpeakFrame
    from pipecat.pipeline.worker import PipelineParams, PipelineWorker
    from pipecat.workers.runner import WorkerRunner

    # PipelineWorker is the non-deprecated successor to PipelineTask in 1.3.0.
    # Pin the StartFrame rates to the 8 kHz AudioSocket leg (see docstring).
    worker = PipelineWorker(
        pipeline,  # type: ignore[arg-type]
        params=PipelineParams(
            audio_in_sample_rate=AUDIOSOCKET_SAMPLE_RATE,
            audio_out_sample_rate=AUDIOSOCKET_SAMPLE_RATE,
        ),
    )

    if opening_messages:
        # SPEECH-TO-SPEECH greeting: the realtime model has no TTSSpeakFrame path,
        # so we trigger it to SPEAK FIRST by appending an opening instruction and
        # running the LLM. This also primes the AudioSocket: Asterisk only streams
        # inbound audio once the bridge sees outbound media, so the bot greeting
        # (vs. the cascade's TTS greeting) is what gets the caller's audio flowing.
        @worker.event_handler("on_pipeline_started")  # type: ignore[untyped-decorator]
        async def _open(w: PipelineWorker, _frame: object) -> None:  # noqa: ANN401
            # PRIME the AudioSocket: write ~0.5 s of outbound silence so Asterisk
            # sees outbound media and starts streaming the caller's mic audio
            # inbound. (Cascade works only because its TTS greeting writes audio
            # out immediately; S2S writes nothing until the model speaks → Asterisk
            # never sends us inbound → 0 frames. This breaks that chicken-and-egg.)
            silence = b"\x00" * (AUDIOSOCKET_SAMPLE_RATE // 50 * 2)  # 20 ms slin
            for _ in range(25):
                await w.queue_frame(
                    OutputAudioRawFrame(
                        audio=silence,
                        sample_rate=AUDIOSOCKET_SAMPLE_RATE,
                        num_channels=1,
                    )
                )
            # NOTE: we do NOT trigger a "speak first" here. The realtime model
            # replies to the caller's first words via server-VAD over the
            # websocket. (An LLMMessagesAppendFrame(run_llm=True) would route to a
            # REST completion → "Invalid URL /v1/engines/…" since base_url is wss.)
            logger.info("voice-runner: S2S — primed AudioSocket; model replies on caller speech")
            _ = opening_messages  # reserved for a future websocket-based greeting

    elif greeting_text:

        @worker.event_handler("on_pipeline_started")  # type: ignore[untyped-decorator]
        async def _greet(w: PipelineWorker, _frame: object) -> None:  # noqa: ANN401
            logger.info(f"voice-runner: greeting on answer ({len(greeting_text)} chars)")
            await w.queue_frame(TTSSpeakFrame(greeting_text))

    runner = WorkerRunner(handle_sigint=False)
    await runner.add_workers(worker)

    runner_task = asyncio.ensure_future(runner.run())
    ended_task = asyncio.ensure_future(call_ended.wait())
    try:
        await asyncio.wait({runner_task, ended_task}, return_when=asyncio.FIRST_COMPLETED)
    finally:
        for task in (runner_task, ended_task):
            if not task.done():
                task.cancel()
                with _suppress_cancelled():
                    await task


class _suppress_cancelled:  # noqa: N801 — context-manager helper, lowercase by intent
    """Swallow CancelledError when awaiting a cancelled cleanup task."""

    def __enter__(self) -> _suppress_cancelled:
        return self

    def __exit__(self, exc_type: object, exc: object, tb: object) -> bool:
        return exc_type is asyncio.CancelledError


__all__ = [
    "MissingCallMetadataError",
    "run_audiosocket_call",
]
