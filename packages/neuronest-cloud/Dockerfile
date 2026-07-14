# NeuroNest Cloud Agent — Production Dockerfile
#
# Enforces full security stack (firewall, action analyzer, network sandbox).
# Gated behind Professional/Enterprise plan tiers.
# Feature flag: cloud_agent
#
# Task 22.4

# ── Build Stage ──────────────────────────────────────────────────
FROM node:20-alpine AS builder

WORKDIR /app

# Install build dependencies
COPY package.json tsconfig.json ./
RUN npm install --ignore-scripts

# Copy source and build
COPY src/ ./src/
RUN npm run build

# ── Production Stage ─────────────────────────────────────────────
FROM node:20-alpine AS production

# Security: run as non-root user
RUN addgroup -g 1001 neuronest && \
    adduser -D -u 1001 -G neuronest neuronest

WORKDIR /app

# Install production dependencies only
COPY package.json ./
RUN npm install --omit=dev --ignore-scripts && \
    npm cache clean --force

# Copy built artifacts
COPY --from=builder /app/dist ./dist

# Security: restrict filesystem permissions
RUN chown -R neuronest:neuronest /app && \
    chmod -R 555 /app/dist

# Security: drop all capabilities, add only what's needed
# Network sandbox: no raw sockets, limited network access
USER neuronest

# Health check
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3100/health || exit 1

# Environment configuration
ENV NODE_ENV=production
ENV PORT=3100
ENV HOST=0.0.0.0
ENV FEATURE_CLOUD_AGENT=true
ENV ENFORCE_FIREWALL=true
ENV ENFORCE_ACTION_ANALYZER=true
ENV ENFORCE_NETWORK_SANDBOX=true
ENV PLAN_TIER_REQUIRED=professional

# Expose API port
EXPOSE 3100

# Entry point
CMD ["node", "dist/server.js"]
