# syntax=docker/dockerfile:1

# ---------------------------------------------------------------- deps ------
FROM node:24-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

# --------------------------------------------------------------- build ------
FROM node:24-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# No network calls at build time: system fonts only, never next/font/google,
# so this image can also be built on a machine without internet access.
# Standalone output is opt-in (next.config.ts): the runner stage needs it.
ENV NEXT_OUTPUT_STANDALONE=1
RUN npm run build

# ------------------------------------------------------------ migrator ------
# Keeps the full toolchain (tsx and its own dependencies) so the migration and
# seed scripts run as written. Not the app's service image: `migrate` and the
# one-off ops services run it briefly, and `scheduler` runs its crond from it.
FROM build AS migrator
WORKDIR /app
# The `scheduler` service runs busybox crond from this image with
# TZ=BACKUP_TZ; a zone name only applies with tzdata installed (the backup
# image installs it for the same reason).
RUN apk add --no-cache tzdata
CMD ["npx", "tsx", "scripts/migrate.ts"]

# ------------------------------------------------------------- runtime ------
# Standalone output traces exactly the server dependencies it needs, so this
# image carries no node_modules tree of its own.
FROM node:24-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

RUN addgroup -g 1001 -S nodejs && adduser -S -u 1001 -G nodejs nextjs

COPY --from=build --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=build --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=build --chown=nextjs:nodejs /app/public ./public

USER nextjs
EXPOSE 3000
CMD ["node", "server.js"]
