FROM python:3.13-slim

ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1 MPLCONFIGDIR=/tmp/matplotlib
WORKDIR /app
RUN apt-get update \
    && apt-get install -y --no-install-recommends fonts-noto-cjk ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY requirements.txt ./
ARG PIP_INDEX_URL=https://pypi.org/simple
RUN --mount=type=cache,id=lma-pip,target=/root/.cache/pip,sharing=locked \
    pip install --index-url "$PIP_INDEX_URL" -r requirements.txt
RUN useradd --uid 10001 --create-home lma
COPY --chown=lma:lma app ./app
USER lma
RUN python -c "import app.server.storage"
EXPOSE 8000
CMD ["python", "-m", "uvicorn", "app.server.api:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "1"]
