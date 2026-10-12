FROM node:20-slim
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev && npm cache clean --force
COPY src ./src
COPY public ./public
ENV NODE_ENV=production TZ=Europe/Madrid DB_PATH=/data/gastos.db PORT=3000
VOLUME /data
EXPOSE 3000
CMD ["node", "src/server.js"]
