FROM node:22-slim
WORKDIR /app
COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY server/package.json server/
COPY client/package.json client/
RUN PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm ci --no-audit --no-fund
COPY . .
RUN npm run build
ENV PORT=3001 DATA_DIR=/data
EXPOSE 3001
CMD ["npm", "start"]
