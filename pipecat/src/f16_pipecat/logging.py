"""Structured JSON logging for f16-pipecat — pattern matches backend's pino setup."""

from __future__ import annotations

import contextlib
import os
import sys

from loguru import logger


def _force_utf8_streams() -> None:
    """Make stdout/stderr encode UTF-8 so non-Latin-1 glyphs never crash a sink.

    On Windows the console defaults to cp1252, so pipecat's startup banner (and
    any log line with emoji/box-drawing chars) raises UnicodeEncodeError inside
    loguru's stderr sink. Reconfiguring with errors="replace" keeps it safe and
    is effectively a no-op on Linux/macOS, where streams are already UTF-8.
    """
    for stream in (sys.stdout, sys.stderr):
        reconfigure = getattr(stream, "reconfigure", None)
        if reconfigure is None:
            continue
        # Stream may be detached or non-reconfigurable (e.g. redirected); skip if so.
        with contextlib.suppress(ValueError, OSError):
            reconfigure(encoding="utf-8", errors="replace")


def configure_logging() -> None:
    _force_utf8_streams()
    logger.remove()
    default_level = "DEBUG" if os.environ.get("F16_ENV") != "production" else "INFO"
    log_level = os.environ.get("LOG_LEVEL", default_level).upper()
    logger.add(
        sys.stdout,
        level=log_level,
        # JSON output — matches pino shape (timestamp, level, message, ctx).
        serialize=True,
        backtrace=True,
        # Do not leak local variables in production.
        diagnose=False,
    )
    logger.configure(extra={"service": "f16-pipecat"})


__all__ = ["logger", "configure_logging"]
