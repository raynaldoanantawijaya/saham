# Use Node.js LTS (Slim version)
FROM node:18-slim

# Install latest chrome dev package and fonts to support major charsets (Chinese, Japanese, Arabic, Hebrew, Thai and a few others)
# Note: this installs the necessary libs to make the bundled version of Chromium that Puppeteer
# installs, work.
RUN apt-get update && apt-get install -y \
    wget \
    gnupg \
    procps \
    && wget -q -O - https://dl-ssl.google.com/linux/linux_signing_key.pub | apt-key add - \
    && sh -c 'echo "deb [arch=amd64] http://dl.google.com/linux/chrome/deb/ stable main" >> /etc/apt/sources.list.d/google.list' \
    && apt-get update \
    && apt-get install -y google-chrome-stable fonts-ipafont-gothic fonts-wqy-zenhei fonts-thai-tlwg fonts-kacst fonts-freefont-ttf libxss1 \
      --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

# Create app directory
WORKDIR /usr/src/app

# Copy package files
COPY package*.json ./

# Install dependencies (including puppeteer)
# Note: This installs Puppeteer which downloads a compatible Chrome binary to node_modules/puppeteer
RUN npm install

# Copy source code
COPY . .

# Create the session directory and give permissions (for persistent session if using persistent disk, otherwise it's ephemeral)
RUN mkdir -p browser_session

# Expose port
EXPOSE 3000

# Start server
CMD [ "node", "server.js" ]
