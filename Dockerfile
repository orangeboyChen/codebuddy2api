# Pinned to the same Bun version as CI (.github/workflows/*.yml BUN_VERSION).
FROM oven/bun:1.3.14-slim AS deps

WORKDIR /app

RUN apt-get update && \
    apt-get install --no-install-recommends --yes python3 make g++ && \
    rm -rf /var/lib/apt/lists/*

COPY package.json bun.lock ./
# devDependencies must stay installed here: `next build` needs typescript and
# the rest of the build toolchain. Do not switch this to --production, or the
# build fails. devDependencies never reach the final image, which only copies
# the .next/standalone output.
RUN bun install --frozen-lockfile

FROM oven/bun:1.3.14-slim AS builder

WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1

COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN bun run build

FROM oven/bun:1.3.14-slim AS runner

WORKDIR /app
ENV NODE_ENV=production \
    PORT=8001 \
    HOSTNAME=0.0.0.0 \
    NEXT_TELEMETRY_DISABLED=1

# Storage and credentials live under /app; see deploy/docker-compose.yml for the
# CODEBUDDY_STORAGE_FILE_DIR / CODEBUDDY_CREDENTIALS_DIR values that match.
COPY --from=builder --chown=bun:bun /app/.next/standalone ./
COPY --from=builder --chown=bun:bun /app/.next/static ./.next/static
COPY --from=builder --chown=bun:bun /app/public ./public

RUN mkdir -p /app/.codebuddy_data /app/.codebuddy_creds && \
    chown -R bun:bun /app

USER bun

EXPOSE 8001

CMD ["bun", "server.js"]
