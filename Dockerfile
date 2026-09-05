# SPDX-License-Identifier: MIT
# Copyright (c) 2026 commercetools GmbH and the ct-builders contributors
# Freely available, AS IS and UNSUPPORTED. See LICENSE.

FROM node:20-slim

WORKDIR /app

# Manifests first, so a code change does not invalidate the dependency layer.
COPY package.json package-lock.json ./
COPY packages/browser/package.json  packages/browser/
COPY packages/shared/package.json   packages/shared/
COPY apps/server/package.json       apps/server/
COPY examples/storefront/package.json examples/storefront/

# `--omit=dev` because the only runtime dependency is `pg`; TypeScript is here
# for the typecheck, which runs before the image is built, not inside it.
RUN npm ci --omit=dev --ignore-scripts

COPY packages/ packages/
COPY apps/ apps/
COPY scripts/ scripts/

ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080

# MODE selects collector, admin, or both. Cloud Run overrides it per service.
ENV MODE=collect

CMD ["node", "apps/server/src/server.js"]
