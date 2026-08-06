# Later — self-hosted Node image.
#
# The alternative deploy target to Cloudflare Workers, and the one to pick if you already run
# a homelab or want the data on a disk you can see. Same code, same schema, same migrations —
# only the driver differs. See docs/adr/0002-hosting-cloudflare-workers-primary.md.
#
# Three stages so the shipped image carries neither a compiler nor a dev dependency:
#   build      — full install, bundle the app to a single file
#   prod-deps  — production install only, which compiles better-sqlite3
#   runtime    — slim Node, the bundle, the migrations, and nothing else

# ─── build ────────────────────────────────────────────────────────────────────
FROM node:22-bookworm-slim AS build
WORKDIR /app

# better-sqlite3 publishes prebuilt binaries, but not for every platform. Having the toolchain
# present means an arm64 or musl build compiles instead of failing at install time.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
 && rm -rf /var/lib/apt/lists/*

RUN corepack enable

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

COPY . .
RUN pnpm run build

# ─── production dependencies ──────────────────────────────────────────────────
FROM node:22-bookworm-slim AS prod-deps
WORKDIR /app

RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
 && rm -rf /var/lib/apt/lists/*

RUN corepack enable

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --prod

# ─── runtime ──────────────────────────────────────────────────────────────────
FROM node:22-bookworm-slim AS runtime
WORKDIR /app

ENV NODE_ENV=production \
    PORT=8787 \
    DATABASE_PATH=/data/later.db

# pnpm's node_modules is a tree of relative symlinks into .pnpm, so it only resolves if the
# destination path matches the one it was created at. Hence /app in every stage.
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
# Read at boot by the migrator, so the database is always at the schema the code expects.
COPY drizzle ./drizzle
COPY package.json ./

# Created here rather than left to the volume mount, so the bind or named volume inherits an
# ownership the unprivileged user can actually write to.
RUN mkdir -p /data && chown -R node:node /data

USER node
EXPOSE 8787

# Uses the app's own liveness route, so an unhealthy container means the app is unhealthy
# rather than the port merely being open.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/later.js"]
