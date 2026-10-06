# Reelarc Footage proxy worker: Node plus Debian's FFmpeg (which includes the
# ProRes encoder). Runs as-is on Railway or Fly.io; no ports needed.
FROM node:22-trixie-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg ca-certificates tini \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev --ignore-scripts

ENV NODE_ENV=production \
    WORK_DIR=/tmp/reelarc-footage-worker
USER node

# tini passes the host's stop signal to Node (so jobs are handed back cleanly)
# and tidies up finished FFmpeg processes.
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/index.js"]
