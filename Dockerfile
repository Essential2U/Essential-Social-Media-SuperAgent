FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install --no-audit --no-fund
COPY . .
EXPOSE 8080
CMD ["npx", "tsx", "apps/api/server.ts"]
