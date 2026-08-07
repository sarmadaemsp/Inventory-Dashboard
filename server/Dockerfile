FROM node:22-alpine

WORKDIR /app

COPY --chown=node:node package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --chown=node:node src/ ./src/

USER node

ENV NODE_ENV=production \
    PORT=8080

EXPOSE 8080

CMD ["node", "src/server.js"]
