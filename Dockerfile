FROM node:20-alpine

WORKDIR /app

COPY server.js /app/server.js

EXPOSE 10000

CMD ["node", "server.js"]
