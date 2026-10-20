# Необязательный образ распознавания речи (STT-01): faster-whisper, модель — в слое сборки,
# в работе сеть не нужна. Используется только с профилем compose "stt" (STT_PROVIDER=local).
FROM python:3.12.11-slim-bookworm
# av закреплён: faster-whisper 1.2.1 передаёт av.open(metadata_errors=…), а PyAV 19 (проверено 06.10) этот
# аргумент не принимает — без закрепления свежая сборка перестаёт распознавать (DT-05).
ENV PIP_DEFAULT_TIMEOUT=120 PIP_RETRIES=8
RUN pip install --no-cache-dir \
    faster-whisper==1.2.1 \
    av==15.1.0 \
    fastapi==0.116.1 \
    "uvicorn[standard]==0.35.0" \
    python-multipart==0.0.20
ENV STT_MODEL=small STT_MODEL_ROOT=/models STT_LANGUAGE=ru
RUN python -c "from faster_whisper import WhisperModel; WhisperModel('$STT_MODEL', device='cpu', compute_type='int8', download_root='$STT_MODEL_ROOT')"
COPY deploy/stt/server.py /app/server.py
WORKDIR /app
RUN useradd --uid 10001 --create-home arm112 && chown -R arm112:arm112 "$STT_MODEL_ROOT"
USER arm112
EXPOSE 9000
CMD ["uvicorn", "server:app", "--host", "0.0.0.0", "--port", "9000"]
