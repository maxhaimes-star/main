FROM node:22-slim
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY server/package.json server/
COPY client/package.json client/
RUN PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm ci --no-audit --no-fund
COPY . .
# Full card database (fails soft: without it the site still runs with only the built-in cube).
RUN npm run build-carddb && rm -rf .cache && npm run build
ENV PORT=3001 DATA_DIR=/data
EXPOSE 3001
CMD ["npm", "start"]
