FROM python:3.11-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    xvfb ffmpeg firefox-esr wget curl ca-certificates xauth \
    && rm -rf /var/lib/apt/lists/*

RUN useradd -m -u 1001 -s /bin/bash camoxuser

USER camoxuser
WORKDIR /app
ENV HOME=/home/camoxuser
ENV PATH="/home/camoxuser/.local/bin:$PATH"

COPY --chown=camoxuser:camoxuser requirements.txt .

RUN pip install --user --upgrade pip setuptools wheel \
    && pip install --user --no-cache-dir -r requirements.txt

RUN python -m camoufox fetch

COPY --chown=camoxuser:camoxuser . .

CMD ["python", "test_login_workflow.py"]
