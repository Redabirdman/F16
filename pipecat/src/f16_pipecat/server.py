"""FastAPI entrypoint for the F16 Pipecat audio bridge.

This module exposes a `/health` endpoint used by orchestrators
(Docker/Kubernetes, the F16 admin smoke checks) to verify the process is alive,
mounts the voice session-management router, AND boots the Asterisk AudioSocket
TCP server alongside the HTTP app.

Real-time call audio does NOT flow through FastAPI: the OVH SIP → Asterisk leg
streams raw slin audio over a plain TCP AudioSocket connection. Asterisk dials
OUT to our TCP server (bound on AUDIOSOCKET_HOST:AUDIOSOCKET_PORT), which we
start in the FastAPI lifespan so a single `uvicorn f16_pipecat.server:app`
serves both surfaces. The `/v1/voice/turn` brain endpoint lives in the BACKEND,
not here.

ENV CONTRACT (authoritative — `.env.template` edits were blocked this session,
so this docstring + `audiosocket.py` / `backend.py` are the source of truth):

    AUDIOSOCKET_HOST          listen interface for the TCP server   (default 0.0.0.0)
    AUDIOSOCKET_PORT          listen port Asterisk dials OUT to      (default 9092)
    F16_SESSION_LOOKUP_SECRET shared secret sent as `x-f16-internal-secret` on
                              GET {F16_BACKEND_BASE_URL}/v1/voice/session/{id}
    F16_PIPECAT_MODE          "http" (default: FastAPI + AudioSocket) | "audiosocket"
                              (standalone TCP server, no HTTP)

The former jambonz vars (JAMBONZ_*, the `/voice/ws` WS leg) are GONE — Asterisk
AudioSocket replaced the jambonz WebSocket transport. Existing backend vars
(F16_BACKEND_BASE_URL, F16_WEBHOOK_SECRET, DEEPGRAM_API_KEY, TTS_PROVIDER, …)
are unchanged.
"""

from __future__ import annotations

import asyncio
import contextlib
import os
import time
from collections.abc import AsyncIterator

import uvicorn
from fastapi import FastAPI
from pydantic import BaseModel, Field

from f16_pipecat import __version__
from f16_pipecat.audiosocket import (
    DEFAULT_AUDIOSOCKET_HOST,
    DEFAULT_AUDIOSOCKET_PORT,
    serve_audiosocket,
)
from f16_pipecat.logging import configure_logging, logger
from f16_pipecat.voice import router as voice_router

# Configure structured JSON logging once at import time. Matches the
# backend's pino setup (timestamp, level, message, contextual fields).
configure_logging()

# Monotonic clock is the right choice for uptime: it is immune to
# wall-clock jumps (NTP sync, DST). Captured at import time so the
# value reflects "since the worker booted".
_START_MONOTONIC: float = time.monotonic()
_SERVICE_NAME: str = "f16-pipecat"


def _audiosocket_host() -> str:
    return os.environ.get("AUDIOSOCKET_HOST", DEFAULT_AUDIOSOCKET_HOST)


def _audiosocket_port() -> int:
    return int(os.environ.get("AUDIOSOCKET_PORT", str(DEFAULT_AUDIOSOCKET_PORT)))


class HealthResponse(BaseModel):
    """Shape returned by `GET /health`."""

    ok: bool = Field(description="True when the process is serving requests.")
    service: str = Field(description="Stable service identifier.")
    version: str = Field(description="Installed package version.")
    uptime_ms: int = Field(
        ge=0,
        description="Milliseconds elapsed since process start (monotonic).",
    )


@contextlib.asynccontextmanager
async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
    """Start the AudioSocket TCP server for the app's lifetime.

    The TCP server runs as a background asyncio task on the same event loop as
    FastAPI; it is cleanly shut down when the app stops. Asterisk connects OUT to
    it per call (one TCP connection == one call).
    """
    host, port = _audiosocket_host(), _audiosocket_port()
    server = await serve_audiosocket(host, port)
    serve_task = asyncio.ensure_future(server.serve_forever())
    logger.info(f"f16-pipecat: AudioSocket server up on {host}:{port}")
    try:
        yield
    finally:
        server.close()
        serve_task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await serve_task
        with contextlib.suppress(Exception):
            await server.wait_closed()
        logger.info("f16-pipecat: AudioSocket server stopped")


app = FastAPI(title="F16 Pipecat Bridge", version=__version__, lifespan=lifespan)
# Mount the voice session-management router (sessions/new, turn,
# sessions/{id}/end). Real-time audio flows over the AudioSocket TCP server.
app.include_router(voice_router)


@app.get("/health", response_model=HealthResponse)
def health() -> HealthResponse:
    uptime_ms = int((time.monotonic() - _START_MONOTONIC) * 1000)
    return HealthResponse(
        ok=True,
        service=_SERVICE_NAME,
        version=__version__,
        uptime_ms=uptime_ms,
    )


async def _run_audiosocket_only() -> None:
    """Run ONLY the AudioSocket TCP server (no FastAPI) until cancelled.

    Useful for running the voice transport as a standalone process; the HTTP
    surface can be served separately.
    """
    host, port = _audiosocket_host(), _audiosocket_port()
    server = await serve_audiosocket(host, port)
    async with server:
        await server.serve_forever()


if __name__ == "__main__":
    mode = os.environ.get("F16_PIPECAT_MODE", "http").strip().lower()
    if mode == "audiosocket":
        logger.info("Starting f16-pipecat AudioSocket server (standalone)")
        with contextlib.suppress(KeyboardInterrupt):
            asyncio.run(_run_audiosocket_only())
    else:
        host = os.environ.get("HOST", "127.0.0.1")
        port = int(os.environ.get("PORT", "8000"))
        logger.info(f"Starting f16-pipecat (HTTP + AudioSocket) on {host}:{port}")
        uvicorn.run("f16_pipecat.server:app", host=host, port=port, reload=False)
