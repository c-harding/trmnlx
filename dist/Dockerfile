FROM node:24-slim

WORKDIR /usr/src/app

# Copy the manifests first so this layer caches, then install only what the server needs.
COPY package.json package-lock.json ./

RUN npm ci --omit=dev

COPY . ./

# Refuse to build an image whose config is broken: `docker compose up --build` then stops before
# replacing the running container. .env (not part of the image) is mounted for this step only, as a
# build secret, so its values aren't stored in the image. Docker doesn't see a change in a secret,
# so ENV_HASH (from scripts/deploy) makes it rerun the check when .env changes.
ARG ENV_HASH
RUN --mount=type=secret,id=env node --env-file=/run/secrets/env server.js --check-config

CMD ["node", "server.js"]
