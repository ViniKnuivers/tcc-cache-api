# Imagem da API usada nos experimentos (versões fixadas).
FROM node:24.18.0-alpine

WORKDIR /app
RUN corepack enable

# Dependências primeiro (camada reaproveitada entre builds).
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY prisma ./prisma
COPY prisma.config.ts tsconfig.json ./
RUN pnpm install --frozen-lockfile

COPY src ./src
RUN pnpm exec prisma generate

ENV NODE_ENV=production
EXPOSE 3000
CMD ["node_modules/.bin/tsx", "src/server.ts"]
