FROM node:26-slim
RUN npm install -g pnpm@12.16.1
WORKDIR /app

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json ./
COPY packages/proto/package.json packages/proto/
COPY server/package.json server/
COPY cli/package.json cli/
RUN pnpm install --frozen-lockfile

COPY packages/proto packages/proto
COPY server server
COPY cli cli
RUN pnpm --filter @gridelta/server build \
 && ln -s /app/cli/bin/gridelta.js /usr/local/bin/gridelta

WORKDIR /app/server
ENV PORT=3000 GRIDELTA_GATEWAY_PORT=8443 GRIDELTA_DATA_DIR=/var/lib/gridelta
VOLUME /var/lib/gridelta
EXPOSE 3000 8443
CMD ["node", "dist/server.mjs"]
