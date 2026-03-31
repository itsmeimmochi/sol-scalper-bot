FROM node:22-alpine

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

COPY bot.js config.json ./
COPY lib ./lib
COPY scripts ./scripts

USER node

CMD ["sh", "-c", "node scripts/seed-config.mjs && exec node bot.js"]
