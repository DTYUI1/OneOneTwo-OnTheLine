FROM node:20.19.5-alpine
ENV SCARF_ANALYTICS=false
WORKDIR /workspace
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/web/package.json apps/web/package.json
RUN pnpm install --frozen-lockfile
COPY contracts contracts
USER node
CMD ["pnpm", "exec", "prism", "mock", "contracts/openapi.draft.yaml", "-h", "0.0.0.0", "-p", "4010"]
