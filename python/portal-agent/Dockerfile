# syntax=docker/dockerfile:1
# Build from the repo root:  docker build -f python/portal-agent/Dockerfile -t e2e-portal-agent .

FROM python:3.12-slim AS build
COPY --from=ghcr.io/astral-sh/uv:0.11 /uv /usr/local/bin/uv
WORKDIR /app
COPY pyproject.toml uv.lock ./
COPY python ./python
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --frozen --no-dev --no-editable --package e2e-portal-agent

FROM python:3.12-slim AS runtime
ENV PATH="/app/.venv/bin:$PATH" PYTHONUNBUFFERED=1
WORKDIR /app
COPY --from=build /app/.venv /app/.venv
RUN useradd --system --uid 10001 app
USER app
ENV PORT=4112
EXPOSE 4112
HEALTHCHECK --interval=30s --timeout=3s CMD python -c "import urllib.request,sys; urllib.request.urlopen('http://127.0.0.1:4112/healthz', timeout=2)" || exit 1
CMD ["portal-agent"]
