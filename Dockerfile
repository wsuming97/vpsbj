FROM node:20-alpine

# Set working directory
WORKDIR /app

# Install native dependencies for Puppeteer (Chromium) and better-sqlite3 (编译原生模块)
RUN apk add --no-cache \
      chromium \
      nss \
      freetype \
      harfbuzz \
      ca-certificates \
      ttf-freefont \
      nodejs \
      yarn \
      # better-sqlite3 原生模块编译依赖
      build-base \
      python3

# Skip downloading Chromium, use the installed one
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium-browser

# Copy package.json and install dependencies
COPY package.json package-lock.json* ./
RUN npm install

# Copy all source files
COPY . .

# Ensure data directory exists and has permissions (SQLite 数据库文件目录)
RUN mkdir -p data && chmod 777 data

# Start the application
CMD ["npm", "start"]
