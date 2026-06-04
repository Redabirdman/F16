"""Per-call runner: drive the cascaded pipeline for one jambonz WebSocket.

This is the entrypoint the FastAPI `/voice/ws` route calls once jambonz has
connected its bidirectional-audio socket. It:

  1. reads the FIRST text frame (jambonz metadata) to learn the negotiated
     sample rate AND the per-call identity (sessionId/leadId/customerId the
     backend stamped on the `listen` verb),
  2. builds the jambonz transport at that rate,
  3. builds the F16 backend client + the cascaded pipeline
     (transport.input → STT → BackendTurnProcessor → TTS → transport.output),
  4. runs it to completion with interruption handling on, and
  5. tears everything down (closes the backend client) when the call ends.

NO business logic lives here — the brain is the backend. This module is pure
lifecycle wiring. Heavy pipecat imports are LAZY so importing the module (e.g.
from the FastAPI app at boot) stays light.

The metadata frame is consumed HERE, before the pipeline starts, so the
session ids are known up-front and the serializer never has to special-case
the first frame on the audio path.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from f16_pipecat.logging import logger
from f16_pipecat.transport import (
    JAMBONZ_DEFAULT_SAMPLE_RATE,
    JambonzCallMetadata,
    build_jambonz_transport,
)

if TYPE_CHECKING:  # pragma: no cover - typing only
    from fastapi import WebSocket

    from f16_pipecat.backend import F16BackendClient
    from f16_pipecat.pipeline import VoicePipelineConfig


class MissingCallMetadataError(RuntimeError):
    """Raised when jambonz's first frame lacks the required session identity."""


async def read_call_metadata(websocket: WebSocket) -> JambonzCallMetadata:
    """Read + parse jambonz's first text frame (call metadata).

    jambonz sends exactly one text frame immediately after the socket opens.
    We accept the metadata over EITHER a text or (defensively) a bytes frame,
    parse it, and require sessionId/leadId/customerId. Raises
    `MissingCallMetadataError` if absent or malformed — the caller closes the
    socket.
    """
    message = await websocket.receive()
    raw: str | bytes | None = message.get("text")
    if raw is None:
        raw_bytes = message.get("bytes")
        raw = bytes(raw_bytes) if isinstance(raw_bytes, (bytes, bytearray)) else None
    if raw is None:
        raise MissingCallMetadataError("jambonz first frame carried no payload")

    meta = JambonzCallMetadata.parse(raw)
    if meta is None:
        raise MissingCallMetadataError("jambonz metadata missing session/lead/customer ids")
    return meta


async def run_voice_call(
    websocket: WebSocket,
    *,
    session_id: str | None = None,
    lead_id: str | None = None,
    customer_id: str | None = None,
    config: VoicePipelineConfig | None = None,
    metadata: JambonzCallMetadata | None = None,
    backend: F16BackendClient | None = None,
    session_timeout_secs: int | None = None,
) -> None:
    """Run the full cascaded pipeline for one jambonz call to completion.

    Identity precedence: explicit `session_id`/`lead_id`/`customer_id` args
    (passed by the route after it parsed the metadata) win; otherwise they are
    taken from `metadata`. At least one source MUST supply all three ids.

    `backend` and `config` are injectable for tests; in production they default
    to env-built instances. The backend client is closed on exit when we built
    it ourselves (so the caller's injected client is left alone).

    Heavy pipecat imports are deferred to inside this function.
    """
    from f16_pipecat.backend import F16BackendClient
    from f16_pipecat.pipeline import VoicePipelineConfig, build_pipeline

    sid = session_id or (metadata.session_id if metadata else None)
    lid = lead_id or (metadata.lead_id if metadata else None)
    cid = customer_id or (metadata.customer_id if metadata else None)
    if not (sid and lid and cid):
        raise MissingCallMetadataError("run_voice_call requires session/lead/customer ids")

    sample_rate = metadata.sample_rate if metadata else JAMBONZ_DEFAULT_SAMPLE_RATE
    cfg = config or VoicePipelineConfig.from_env()

    owns_backend = backend is None
    client = backend or F16BackendClient.from_env()

    transport = build_jambonz_transport(
        websocket,
        sample_rate=sample_rate,
        session_timeout_secs=session_timeout_secs,
    )

    pipeline = build_pipeline(
        config=cfg,
        transport=transport,
        backend=client,
        session_id=sid,
        lead_id=lid,
        customer_id=cid,
    )

    logger.info(
        f"voice-runner: starting call session={sid} rate={sample_rate} tts={cfg.tts_provider.value}"
    )

    try:
        await _run_pipeline_to_completion(pipeline, transport)
    finally:
        logger.info(f"voice-runner: call ended session={sid}")
        if owns_backend:
            await client.aclose()


async def _run_pipeline_to_completion(pipeline: object, transport: object) -> None:
    """Build the worker + runner and block until the call's pipeline ends.

    Interruption handling is ON by default in pipecat 1.3.0: it is driven by
    the transport surfacing user-speech frames (no `allow_interruptions` knob
    exists on `PipelineParams` in this line), so a caller talking over the bot
    triggers an `InterruptionFrame` — which our serializer turns into a jambonz
    `killAudio`. The runner exits when the pipeline reaches a terminal frame
    (transport disconnect → EndFrame), i.e. exactly when the jambonz socket
    closed.

    # TODO(live): for reliable barge-in on a live SIP leg, attach a VAD
    # analyzer to the input transport (e.g. SileroVADAnalyzer). It is omitted
    # here to keep imports light and avoid a model download in CI; with no VAD,
    # interruptions still fire on STT speech events but with higher latency.
    """
    from pipecat.pipeline.worker import PipelineWorker
    from pipecat.workers.runner import WorkerRunner

    # PipelineWorker is the non-deprecated successor to PipelineTask in 1.3.0
    # (PipelineTask is a thin deprecated alias). Interruptions are on by default.
    worker = PipelineWorker(pipeline)  # type: ignore[arg-type]
    runner = WorkerRunner(handle_sigint=False)
    await runner.add_workers(worker)
    await runner.run()


__all__ = [
    "MissingCallMetadataError",
    "read_call_metadata",
    "run_voice_call",
]
