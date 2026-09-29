FROM node:20.19.5-alpine AS build
ENV SCARF_ANALYTICS=false
WORKDIR /workspace
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/web/package.json apps/web/package.json
RUN pnpm install --frozen-lockfile
COPY apps/web apps/web
COPY contracts contracts
RUN pnpm build
FROM nginx:1.28.0-alpine
COPY --from=build /workspace/apps/web/dist /usr/share/nginx/html/app
COPY deploy/nginx/default.conf /etc/nginx/conf.d/default.conf
