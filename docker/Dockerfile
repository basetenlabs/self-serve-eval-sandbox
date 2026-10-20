# One image for every trial: the coding agent (Claude Code), the translating proxy's
# Python, and the toolchains the sample repos need (Python via uv, Node + pnpm, Go).
# Repo dependencies are installed per trial, before the agent starts, so one image
# serves every task and every model.
FROM golang:1.26-bookworm AS go
FROM ghcr.io/astral-sh/uv:0.9 AS uv

FROM node:24-bookworm
ARG CLAUDE_CODE_VERSION=2.1.296

RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 python3-venv ripgrep jq less curl ca-certificates \
 && rm -rf /var/lib/apt/lists/*

COPY --from=go /usr/local/go /usr/local/go
COPY --from=uv /uv /uvx /usr/local/bin/
COPY --from=ghcr.io/blaxel-ai/sandbox:latest /sandbox-api /usr/local/bin/sandbox-api
RUN npm install -g "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
 && corepack enable

# Claude Code refuses to skip permission prompts as root; the agent runs as `agent`.
RUN useradd --create-home --shell /bin/bash agent \
 && mkdir -p /workspace /logs /tests /opt/eval /opt/venv /go \
 && chown -R agent:agent /workspace /logs /tests /opt/venv /go
COPY proxy.py /opt/eval/

ENV PATH=/opt/venv/bin:/usr/local/go/bin:/go/bin:$PATH \
    GOPATH=/go GOTOOLCHAIN=auto \
    UV_PYTHON_INSTALL_DIR=/opt/uv-python UV_LINK_MODE=copy \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0 CI=1 TZ=UTC \
    DISABLE_AUTOUPDATER=1 CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 IS_SANDBOX=1

# Pre-fetch a Python the sample repos accept, so trials don't each download one.
RUN uv python install 3.12 && chmod -R a+rX /opt/uv-python

ENV HOME=/home/agent BL_SANDBOX_API_ISOLATION=true
USER agent
WORKDIR /workspace
ENTRYPOINT ["/usr/local/bin/sandbox-api"]
