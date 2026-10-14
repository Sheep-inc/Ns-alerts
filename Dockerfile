FROM python:3.13-slim
ENV PYTHONUNBUFFERED=1 TZ=Europe/Amsterdam DATA_DIR=/app/data
RUN apt-get update && apt-get install -y --no-install-recommends tzdata && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY app.py detect.py ./
COPY static ./static
VOLUME /app/data
EXPOSE 8780
HEALTHCHECK --interval=60s --timeout=5s CMD python -c "import urllib.request;urllib.request.urlopen('http://127.0.0.1:8780/healthz',timeout=4)"
CMD ["python", "app.py"]
