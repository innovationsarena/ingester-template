# syntax=docker/dockerfile:1

ARG NODE_VERSION=22-alpine

# --- deps: full install, cached on the lockfile alone -------------------------
FROM node:${NODE_VERSION} AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

# --- build: compile TypeScript to dist/ ---------------------------------------
FROM deps AS build
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# --- prod-deps: runtime dependencies only -------------------------------------
FROM node:${NODE_VERSION} AS prod-deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# --- runtime ------------------------------------------------------------------
FROM node:${NODE_VERSION} AS runtime
WORKDIR /app

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000

COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./

# node:alpine ships an unprivileged `node` user (uid 1000).
USER node

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# server.ts traps SIGTERM/SIGINT, so node can run as PID 1 without an init shim.
CMD ["node", "dist/server.js"]
