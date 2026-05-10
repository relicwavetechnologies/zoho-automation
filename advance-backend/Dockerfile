# syntax=docker/dockerfile:1.7

FROM node:22-slim AS base
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
WORKDIR /app
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates openssl dumb-init \
  && rm -rf /var/lib/apt/lists/* \
  && corepack enable \
  && corepack prepare pnpm@10.33.4 --activate

FROM base AS deps
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --prod --frozen-lockfile

FROM base AS runner
ENV NODE_ENV=production
ENV PORT=3001
COPY --from=deps /app/node_modules ./node_modules
COPY package.json pnpm-lock.yaml ./
COPY prisma ./prisma
COPY scripts ./scripts
COPY src ./src
RUN pnpm prisma:generate
EXPOSE 3001
CMD ["dumb-init", "pnpm", "start"]
