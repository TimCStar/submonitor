# syntax=docker/dockerfile:1.7
FROM node:24-alpine AS build

ARG NPM_REGISTRY=https://registry.npmjs.org

WORKDIR /app
RUN corepack enable && corepack prepare pnpm@11.9.0 --activate
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN --mount=type=cache,id=submonitor-pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm config set registry "${NPM_REGISTRY}" \
    && pnpm install --frozen-lockfile --prefer-offline --fetch-retries=5 --fetch-timeout=120000
COPY index.html vite.config.js ./
COPY src/web ./src/web
RUN pnpm build

FROM node:24-alpine AS runtime

ENV NODE_ENV=production \
    SUBMONITOR_HOST=0.0.0.0 \
    SUBMONITOR_PORT=8787 \
    SUBMONITOR_DATA_DIR=/app/data
WORKDIR /app
COPY package.json ./
COPY src/server ./src/server
COPY --from=build /app/dist ./dist
RUN mkdir -p /app/data && chown -R node:node /app
USER node
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8787/api/health >/dev/null || exit 1
CMD ["node", "src/server/index.js"]
