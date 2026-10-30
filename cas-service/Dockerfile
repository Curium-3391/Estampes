# syntax=docker/dockerfile:1
# The SymPy calculator for Estampes. Pure Python (sympy + mpmath), so it
# builds the same on linux/amd64 and linux/arm64. It listens on a Unix
# socket only; compose.yaml gives it no network at all.
ARG BASE_IMAGE=python:3.13-slim-bookworm
FROM ${BASE_IMAGE}
ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1 PIP_NO_CACHE_DIR=1 \
    ESTAMPES_CAS_SOCKET=/run/estampes-cas/cas.sock ESTAMPES_CAS_ALLOWED_UID=1000
WORKDIR /app
COPY requirements.lock ./
RUN pip install --no-cache-dir -r requirements.lock
COPY estampes_cas ./estampes_cas
# Same uid as the Estampes image's "node" user, so the socket (mode 0600)
# is reachable by Estampes and by nothing else.
RUN groupadd -g 1000 cas && useradd -u 1000 -g 1000 -M -s /usr/sbin/nologin cas \
 && mkdir -p /run/estampes-cas && chown 1000:1000 /run/estampes-cas
USER 1000:1000
VOLUME ["/run/estampes-cas"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 CMD ["python", "-m", "estampes_cas.healthcheck"]
CMD ["python", "-m", "estampes_cas"]
