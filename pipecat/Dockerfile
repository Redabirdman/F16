# F16 Pipecat bridge image.
# Build context MUST be the F16 root, e.g.:
#   docker build -f pipecat/Dockerfile -t f16-pipecat .
#
# Multi-stage: `builder` resolves and installs deps into a self-contained
# venv at /opt/venv; `runtime` is a slim image that only carries the venv,
# the source, and the audio runtime libraries Pipecat needs.

ARG PYTHON_IMAGE=python:3.12-slim

# ---------- builder ----------
FROM ${PYTHON_IMAGE} AS builder

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PIP_NO_CACHE_DIR=1

RUN apt-get update && apt-get install -y --no-install-recommends \
        build-essential \
        libffi-dev \
        libssl-dev \
    && rm -rf /var/lib/apt/lists/*

RUN pip install uv

WORKDIR /build/pipecat

COPY pipecat/pyproject.toml ./pyproject.toml
COPY pipecat/README.md ./README.md
COPY pipecat/src ./src

# Resolve the venv outside the source tree so the runtime stage can
# copy it verbatim. `--no-editable` installs a real wheel — cleaner
# for runtime than a `.pth`-based editable install.
RUN uv venv /opt/venv \
    && uv pip install --python /opt/venv/bin/python --no-editable .

# ---------- runtime ----------
FROM ${PYTHON_IMAGE} AS runtime

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PATH=/opt/venv/bin:$PATH

# Audio runtime deps. Pipecat pulls in numpy/scipy at import time and
# `libsndfile1` + `ffmpeg` are needed once we actually pipe audio.
RUN apt-get update && apt-get install -y --no-install-recommends \
        libsndfile1 \
        ffmpeg \
        wget \
        ca-certificates \
    && rm -rf /var/lib/apt/lists/*

RUN groupadd --system pipecat && useradd --system --gid pipecat --create-home pipecat

COPY --from=builder --chown=pipecat:pipecat /opt/venv /opt/venv

WORKDIR /app
USER pipecat

EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD wget --spider --quiet http://127.0.0.1:8000/health || exit 1

CMD ["uvicorn", "f16_pipecat.server:app", "--host", "0.0.0.0", "--port", "8000"]
