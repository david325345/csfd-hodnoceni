FROM node:22-slim

WORKDIR /app
ENV NODE_ENV=production \
    DB_PATH=/data/csfd-ratings.db \
    PORT=7020

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY src ./src

VOLUME ["/data"]
EXPOSE 7020

HEALTHCHECK --interval=60s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||7020)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "--disable-warning=ExperimentalWarning", "src/index.js"]
