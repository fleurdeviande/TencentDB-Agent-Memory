# check=skip=FromPlatformFlagConstDisallowed
# agent-memory: ONE image with the MemoryCore gateway and MemoryKnowledge.
# The role is the first argument: `core` (:8420) or `knowledge` (:8424) — see deploy/pw/image/entrypoint.sh.
#
# Built by gitlab-ci-commons as `docker build --build-arg IMAGE_TAG=... .`. No cache mounts and no
# `# syntax=` line on purpose: the build must also pass on the classic builder.
# Package manager is pnpm@9 with --ignore-workspace (npm@10/11 crash on the layout, see PW-CHANGES.md).
# No lockfile is committed (repo .gitignore), so dependency versions float within package.json ranges.

ARG NODE_IMAGE=node:22.23.3-bookworm-slim
ARG PNPM_VERSION=9.15.9

# ---- toolchain: native deps (better-sqlite3, jieba, sqlite-vec) + git for pnpm git deps ----
FROM --platform=linux/amd64 ${NODE_IMAGE} AS toolchain
ARG PNPM_VERSION
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ git ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && npm install -g "pnpm@${PNPM_VERSION}" --no-audit --no-fund
ENV PNPM_HOME=/pnpm \
    npm_config_store_dir=/pnpm/store \
    npm_config_package_import_method=copy

# ---- MemoryCore: runs from source via tsx, so only prod deps + sources ----
FROM toolchain AS core
WORKDIR /app/core
COPY MemoryCore/package.json ./
# auto-install-peers=false: the optional peer `openclaw` needs Node >= 24 and fails its preinstall.
RUN pnpm install --ignore-workspace --prod --no-frozen-lockfile \
        --config.auto-install-peers=false \
    && rm -rf /pnpm/store
COPY MemoryCore/ ./

# ---- MemoryKnowledge: upstream ships compiled dist/ (tsdown) ----
FROM toolchain AS knowledge
WORKDIR /app/knowledge
COPY MemoryKnowledge/package.json MemoryKnowledge/.npmrc ./
RUN pnpm install --ignore-workspace --no-frozen-lockfile
COPY MemoryKnowledge/tsconfig.json MemoryKnowledge/tsdown.config.ts MemoryKnowledge/openapi.yaml ./
COPY MemoryKnowledge/src/ ./src/
RUN pnpm run build
# Re-install prod-only from the lockfile just resolved, so runtime deps match what was built.
RUN rm -rf node_modules \
    && pnpm install --ignore-workspace --prod --frozen-lockfile \
    && rm -rf /pnpm/store src tsconfig.json tsdown.config.ts

# ---- runtime ----
FROM --platform=linux/amd64 ${NODE_IMAGE} AS runtime
ARG IMAGE_TAG=dev
LABEL org.opencontainers.image.title="agent-memory" \
      org.opencontainers.image.version="${IMAGE_TAG}"

# git: Code-Graph clones repositories; curl: probes and local HEALTHCHECK; tini: PID 1.
RUN apt-get update \
    && apt-get install -y --no-install-recommends git curl tini ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY --from=core /app/core /app/core
COPY --from=knowledge /app/knowledge /app/knowledge
COPY deploy/pw/image/entrypoint.sh /usr/local/bin/agent-memory
RUN chmod 0755 /usr/local/bin/agent-memory \
    && mkdir -p /data/tdai-memory /data/log /data/knowledge \
    && chown -R 1000:1000 /data

# Defaults only; the chart sets the real values. TDAI_GATEWAY_PORT is deliberately not set here:
# as an env var it would override server.port from the mounted config.
ENV NODE_ENV=production \
    AGENT_MEMORY_VERSION=${IMAGE_TAG} \
    TDAI_DATA_DIR=/data/tdai-memory \
    LOG_PATH=/data/log \
    KNOWLEDGE_DATA_DIR=/data/knowledge \
    KNOWLEDGE_DB_PATH=/data/knowledge/knowledge.db \
    LOG_LEVEL=info

# uid 1000 = `node` in the official image; numeric so runAsNonRoot can verify it.
USER 1000
WORKDIR /app
EXPOSE 8420 8424

ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/agent-memory"]
CMD ["core"]
