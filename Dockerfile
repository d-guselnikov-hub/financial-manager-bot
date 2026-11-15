FROM node:24-alpine@sha256:116b800c3754b440ee0aa3ed2f20f5bf3d99a554bfd9adeea09ea8017f6e85f5
WORKDIR /opt/finance-runtime
COPY package.json package-lock.json ./
RUN apk add --no-cache font-noto \
    && npm ci --omit=dev --no-audit --no-fund \
    && npm cache clean --force \
    && ln -s /opt/finance-runtime/node_modules /node_modules
WORKDIR /app
