# syntax=docker/dockerfile:1.7

FROM node:24-bookworm-slim AS web-build
WORKDIR /repo/web
COPY web/package*.json ./
RUN npm ci
COPY web/ ./
COPY scripts/check_bundle_budgets.mjs /repo/scripts/check_bundle_budgets.mjs
RUN npm run build

FROM node:24-bookworm-slim AS server-build
WORKDIR /repo
COPY server/package*.json ./server/
COPY server/vendor ./server/vendor
RUN cd server && npm ci
# The server bundles web TypeScript via esbuild - its runtime shims import from
# web/src/{models,services/{ai,debrid,indexers,metadata,subtitles}}, and some of
# that web code pulls 3rd-party npm deps (e.g. subsrt-ts) that esbuild resolves
# from web/node_modules. So install web deps too, then copy the whole web/src so
# every cross-import resolves. This is a build stage only - it never bloats the
# runtime image (which copies just server/dist).
COPY web/package*.json ./web/
RUN cd web && npm ci
COPY server/ ./server/
COPY web/src ./web/src
RUN cd server && npm run build

FROM node:24-bookworm-slim AS runtime
RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg \
  && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=43110
ENV DS_SERVER_DATA_DIR=/data
ENV DS_SERVER_DB_PATH=/data/debridstreamer.sqlite
ENV DS_WEB_DIST=/app/web-dist
# Hosted browsers use this only when a source container or codec is not
# browser-compatible. Direct MP4/WebM playback remains untouched. Operators can
# override this to false on CPU-constrained servers.
ENV DS_SERVER_ENABLE_TRANSCODE=true
WORKDIR /app

RUN mkdir -p /data /app/server /app/web-dist \
  && chown -R node:node /data /app

COPY --chown=node:node --from=server-build /repo/server/dist ./server/dist
COPY --chown=node:node --from=web-build /repo/web/dist ./web-dist

VOLUME ["/data"]
EXPOSE 43110
USER node
CMD ["node", "server/dist/index.cjs"]
