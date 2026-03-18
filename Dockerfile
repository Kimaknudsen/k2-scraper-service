FROM mcr.microsoft.com/playwright:v1.49.0-noble

WORKDIR /app
COPY package.json ./
RUN npm install --production
COPY src/ ./src/

ENV PORT=3001
EXPOSE 3001
CMD ["node", "src/server.js"]
