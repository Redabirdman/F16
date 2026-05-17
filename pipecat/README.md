# F16 Pipecat Bridge

Python audio I/O bridge for the F16 voice channel. Handles inbound/outbound calls over OVH SIP, streams audio through Deepgram (STT, French) and Azure Neural (TTS, French), and forwards turn transcripts to the F16 backend `/v1/sales-agent/turn`. The sales-agent brain lives in the TypeScript backend; this service is intentionally thin.

## Local development

```bash
make install     # creates .venv via uv and installs dev deps
make test        # pytest
make lint        # ruff check src tests
make typecheck   # mypy src
make format      # ruff format src tests
make run         # uvicorn on :8000
```

> **Windows note:** the `Makefile` assumes a POSIX shell. Use Git Bash (or WSL) on Windows. Equivalent `uv` commands work directly in PowerShell if you prefer to skip `make`.

## Environment variables

See `.env.template`. None are required for `/health`; voice integrations are wired in M10.

Relevant runtime envs:

- `HOST` (default `127.0.0.1` locally, `0.0.0.0` in Docker)
- `PORT` (default `8000`)
- `LOG_LEVEL` (default `DEBUG` outside production, `INFO` when `F16_ENV=production`)
- `F16_ENV` (`development` | `production`)

## Design & milestone plan

- [F16 design doc](../docs/plans/2026-05-17-f16-design.md)
- [F16 implementation plan](../docs/plans/2026-05-17-f16-implementation.md)

> **TODO (M16, production hardening):** generate and commit a `uv.lock` for fully reproducible builds. Dependency ranges are currently pinned by minor in `pyproject.toml`.
