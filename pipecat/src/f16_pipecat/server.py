"""FastAPI entrypoint for the F16 Pipecat audio bridge.

This module exposes a `/health` endpoint used by orchestrators
(Docker/Kubernetes, the F16 admin smoke checks) to verify the
process is alive. The real Pipecat pipeline and SIP wiring land in
later milestones — this file is intentionally minimal.
"""

from __future__ import annotations

import os
import time

import uvicorn
from fastapi import FastAPI
from pydantic import BaseModel, Field

from f16_pipecat import __version__
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


class HealthResponse(BaseModel):
    """Shape returned by `GET /health`."""

    ok: bool = Field(description="True when the process is serving requests.")
    service: str = Field(description="Stable service identifier.")
    version: str = Field(description="Installed package version.")
    uptime_ms: int = Field(
        ge=0,
        description="Milliseconds elapsed since process start (monotonic).",
    )


app = FastAPI(title="F16 Pipecat Bridge", version=__version__)
# Mount the voice bridge router (option F scaffold — /voice/sessions/new,
# /voice/turn, /voice/sessions/{id}/end). M10 will replace the V0 stubs
# with the real Pipecat + Deepgram + Azure + backend wiring.
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


if __name__ == "__main__":
    host = os.environ.get("HOST", "127.0.0.1")
    port = int(os.environ.get("PORT", "8000"))
    logger.info(f"Starting f16-pipecat on {host}:{port}")
    uvicorn.run("f16_pipecat.server:app", host=host, port=port, reload=False)
