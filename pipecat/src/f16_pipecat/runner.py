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

from f16_pipecat.audiosocket import build_audiosocket_transport
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
            f"rate=8000 tts={cfg.tts_provider.value}"
        )
        await _run_pipeline_to_completion(pipeline, call_ended)
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


async def _run_pipeline_to_completion(pipeline: object, call_ended: asyncio.Event) -> None:
    """Build the worker + runner and block until the call's pipeline ends.

    The pipeline runs until the transport surfaces a terminal frame
    (AudioSocket TERMINATE/EOF → the input read loop sets `call_ended`, and the
    transport disconnect drives an EndFrame through the pipeline). We race the
    runner against `call_ended` so a peer hangup promptly tears the call down.

    Interruption handling is ON by default in pipecat 1.3.0 (driven by the
    transport surfacing user-speech frames), so a caller talking over the bot
    triggers barge-in without any extra knob.

    # TODO(live): for crisp barge-in on a live SIP leg, attach a VAD analyzer to
    # the input transport (e.g. SileroVADAnalyzer). Omitted here to keep imports
    # light and avoid a model download in CI; without VAD, interruptions still
    # fire on STT speech events but with higher latency.
    """
    from pipecat.pipeline.worker import PipelineWorker
    from pipecat.workers.runner import WorkerRunner

    # PipelineWorker is the non-deprecated successor to PipelineTask in 1.3.0.
    worker = PipelineWorker(pipeline)  # type: ignore[arg-type]
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
