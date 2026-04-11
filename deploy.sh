#!/bin/bash
# VPS 库存监控平台 — 一键部署脚本
# 使用方法: curl -fsSL https://raw.githubusercontent.com/你的用户名/vps-tracker/main/deploy.sh | bash

set -e

echo "═══════════════════════════════════════"
echo "  VPS 库存监控平台 — 一键部署"
echo "═══════════════════════════════════════"

# 检查 Docker
if ! command -v docker &> /dev/null; then
  echo "📦 正在安装 Docker..."
  curl -fsSL https://get.docker.com | sh
  systemctl enable docker
  systemctl start docker
fi

# 检查 Docker Compose
if ! command -v docker-compose &> /dev/null && ! docker compose version &> /dev/null; then
  echo "📦 正在安装 Docker Compose..."
  apt-get install -y docker-compose-plugin 2>/dev/null || pip install docker-compose
fi

# 克隆项目
INSTALL_DIR="/opt/vps-tracker"
if [ -d "$INSTALL_DIR" ]; then
  echo "📁 检测到已有安装，正在更新..."
  cd $INSTALL_DIR
  git pull
else
  echo "📥 正在克隆项目..."
  git clone https://github.com/你的用户名/vps-tracker.git $INSTALL_DIR
  cd $INSTALL_DIR
fi

# 交互式配置
echo ""
echo "═══════════════════════════════════════"
echo "  环境配置"
echo "═══════════════════════════════════════"

read -p "Telegram Bot Token: " TG_BOT_TOKEN
read -p "Telegram 频道 ID (如 @dmvpsjk): " TG_CHANNEL_ID
read -p "管理员 Telegram ID (数字): " TG_ADMIN_ID
read -p "服务端口 [默认 4000]: " PORT
PORT=${PORT:-4000}

# 写入 docker-compose.yml
cat > docker-compose.yml <<EOF
version: '3.8'

services:
  vps-tracker:
    build: .
    container_name: vps-tracker
    restart: unless-stopped
    ports:
      - "${PORT}:4000"
    environment:
      - NODE_ENV=production
      - TG_BOT_TOKEN=${TG_BOT_TOKEN}
      - TG_CHANNEL_ID=${TG_CHANNEL_ID}
      - TG_ADMIN_ID=${TG_ADMIN_ID}
    volumes:
      - ./catalog.json:/app/catalog.json
      - ./public:/app/public
EOF

echo ""
echo "🚀 正在构建并启动容器..."
docker compose up -d --build 2>/dev/null || docker-compose up -d --build

echo ""
echo "═══════════════════════════════════════"
echo "  ✅ 部署完成！"
echo "═══════════════════════════════════════"
echo ""
echo "  📊 监控面板: http://$(curl -s ifconfig.me):${PORT}"
echo "  ⚡ 测速页面: http://$(curl -s ifconfig.me):${PORT}/speedtest.html"
echo "  🤖 TG Bot:   已启动，向你的 Bot 发送 /start"
echo ""
echo "  管理命令:"
echo "    查看日志: docker logs -f vps-tracker"
echo "    重启服务: docker restart vps-tracker"
echo "    停止服务: docker stop vps-tracker"
echo ""
