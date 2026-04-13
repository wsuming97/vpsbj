# VPS 库存监控 + Aff 导购平台

实时监控热门 VPS 商家库存状态，补货瞬间推送 Telegram 通知，引导用户通过 Affiliate 链接购买。

## 功能特性

- 🔍 **实时库存监控** — 每 5 分钟执行一轮库存检测，单轮内按并发队列逐个检查商品
- 🤖 **Telegram Bot** — 补货自动推送 + 管理员指令（/list /on /off /add /discover）
- 🕵️ **自动新品发现** — 每 4 小时扫描商家官方页面，自动识别新产品并入库
- ⚡ **内置测速** — LibreSpeed 兼容的下载/上传/Ping 速度测试
- 📊 **Web 管理后台** — 可视化库存面板 + 管理后台

## 一键部署（Docker）

### 前置要求
- VPS（2C2G 或以上）
- Docker + Docker Compose
- Telegram Bot Token（从 @BotFather 获取）

### 部署步骤

```bash
# 1. 克隆仓库
git clone https://github.com/wsuming97/vpsbj.git
cd vpsbj

# 2. 配置环境变量（推荐复制 .env.example 到 .env 后填写）
cp .env.example .env
nano .env

# 3. 一键启动
docker-compose up -d

# 4. 查看日志
docker-compose logs -f
```

启动后访问 `http://你的IP:4000` 即可看到库存监控面板。

## 手动部署（无 Docker）

```bash
# 1. 安装 Node.js 18+
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt-get install -y nodejs

# 2. 安装 Chromium（Puppeteer 依赖）
sudo apt-get install -y chromium-browser

# 3. 克隆并安装
git clone https://github.com/wsuming97/vpsbj.git
cd vpsbj
npm install

# 4. 设置环境变量
export TG_BOT_TOKEN="你的Bot Token"
export TG_CHANNEL_ID="@你的频道ID"
export TG_ADMIN_ID="你的Telegram用户ID"
export PUPPETEER_EXECUTABLE_PATH=$(which chromium-browser)

# 5. 后台运行
nohup node server.js > app.log 2>&1 &

# 或使用 pm2 守护进程（推荐）
npm install -g pm2
pm2 start server.js --name vps-tracker
pm2 save
```

## 项目结构

```
├── server.js          # Express 主服务（API + SSE + 管理接口）
├── scraper.js         # 库存检测引擎（每 5 分钟启动一轮）
├── discovery.js       # 自动新品发现引擎（每 4 小时）
├── tgBot.js           # Telegram Bot（通知 + 管理指令）
├── db.js              # SQLite 数据访问层
├── data/              # SQLite 数据文件目录（默认 vps-monitor.db）
├── Dockerfile         # Docker 构建文件
├── docker-compose.yml # Docker Compose 配置
└── public/            # 前端静态文件
    ├── index.html     # 库存监控面板
    ├── speedtest.html # 测速页面
    ├── admin.html     # 管理后台
    ├── app.js         # 前端逻辑
    └── style.css      # 样式
```

## 环境变量

| 变量 | 必填 | 说明 |
|---|---|---|
| `TG_BOT_TOKEN` | ✅ | Telegram Bot Token |
| `TG_CHANNEL_ID` | ✅ | 推送目标频道（如 @dmvpsjk） |
| `TG_ADMIN_ID` | ✅ | 管理员 Telegram 用户 ID |
| `ADMIN_TOKEN` | ❌ | 管理后台接口鉴权口令，未设置时使用服务默认值 |
| `PORT` | ❌ | 服务端口，默认 4000 |
| `SITE_URL` | ❌ | TG /site 指令返回的站点地址 |
| `PUPPETEER_EXECUTABLE_PATH` | ❌ | 手动部署时可指定 Chromium 路径 |

## Telegram Bot 指令

| 指令 | 说明 |
|---|---|
| `/start` | 查看帮助 |
| `/list` | 列出所有监控中的产品 |
| `/on <id>` | 上架指定产品 |
| `/off <id>` | 下架指定产品 |
| `/add <url> [名称]` | 添加新产品监控 |
| `/discover` | 手动触发新品发现扫描 |
| `/status` | 查看系统运行状态 |

## License

MIT
