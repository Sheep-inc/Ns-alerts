FROM node:22-slim
ENV TZ=Europe/Amsterdam DATA_DIR=/app/data
RUN apt-get update && apt-get install -y --no-install-recommends tzdata \
 && rm -rf /var/lib/apt/lists/* \
 && mkdir -p /app/data && chown node:node /app/data
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY app.js auth.js db.js detect.js digest.js security.js ./
COPY static ./static
COPY seed ./seed
USER node
VOLUME /app/data
EXPOSE 8780
HEALTHCHECK --interval=60s --timeout=5s CMD node --input-type=module -e "const r=await fetch('http://127.0.0.1:8780/healthz',{signal:AbortSignal.timeout(4000)}); if(!r.ok) process.exit(1)"
CMD ["node", "app.js"]
