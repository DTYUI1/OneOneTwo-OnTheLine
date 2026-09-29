FROM ghcr.io/astral-sh/uv:0.8.22 AS uv
FROM python:3.12.11-slim-bookworm
COPY --from=uv /uv /uvx /usr/local/bin/
RUN apt-get update \
    && apt-get install --no-install-recommends -y ffmpeg \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /workspace
COPY pyproject.toml uv.lock .python-version ./
COPY apps/api apps/api
COPY packages/evalcore packages/evalcore
COPY scripts scripts
RUN uv sync --frozen --no-dev --package arm112-api
COPY contracts contracts
COPY data data
COPY deploy/certs deploy/certs
ENV PATH="/workspace/.venv/bin:$PATH" PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1
RUN useradd --uid 10001 --create-home arm112 \
    && mkdir -p /data/audio \
    && chown arm112:arm112 /data/audio
USER arm112
CMD ["python", "-m", "app.api"]
