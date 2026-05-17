"""FastAPI entrypoint for the F16 Pipecat audio bridge.

This module exposes a `/health` endpoint used by orchestrators
(Docker/Kubernetes, the F16 admin smoke checks) to verify the
process is alive. The real Pipecat pipeline and SIP wiring land in
later milestones — this file is intentionally minimal.
"""

from __future__ import annotations

import time

import uvicorn
from fastapi import FastAPI
from pydantic import BaseModel, Field

from f16_pipecat import __version__

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
    uvicorn.run("f16_pipecat.server:app", host="0.0.0.0", port=8000, reload=False)
