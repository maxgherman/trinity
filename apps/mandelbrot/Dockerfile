FROM node:22-alpine

ENV NODE_ENV=production \
    PORT=8080

WORKDIR /app

COPY base/app/index.html base/app/server.js ./

RUN chown -R node:node /app

USER node

EXPOSE 8080

CMD ["node", "/app/server.js"]
