FROM node:18-alpine

# Set working directory
WORKDIR /app

# Install native dependencies for Puppeteer (Chromium and required libs)
RUN apk add --no-cache \
      chromium \
      nss \
      freetype \
      harfbuzz \
      ca-certificates \
      ttf-freefont \
      nodejs \
      yarn

# Skip downloading Chromium, use the installed one
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium-browser

# Copy package.json and install dependencies
COPY package.json package-lock.json* ./
RUN npm install

# Copy all source files
COPY . .

# Ensure data directory exists and has permissions
RUN mkdir -p data && chmod 777 data

# Start the application
CMD ["npm", "start"]
