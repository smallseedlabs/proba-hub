# Stage 1: Build
FROM node:20-alpine AS builder

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
COPY scripts/copy-sql.mjs ./scripts/copy-sql.mjs

RUN npm run build

# Stage 2: Production
FROM node:20-alpine

RUN addgroup -g 1001 -S proba && \
    adduser -u 1001 -S proba -G proba

WORKDIR /app

COPY package*.json ./
RUN npm ci --only=production && \
    npm cache clean --force

COPY --from=builder /app/dist ./dist
COPY --chown=proba:proba src/brain/scenarios ./dist/brain/scenarios

USER proba

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3000/health', (r) => process.exit(r.statusCode === 200 ? 0 : 1))"

CMD ["node", "dist/index.js"]
