FROM node:24-slim

WORKDIR /usr/src/app

# Copy the manifests first so this layer caches, then install only what the server needs.
COPY package.json package-lock.json ./

RUN npm ci --omit=dev

COPY . ./

CMD ["node", "server.js"]
