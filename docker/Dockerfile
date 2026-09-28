# syntax=docker/dockerfile:1.7
# =============================================================================
# wgb-strapi — ECS Fargate runtime image
# -----------------------------------------------------------------------------
# Target runtime : AWS ECS Fargate (linux/amd64)
# Base image     : node:22-slim (Debian 12, glibc)
# Build system   : BuildKit (required for the cache mount and syntax directive)
#
# Shaped after `wgb-backend/docker/Dockerfile` — same account, same cluster,
# same two-plane deploy — rather than after the estate's Strapi image, which
# runs as root with no init process and no health check.
#
# **Node 22, not 24.** package.json allows up to 24, but Strapi 5.43 is tested
# against the 20/22 line; 22 is the newest LTS inside both bounds. **Debian
# slim, not Alpine**: Strapi's image pipeline pulls in sharp, whose prebuilt
# binaries are glibc-first, and the estate's Alpine image has to install
# build-base and python3 to compile what it cannot download. Matching
# wgb-backend's base avoids that entirely.
#
# Admin-panel changes made through the UI are NOT persistent — content types,
# components and plugin config are files in this repo, built into this image.
# Develop with `npm run develop` and commit `src/` instead.
# =============================================================================

ARG NODE_IMAGE=node:22-slim

# -----------------------------------------------------------------------------
# Stage 1: base
# -----------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS base
WORKDIR /opt/app
ENV NPM_CONFIG_UPDATE_NOTIFIER=false \
    NPM_CONFIG_FUND=false \
    NPM_CONFIG_AUDIT=false \
    NPM_CONFIG_LOGLEVEL=warn \
    LANG=C.UTF-8 \
    LC_ALL=C.UTF-8

RUN apt-get update && \
    apt-get install -y --no-install-recommends ca-certificates && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

# -----------------------------------------------------------------------------
# Stage 2: builder — install, then build the admin panel.
#
# One install serves both stages: this repo declares no devDependencies, so
# `npm ci` and `npm ci --omit=dev` resolve the same tree and there is nothing
# to prune afterwards. If devDependencies are ever added, this stage keeps
# them and the runtime stage must stop copying node_modules wholesale.
#
# NODE_ENV=production is set for the build itself — `strapi build` emits a
# development bundle otherwise, with source maps and the dev-only error
# overlay, and serves it from the production image.
# -----------------------------------------------------------------------------
FROM base AS builder

RUN --mount=type=cache,target=/root/.npm,sharing=locked \
    --mount=type=bind,source=package.json,target=package.json \
    --mount=type=bind,source=package-lock.json,target=package-lock.json \
    npm ci --no-audit --no-fund

COPY . .

ENV NODE_ENV=production
RUN npm run build

# -----------------------------------------------------------------------------
# Stage 3: runtime
#
# tini as PID 1 so SIGTERM reaches Strapi rather than being absorbed by npm —
# ECS sends it on every deploy and waits 30s before killing the task.
# -----------------------------------------------------------------------------
FROM base AS runtime

ARG BUILD_VERSION=unknown
ARG GIT_COMMIT=unknown
ARG BUILD_DATE=unknown

LABEL org.opencontainers.image.title="wgb-strapi" \
      org.opencontainers.image.description="Strapi CMS for the WeddingGiftBox blog" \
      org.opencontainers.image.version="${BUILD_VERSION}" \
      org.opencontainers.image.revision="${GIT_COMMIT}" \
      org.opencontainers.image.created="${BUILD_DATE}" \
      org.opencontainers.image.vendor="Matrimony.com" \
      org.opencontainers.image.licenses="Proprietary" \
      org.opencontainers.image.base.name="docker.io/library/node:22-slim"

RUN apt-get update && \
    apt-get install -y --no-install-recommends \
        tini \
        wget \
        ca-certificates \
        tzdata && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/* /var/cache/apt/* /tmp/* && \
    groupadd --system --gid 1001 nodejs && \
    useradd  --system --uid 1001 --gid nodejs \
             --home-dir /home/nodeuser --create-home \
             --shell /usr/sbin/nologin nodeuser

# Task memory is 2048 MiB (see ecs/taskdef.dev.json); the log_router reserves
# 50 MiB. Strapi's admin is already built here, so this ceiling only has to
# cover serving it.
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=1337 \
    NODE_OPTIONS="--max-old-space-size=1536"

# The whole built app, ownership handed to the runtime user in the same layer.
# Strapi resolves plugins and the admin bundle by walking its own install, so
# the tree is copied as one unit rather than cherry-picked directory by
# directory — a missing plugin path fails at boot, not at build.
COPY --chown=nodeuser:nodejs --from=builder /opt/app /opt/app

# The upload plugin resolves its provider at register time, before anything
# else boots. With AWS_BUCKET set it writes to S3 and never looks here — but
# unset, it falls back to the local provider, which throws "The upload folder
# doesn't exist or is not accessible" and exits 1. That is a crash loop on a
# missing environment variable, so the directory is guaranteed rather than
# inherited from the build context (.dockerignore keeps local uploads out).
RUN mkdir -p /opt/app/public/uploads && chown nodeuser:nodejs /opt/app/public/uploads

USER nodeuser:nodejs

EXPOSE 1337
STOPSIGNAL SIGTERM

# Strapi's own liveness endpoint: 204, no database round trip, no auth. The ALB
# target group should point here too — `/admin` redirects (302) and `/` is not
# a health signal.
HEALTHCHECK --interval=30s --timeout=5s --start-period=90s --retries=3 \
    CMD wget --quiet --tries=1 --spider "http://127.0.0.1:${PORT}/_health" || exit 1

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["npm", "run", "start"]
