FROM node:22-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates tini python3 make g++ \
 && rm -rf /var/lib/apt/lists/* \
 && corepack enable

WORKDIR /opt/supervisor
COPY src ./src

ENV NODE_ENV=production
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "src/index.mjs"]
