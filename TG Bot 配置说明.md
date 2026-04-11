# TG Bot 配置说明

## 1. 安装依赖

项目里已安装：

```bash
npm install node-telegram-bot-api
```

## 2. 获取 Bot Token

1. 在 Telegram 里搜索 `@BotFather`
2. 发送 `/newbot`
3. 按提示设置 Bot 名称和用户名
4. 创建成功后复制 Bot Token

## 3. 创建公开频道并接入 Bot

1. 新建一个公开频道
2. 把你的 Bot 拉进频道
3. 给 Bot 管理员权限
4. 至少开启“发布消息”权限

## 4. 获取频道 ID

### 方式 A：直接用公开频道用户名
如果你的频道有公开用户名，可以直接这样配：

```bash
TG_CHANNEL_ID=@your_channel_username
```

### 方式 B：使用真实 chat id
把 Bot 拉进频道后发一条消息，再调用 Telegram Bot API 的 `getUpdates` 查看频道 chat id。

## 5. 设置环境变量

Windows CMD 示例：

```bash
set TG_BOT_TOKEN=你的bot_token
set TG_CHANNEL_ID=@你的频道用户名
set TG_BOT_NAME=VPS Aff Monitor
set TG_ENABLE_POLLING=true
```

如果你只是要让后端自动推送，不需要命令监听，也可以不设 `TG_ENABLE_POLLING` 或设为 `false`。

## 6. 启动方式

### 启动主服务

```bash
npm start
```

当商品状态从 `无货` 变为 `有货` 时，会自动调用 `notifyStockChange(product)` 推送到频道。

### 单独启动 Bot 命令监听

```bash
node tgBot.js
```

可用命令：

- `/start`
- `/ping`
- `/help`

## 7. 代码接入点

- `tgBot.js`：封装消息模板、按钮、发送逻辑、基础命令监听
- `tgNotifier.js`：提供 `notifyStockChange(product)`
- `scraper.js`：检测到 `无货 -> 有货` 时自动触发推送

## 8. 当前消息内容

补货消息包含：

- 产品名
- 商家
- 配置信息
- 价格
- 机房
- 带按钮的购买链接

使用 Telegram HTML 格式发送，并附带“立即购买”按钮。
