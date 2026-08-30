# syntax=docker/dockerfile:1
# One Dockerfile for both services; pick with a build argument:
#   docker build --build-arg SERVICE=api -t api .
#   docker build --build-arg SERVICE=worker -t worker .

# ---- dependencies -----------------------------------------------------------
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/telemetry/package.json packages/telemetry/
COPY services/api/package.json services/api/
COPY services/worker/package.json services/worker/
RUN npm ci --ignore-scripts

# ---- build ------------------------------------------------------------------
FROM deps AS build
COPY tsconfig.base.json ./
COPY packages/telemetry packages/telemetry
COPY services services
RUN npm run build && npm prune --omit=dev

# ---- runtime ----------------------------------------------------------------
FROM node:22-alpine AS runtime
ARG SERVICE=api
# tini forwards SIGTERM to node and reaps zombies; without it PID 1 ignores
# the signal and the shutdown that flushes the last spans never runs.
RUN apk add --no-cache tini
ENV NODE_ENV=production \
    SERVICE=${SERVICE} \
    OTEL_SERVICE_NAME=${SERVICE} \
    HEALTHCHECK_PORT=3000 \
    HEALTHCHECK_PATH=/readyz
WORKDIR /app
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/packages/telemetry/package.json ./packages/telemetry/
COPY --from=build --chown=node:node /app/packages/telemetry/dist ./packages/telemetry/dist
COPY --from=build --chown=node:node /app/services/${SERVICE}/package.json ./services/${SERVICE}/
COPY --from=build --chown=node:node /app/services/${SERVICE}/dist ./services/${SERVICE}/dist
COPY --chown=node:node package.json ./
USER node
EXPOSE 3000 9464
HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${HEALTHCHECK_PORT}${HEALTHCHECK_PATH}" || exit 1
ENTRYPOINT ["/sbin/tini", "--"]
# The loader hook must be installed before the application module is imported.
CMD ["sh", "-c", "exec node --import @mohadjillani/telemetry/register services/${SERVICE}/dist/main.js"]
