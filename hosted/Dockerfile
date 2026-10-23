# The hosted page's sandbox: the sign-in gateway (Node), `pr-eval serve` (Python with the
# pinned Blaxel SDK), and the CLIs a run calls (git, gh, bl). The app itself is uploaded
# to the volume by hosted/deploy.py, so a code change never needs a new image.
FROM ghcr.io/astral-sh/uv:0.9 AS uv

FROM node:24-bookworm

RUN apt-get update \
 && apt-get install -y --no-install-recommends git curl ca-certificates jq \
 && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /usr/share/keyrings/githubcli-archive-keyring.gpg \
 && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list \
 && apt-get update && apt-get install -y --no-install-recommends gh \
 && rm -rf /var/lib/apt/lists/*

RUN curl -fsSL https://raw.githubusercontent.com/blaxel-ai/toolkit/main/install.sh \
    | BINDIR=/usr/local/bin BL_INSTALL_PATH=false BL_INSTALL_COMPLETION=false BL_INSTALL_SETUP=false sh

COPY --from=uv /uv /usr/local/bin/
ENV UV_PYTHON_INSTALL_DIR=/opt/uv-python PYTHONDONTWRITEBYTECODE=1
RUN uv venv --python 3.12 /opt/venv && uv pip install --python /opt/venv/bin/python blaxel==0.4.19

COPY --from=ghcr.io/blaxel-ai/sandbox:latest /sandbox-api /usr/local/bin/sandbox-api
ENTRYPOINT ["/usr/local/bin/sandbox-api"]
