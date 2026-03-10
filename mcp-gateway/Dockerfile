FROM node:20-alpine

WORKDIR /app

# Python3 pour scripts maintenance, curl pour healthcheck
RUN apk add --no-cache python3 curl

# Dependances (depuis mcp-gateway/)
COPY mcp-gateway/package.json mcp-gateway/package-lock.json ./
RUN npm install --production

# Code source — server.js integre a l'image (pas de bind mount fichier)
COPY server.js ./server.js
COPY shared/ ./shared/
COPY routes/ ./routes/

# Entrypoint + config
COPY mcp-gateway/entrypoint.sh ./entrypoint.sh
COPY mcp-gateway/connectors.json ./connectors.json
RUN chmod +x /app/entrypoint.sh

EXPOSE 4000

ENTRYPOINT ["/app/entrypoint.sh"]
