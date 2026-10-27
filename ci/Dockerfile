# Build from the repo root so the ci folder's linked packages (inngest, @inngest/ci) are built from source:
#   flyctl deploy --config ci/fly.toml --dockerfile ci/Dockerfile --app inngest-js-ci
FROM node:24-slim
WORKDIR /app
RUN npm install --global pnpm@10.12.1
COPY . .
RUN pnpm install --frozen-lockfile --ignore-scripts --filter "inngest..." --filter "@inngest/ci..." \
 && pnpm --filter inngest run build \
 && pnpm --filter @inngest/ci run build
WORKDIR /app/ci
RUN pnpm install --frozen-lockfile --ignore-scripts --ignore-workspace
ENV NODE_ENV=production
USER node
CMD ["node", "--import", "tsx", "worker.ts"]
