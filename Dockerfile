# Collagent backend — API + realtime gateway. Agent runtimes are NOT run in
# this image: local agent hosts (collagent create/open/add on a developer's
# machine) and remote/cloud agents connect to it as authenticated agent hosts.
FROM node:22-alpine

WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
# node-pty is only needed by agent hosts (PTY mode), never by the server.
RUN npm ci --omit=dev --omit=optional --ignore-scripts --no-audit --no-fund

COPY bin ./bin
COPY src ./src
COPY migrations ./migrations
COPY package.json ./

ENV HOST=0.0.0.0 \
    PORT=7717 \
    COLLAGENT_DATA_DIR=/data \
    COLLAGENT_LOG_FORMAT=json \
    COLLAGENT_TRUST_PROXY=1
VOLUME /data
EXPOSE 7717

HEALTHCHECK --interval=15s --timeout=3s --start-period=10s \
  CMD wget -qO- http://127.0.0.1:7717/readyz || exit 1

# SIGTERM triggers the server's graceful shutdown path.
CMD ["node", "bin/collagent.js", "serve"]
