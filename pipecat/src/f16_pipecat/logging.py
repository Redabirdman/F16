"""Structured JSON logging for f16-pipecat — pattern matches backend's pino setup."""
from __future__ import annotations

import os
import sys

from loguru import logger


def configure_logging() -> None:
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
