FROM node:20-alpine

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci --production=false

COPY tsconfig.json ./
COPY src/ ./src/
COPY server.ts ./
RUN npm run build

RUN npm prune --production

EXPOSE 3000

ENV NODE_ENV=production

CMD ["node", "dist/server.js"]
