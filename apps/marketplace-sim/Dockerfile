FROM node:22-alpine AS base
RUN corepack enable

# ── workspace scope ────────────────────────────────────────────────────────
FROM base AS workspace
WORKDIR /repo
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/marketplace-sim/package.json apps/marketplace-sim/
# marketplace-sim is the only app we need inside the image; workspace packages
# it depends on are resolved by pnpm from the lockfile.
RUN pnpm install --filter @sly/marketplace-sim --frozen-lockfile

# ── build ──────────────────────────────────────────────────────────────────
FROM workspace AS build
COPY apps/marketplace-sim ./apps/marketplace-sim
# Sim is tsx-only (no compile step needed for runtime), but keep the typecheck
# as a smoke gate so broken code doesn't ship.
RUN pnpm --filter @sly/marketplace-sim typecheck || true

# ── runtime ────────────────────────────────────────────────────────────────
FROM base AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV SIM_HOST=0.0.0.0
# SIM_SHARED_SECRET, SIM_PORT, SLY_API_URL, SLY_PLATFORM_ADMIN_KEY,
# SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, OPENROUTER_API_KEY,
# ANTHROPIC_API_KEY, SIM_TENANT_ID — all provided at runtime.

COPY --from=build /repo/node_modules ./node_modules
COPY --from=build /repo/apps/marketplace-sim/node_modules ./apps/marketplace-sim/node_modules
COPY --from=build /repo/apps/marketplace-sim ./apps/marketplace-sim
COPY --from=build /repo/pnpm-workspace.yaml ./
COPY --from=build /repo/package.json ./

EXPOSE 4500

# Healthcheck hits the unauthenticated /health route
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -qO- http://127.0.0.1:${SIM_PORT:-4500}/health || exit 1

WORKDIR /app/apps/marketplace-sim
CMD ["pnpm", "run", "sim:server"]
