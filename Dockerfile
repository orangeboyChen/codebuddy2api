FROM oven/bun:1-slim AS deps

WORKDIR /app

RUN apt-get update && \
    apt-get install --no-install-recommends --yes python3 make g++ && \
    rm -rf /var/lib/apt/lists/*

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
COPY --from=builder --chown=bun:bun /app/public ./public

RUN mkdir -p /app/.codebuddy_data /app/.codebuddy_creds && \
    chown -R bun:bun /app

USER bun

EXPOSE 8001

CMD ["bun", "server.js"]
