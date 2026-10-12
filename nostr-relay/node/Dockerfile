# Docker image for the node signaling relay (see ../README.md).
#
#   docker build -t bramble-relay nostr-relay/node
#   docker run -p 7400:7400 bramble-relay          # ws://localhost:7400
#   docker run -p 9000:9000 -e PORT=9000 bramble-relay
FROM node:22-alpine

ENV NODE_ENV=production
WORKDIR /app

# Install the single dependency (ws) before copying the app, so it stays cached.
# npm ci + the committed lockfile keep the image reproducible.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --chown=node:node relay.mjs ./
USER node

# The relay answers plain HTTP GET / with 200; reuse it as the container probe.
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
	CMD wget -qO /dev/null http://127.0.0.1:${PORT:-7400}/ || exit 1

EXPOSE 7400
# relay.mjs handles SIGTERM and closes active connections when running as PID 1.
CMD ["node", "relay.mjs"]
