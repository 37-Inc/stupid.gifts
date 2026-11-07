FROM node:22-bookworm-slim@sha256:5ec23b7c622b00547753bc6ffd78085dd868a68aeb41c8e0a1418f033e13d96d
RUN apt-get update && apt-get install -y --no-install-recommends bubblewrap && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY scripts/catalog/publication-upload-command.ts scripts/catalog/publication-upload-isolation.ts scripts/catalog/publication-upload-relay.mjs ./scripts/catalog/
COPY tests/catalog-publication-upload-command.test.mjs tests/catalog-publication-upload-isolation.test.mjs tests/catalog-publication-upload-linux.test.mjs ./tests/
USER node
ENV NODE_OPTIONS=--experimental-transform-types CATALOG_LINUX_SANDBOX_TESTS=1
CMD ["node","--test","tests/catalog-publication-upload-command.test.mjs","tests/catalog-publication-upload-isolation.test.mjs","tests/catalog-publication-upload-linux.test.mjs"]
