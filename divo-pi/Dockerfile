# syntax=docker/dockerfile:1.7

FROM node:24.15.0-bookworm-slim@sha256:4e6b70dd6cbfc88c8157ba19aa3d9f9cce6ba4703576d55459e45efcbc9c5f5d

# Python packages install on demand into per-user venvs on the volume (see the
# files-and-documents skill), so only OS-level binaries belong here — the ones
# pip cannot provide. Deliberately absent: Marker and PyTorch, which would add
# several GB to every user's image for a document path pymupdf already covers.
RUN apt-get update \
	&& apt-get install -y --no-install-recommends \
		build-essential \
		ca-certificates \
		curl \
		dumb-init \
		fd-find \
		ffmpeg \
		file \
		fonts-dejavu-core \
		fonts-liberation \
		git \
		jq \
		libreoffice \
		poppler-utils \
		python3 \
		python3-pip \
		python3-venv \
		qpdf \
		ripgrep \
		tesseract-ocr \
		tesseract-ocr-eng \
		unzip \
		zip \
	&& ln -s /usr/bin/fdfind /usr/local/bin/fd \
	&& rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/agent/package.json packages/agent/package.json
COPY packages/ai/package.json packages/ai/package.json
COPY packages/coding-agent/package.json packages/coding-agent/package.json
COPY packages/orchestrator/package.json packages/orchestrator/package.json
COPY packages/tui/package.json packages/tui/package.json
COPY packages/coding-agent/examples/extensions/with-deps/package.json packages/coding-agent/examples/extensions/with-deps/package.json
COPY packages/coding-agent/examples/extensions/custom-provider-anthropic/package.json packages/coding-agent/examples/extensions/custom-provider-anthropic/package.json
COPY packages/coding-agent/examples/extensions/custom-provider-gitlab-duo/package.json packages/coding-agent/examples/extensions/custom-provider-gitlab-duo/package.json
COPY packages/coding-agent/examples/extensions/sandbox/package.json packages/coding-agent/examples/extensions/sandbox/package.json
COPY packages/coding-agent/examples/extensions/gondolin/package.json packages/coding-agent/examples/extensions/gondolin/package.json
RUN --mount=type=cache,target=/root/.npm npm ci --ignore-scripts
COPY . .
RUN npm run build --workspace packages/tui \
	&& ./node_modules/.bin/tsgo -p packages/ai/tsconfig.build.json \
	&& npm run build --workspace packages/agent \
	&& npm run build --workspace packages/coding-agent
RUN groupadd --gid 10001 divo \
	&& useradd --uid 10001 --gid 10001 --create-home --shell /bin/bash divo \
	&& mkdir -p /data /run/divo-auth \
	&& chown 10001:10001 /data /run/divo-auth

ENV HOME="/data/state/home" \
	DIVO_PI_ENTRY_MODE="compiled" \
	PATH="/app/node_modules/.bin:/data/state/home/.local/bin:/data/state/home/.npm/bin:${PATH}" \
	PIP_BREAK_SYSTEM_PACKAGES="1" \
	PIP_CACHE_DIR="/data/state/home/.cache/pip" \
	PYTHONUSERBASE="/data/state/home/.local" \
	npm_config_cache="/data/state/home/.cache/npm" \
	npm_config_prefix="/data/state/home/.npm"
USER 10001:10001
ENTRYPOINT ["/usr/bin/dumb-init", "--"]
CMD ["node", "divo/container-entry.mjs"]
