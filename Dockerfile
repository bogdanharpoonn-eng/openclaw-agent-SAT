FROM node:20-bookworm-slim

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY index.js agents.json bybit.js bybit-strategy.js ./
COPY prompts ./prompts

ENV NODE_ENV=production

EXPOSE 8080

CMD ["npm", "start"]
