FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev --ignore-scripts

FROM node:24-bookworm-slim
ENV NODE_ENV=production DATABASE_PATH=/app/data/gildiusz.sqlite TZ=Europe/Warsaw
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json LICENSE THIRD_PARTY_NOTICES.md ./
COPY config ./config
COPY content ./content
RUN mkdir /app/data && chown node:node /app/data
USER node
STOPSIGNAL SIGTERM
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 CMD ["node", "dist/cli.js", "health"]
CMD ["node", "dist/bot/main.js"]
