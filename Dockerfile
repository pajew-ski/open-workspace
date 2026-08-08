# syntax=docker/dockerfile:1

# Open Workspace — production image (Next.js standalone output).
#
#   Build:  docker build -t open-workspace .
#   Run:    docker run -p 3000:3000 -v ow-data:/app/data open-workspace
#
# The image ships the repository's data/ directory as seed content
# (data/secure is excluded via .dockerignore). /app/data is declared as a
# volume mountpoint: mount a named volume there (see run command above) to
# persist workspace data across container restarts — on first use the named
# volume is initialized with the seed data baked into the image.

# ---- Stage 1: install dependencies (bun) --------------------------------
FROM oven/bun:1 AS deps
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

# ---- Stage 2: build (bun) -----------------------------------------------
FROM oven/bun:1 AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN bun run build

# ---- Stage 3: runtime (plain Node, no bun required) ---------------------
FROM node:22-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

# Run as a non-root user (uid/gid 1001).
RUN addgroup --system --gid 1001 nodejs \
  && adduser --system --uid 1001 nextjs

# Standalone server bundle plus static assets and public files.
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=builder --chown=nextjs:nodejs /app/public ./public

# Seed data. Declared as a volume so runtime writes persist outside the
# container (mount: -v ow-data:/app/data).
COPY --from=builder --chown=nextjs:nodejs /app/data ./data
VOLUME /app/data

USER nextjs
EXPOSE 3000

CMD ["node", "server.js"]
