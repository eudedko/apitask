FROM docker.io/library/node:lts-slim

# ENV NODE_ENV=production

WORKDIR /app

COPY --chown=node:node package.json package-lock.json* ./

RUN if [ -f package-lock.json ]; then \
      npm ci --omit=dev; \
    else \
      npm install --omit=dev; \
    fi \
    && npm cache clean --force

COPY --chown=node:node server.js ./

USER node

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "server.js"]
