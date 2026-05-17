# F16 Pipecat Bridge

Python audio I/O bridge for the F16 voice channel. Handles inbound/outbound calls over OVH SIP, streams audio through Deepgram (STT, French) and Azure Neural (TTS, French), and forwards turn transcripts to the F16 backend `/v1/sales-agent/turn`. The sales-agent brain lives in the TypeScript backend; this service is intentionally thin.

## Local development

```bash
make install   # creates .venv via uv and installs dev deps
make test      # pytest
make run       # uvicorn on :8000
```

## Environment variables

See `.env.template`. None are required for `/health`; voice integrations are wired in M10.

See `F16/docs/plans/` for the full milestone plan.
