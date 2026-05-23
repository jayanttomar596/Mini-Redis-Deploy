FROM node:22-bookworm-slim AS build

WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends build-essential make \
    && rm -rf /var/lib/apt/lists/*

COPY MiniRedis ./MiniRedis
COPY web-dashboard ./web-dashboard

RUN make -C MiniRedis clean app
RUN cd web-dashboard && npm install --omit=dev

FROM node:22-bookworm-slim

WORKDIR /app

COPY --from=build /app/MiniRedis ./MiniRedis
COPY --from=build /app/web-dashboard ./web-dashboard

ENV NODE_ENV=production
ENV DASHBOARD_HOST=0.0.0.0
ENV MINI_REDIS_HOST=127.0.0.1
ENV MINI_REDIS_PORT=8080
ENV MINI_REDIS_AUTOSTART=1

WORKDIR /app/web-dashboard

EXPOSE 5173

CMD ["node", "server.js"]
