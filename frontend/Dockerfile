FROM node:22-alpine AS build

WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml ./
RUN --mount=type=cache,id=lma-pnpm,target=/pnpm/store,sharing=locked \
    pnpm install --frozen-lockfile --store-dir=/pnpm/store
COPY . .
RUN pnpm build

FROM nginx:1.27-alpine

COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html

EXPOSE 80
