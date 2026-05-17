"""Health endpoint contract tests.

These run BEFORE the server module exists (TDD red phase). Once
`f16_pipecat.server` is implemented, the suite should pass without
modification.
"""

from __future__ import annotations

from fastapi.testclient import TestClient

from f16_pipecat import __version__
from f16_pipecat.server import HealthResponse, app


def test_health_endpoint_returns_expected_shape() -> None:
    client = TestClient(app)
    response = client.get("/health")

    assert response.status_code == 200

    payload = response.json()

    # Schema regression safety — re-parse the response through the
    # Pydantic model so any drift in field names/types fails the test.
    parsed = HealthResponse.model_validate(payload)
    assert parsed.ok is True
    assert parsed.service == "f16-pipecat"

    assert payload["ok"] is True
    assert payload["service"] == "f16-pipecat"
    assert payload["version"] == __version__
    assert isinstance(payload["uptime_ms"], int)
    assert payload["uptime_ms"] >= 0
