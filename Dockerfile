FROM node:20-alpine

# Set working directory
WORKDIR /app

# 仅需 better-sqlite3 原生模块编译依赖（已移除 Chromium/Puppeteer）
RUN apk add --no-cache \
      build-base \
      python3

# Copy package.json and install dependencies
COPY package.json package-lock.json* ./
RUN npm install

# Copy all source files
COPY . .

# Ensure data directory exists and has permissions (SQLite 数据库文件目录)
RUN mkdir -p data && chmod 777 data

# Start the application
CMD ["npm", "start"]
