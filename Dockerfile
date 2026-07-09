FROM oven/bun:1-slim AS deps

WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

FROM oven/bun:1-slim AS builder

WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1

COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN bun run build

FROM oven/bun:1-slim AS runner

WORKDIR /app
ENV NODE_ENV=production \
    PORT=8001 \
    HOSTNAME=0.0.0.0 \
    NEXT_TELEMETRY_DISABLED=1

COPY --from=builder --chown=bun:bun /app/.next/standalone ./
COPY --from=builder --chown=bun:bun /app/.next/static ./.next/static

RUN mkdir -p /app/config /app/.codebuddy_creds && \
    chown -R bun:bun /app

USER bun

EXPOSE 8001

CMD ["bun", "server.js"]
