FROM node:20-alpine

ENV NODE_ENV=production \
    DATA_DIR=/app/data \
    ADMIN_PORT=6030 \
    PUBLIC_HOST=sticker-seal \
    SUB2API_BASE=http://sub2api:8080

WORKDIR /app

# No dependencies: the runtime uses only node:http, node:fs, node:crypto.
COPY package.json ./
COPY src ./src
COPY public ./public
COPY defaults ./defaults
COPY tools ./tools

RUN mkdir -p /app/data && chown -R node:node /app

# node:20-alpine ships uid 1000 = node, so a bind-mounted ./data owned by uid
# 1000 on the host Just Works.
USER node

EXPOSE 6030
EXPOSE 9000-9100

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${ADMIN_PORT}/_seal/api/health" >/dev/null || exit 1

CMD ["node", "src/server.js"]
