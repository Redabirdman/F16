# F16 Pipecat — developer convenience targets.
# Requires `uv` (https://github.com/astral-sh/uv) on PATH.

.PHONY: install test lint format typecheck run clean

install:
	uv venv --python 3.12 .venv
	uv pip install -e ".[dev]"

test:
	pytest -v

lint:
	ruff check src tests

format:
	ruff format src tests

typecheck:
	mypy src

run:
	uvicorn f16_pipecat.server:app --reload --port 8000

clean:
	rm -rf .venv .pytest_cache .ruff_cache .mypy_cache build dist *.egg-info
