FROM node:20-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 python3-pip ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

RUN pip3 install --break-system-packages --no-cache-dir "scrapling[all]>=0.4.5"
RUN scrapling install --force

COPY . .

ENV NODE_ENV=production
ENV SCRAPLING_BIN=/usr/local/bin/scrapling
ENV PORT=8080

EXPOSE 8080

CMD ["npm", "start"]

