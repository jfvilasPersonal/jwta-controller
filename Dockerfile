FROM node:18

WORKDIR /usr/controller
COPY . .
CMD [ "node", "./dist/index.js" ]