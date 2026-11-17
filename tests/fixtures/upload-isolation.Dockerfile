FROM node:26.13.1-bookworm-slim@sha256:5df79989ed685e09f0a98019db4cebfb22fb9df1a53c0161664a011f7ff6b0f1
RUN apt-get update && apt-get install -y --no-install-recommends bubblewrap && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY scripts/catalog/publication-upload-command.ts scripts/catalog/publication-upload-isolation.ts scripts/catalog/publication-upload-relay.mjs ./scripts/catalog/
COPY tests/catalog-publication-upload-command.test.mjs tests/catalog-publication-upload-isolation.test.mjs tests/catalog-publication-upload-linux.test.mjs ./tests/
USER node
ENV CATALOG_LINUX_SANDBOX_TESTS=1
CMD ["node","--test","tests/catalog-publication-upload-command.test.mjs","tests/catalog-publication-upload-isolation.test.mjs","tests/catalog-publication-upload-linux.test.mjs"]
