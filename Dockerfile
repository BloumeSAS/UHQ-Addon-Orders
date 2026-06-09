# ═══════════════════════════════════════════════════════════════════════════════
# UHQ Orders Addon — Dockerfile
# Build multi-stage : web (React/Vite) → api (NestJS) → runner
#
# Compatible Coolify / Docker Compose.
# Volume persistant recommandé : /app/data  (contient orders-data.json)
# Port exposé : 3002
# ═══════════════════════════════════════════════════════════════════════════════

# ── Stage 1 : Build React ────────────────────────────────────────────────────
FROM node:20-alpine AS web-builder
WORKDIR /build/web
COPY web/package*.json ./
RUN npm install --no-audit --no-fund --legacy-peer-deps
COPY web/ ./
RUN npm run build

# ── Stage 2 : Build NestJS ───────────────────────────────────────────────────
FROM node:20-alpine AS api-builder
WORKDIR /build/api
COPY api/package*.json ./
RUN npm install --no-audit --no-fund --legacy-peer-deps
COPY api/ ./
RUN npm run build
# Supprime les devDependencies
RUN npm prune --production --legacy-peer-deps

# ── Stage 3 : Runner ─────────────────────────────────────────────────────────
FROM node:20-alpine AS runner
WORKDIR /app

# Copie les artefacts de build
COPY --from=api-builder /build/api/dist        ./api/dist
COPY --from=api-builder /build/api/node_modules ./api/node_modules
COPY --from=web-builder /build/web/dist        ./web/dist
COPY uhq-manifest.json ./

# Répertoire des données persistantes
RUN mkdir -p /app/data
VOLUME ["/app/data"]

# Seul le port NestJS est exposé (pas le port Vite dev)
EXPOSE 3002

ENV NODE_ENV=production \
    PORT=3002 \
    DB_PATH=/app/data/orders-data.json

# Healthcheck
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD wget -qO- http://localhost:3002/uhq-manifest.json | grep -q '"name"' || exit 1

CMD ["node", "api/dist/main"]
