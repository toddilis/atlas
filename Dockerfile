# Atlas API + worker image (PR-O). One image, two commands — fly.toml's [processes]
# selects `node dist/api/server.js` or `node dist/worker/main.js` per process group.
# syntax=docker/dockerfile:1

FROM node:20-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:20-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
EXPOSE 3001
# Default command is the API; the worker process group overrides it (fly.toml).
CMD ["node", "dist/api/server.js"]
