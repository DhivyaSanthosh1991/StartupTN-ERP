# Web image. Build from the repository root, telling it where the API is reachable from the web server:
#   docker build -f apps/web/Dockerfile --build-arg API_ORIGIN=http://api.internal:4000 -t startuptn-erp-web .
# API_ORIGIN is baked in at build time. If CloudFront sends /api/* straight to the API, it is never used.
FROM node:22-alpine AS build
ARG API_ORIGIN=http://localhost:4000
ENV API_ORIGIN=$API_ORIGIN NEXT_TELEMETRY_DISABLED=1
WORKDIR /repo
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN npm ci --workspace apps/web --include-workspace-root
COPY apps/web apps/web
RUN npm run build --workspace apps/web

FROM node:22-alpine AS run
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000 HOSTNAME=0.0.0.0
WORKDIR /repo
COPY --from=build /repo/apps/web/.next/standalone ./
COPY --from=build /repo/apps/web/.next/static apps/web/.next/static
RUN mkdir -p apps/web/public
USER node
EXPOSE 3000
CMD ["node", "apps/web/server.js"]
