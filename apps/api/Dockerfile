FROM node:20-alpine

WORKDIR /app

COPY package.json pnpm-lock.yaml* ./
RUN npm install -g pnpm && pnpm install --frozen-lockfile --prod

COPY . .
RUN pnpm build

EXPOSE 3001

CMD ["node", "dist/index.js"]
