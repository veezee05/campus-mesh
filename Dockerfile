FROM node:22-alpine

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY proto ./proto
COPY src ./src
COPY public ./public
COPY data ./data

# Identity, peers and ports all arrive from the environment, which is what
# lets this single image become three distinct nodes.
CMD ["node", "src/index.js"]
