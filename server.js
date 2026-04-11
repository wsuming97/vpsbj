import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import { runScraperCycle, stockState, catalog, reloadCatalog } from './scraper.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 4000;

// Middleware
app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// Public API endpoints
app.get('/api/vps/stock', (req, res) => {
  // Convert state object to array and filter out hidden items
  const stockList = Object.values(stockState).filter(p => !p.isHidden);
  res.json({
    success: true,
    data: stockList,
    lastScrapeTime: stockList.length > 0 ? stockList[0].lastChecked : null
  });
});

app.get('/api/vps/providers', (req, res) => {
  // Extract unique providers
  const providers = {};
  Object.values(stockState).forEach(p => {
    providers[p.provider] = p.providerName;
  });
  res.json({
    success: true,
    data: Object.entries(providers).map(([id, name]) => ({ id, name }))
  });
});

app.get('/api/vps/health', (req, res) => {
  res.json({
    success: true,
    status: 'Running',
    uptime: process.uptime(),
    catalogSize: Object.keys(stockState).length
  });
});

// Admin API - Password protection middleware
function requireAdmin(req, res, next) {
  const token = req.headers['authorization'];
  // Hardcoded for MVP, user can change later or use ENV
  if (token === 'admin888') {
    next();
  } else {
    res.status(401).json({ success: false, error: 'Unauthorized' });
  }
}

app.get('/api/admin/catalog', requireAdmin, (req, res) => {
  res.json({ success: true, data: catalog });
});

app.post('/api/admin/catalog/:id/toggle', requireAdmin, (req, res) => {
  const id = req.params.id;
  const productIndex = catalog.findIndex(p => p.id === id);
  if (productIndex === -1) return res.status(404).json({ success: false, error: 'Not found' });
  
  catalog[productIndex].isHidden = !catalog[productIndex].isHidden;
  
  // Save to disk
  fs.writeFileSync(path.join(__dirname, 'catalog.json'), JSON.stringify(catalog, null, 2));
  
  // Hot reload
  reloadCatalog();
  res.json({ success: true, isHidden: catalog[productIndex].isHidden });
});

app.post('/api/admin/catalog', requireAdmin, (req, res) => {
  const newProduct = req.body;
  if (!newProduct.id || !newProduct.name) return res.status(400).json({ success: false, error: 'Invalid product data' });
  
  catalog.push(newProduct);
  fs.writeFileSync(path.join(__dirname, 'catalog.json'), JSON.stringify(catalog, null, 2));
  
  reloadCatalog();
  res.json({ success: true, data: newProduct });
});

// ============================================================
// 测速后端端点（LibreSpeed 兼容）
// 前端 speedtest_worker.js 会调用这些路由来测量下载/上传/Ping 速度
// ============================================================

// 下载测速：生成随机数据流，客户端通过下载速度计算带宽
app.get('/speedtest/garbage', (req, res) => {
  // 生成指定大小的随机垃圾数据（默认 25MB chunk）
  const size = Math.min(parseInt(req.query.ckSize) || 25, 100); // 限制最大 100MB
  res.set({
    'Content-Type': 'application/octet-stream',
    'Content-Length': size * 1024 * 1024,
    'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
    'Access-Control-Allow-Origin': '*',
  });
  // 分块发送，避免一次性生成巨量数据占内存
  const chunkSize = 1024 * 1024; // 每次 1MB
  let remaining = size * 1024 * 1024;
  const sendChunk = () => {
    while (remaining > 0) {
      const toSend = Math.min(remaining, chunkSize);
      const buf = Buffer.alloc(toSend);
      // 填充随机数据（crypto.randomBytes 太慢，用固定 pattern 即可）
      for (let i = 0; i < toSend; i += 4) buf.writeUInt32LE(Math.random() * 0xFFFFFFFF, i);
      if (!res.write(buf)) {
        remaining -= toSend;
        res.once('drain', sendChunk);
        return;
      }
      remaining -= toSend;
    }
    res.end();
  };
  sendChunk();
});

// 上传测速 + Ping：接收客户端上传的数据并丢弃，返回空响应
app.post('/speedtest/empty', (req, res) => {
  // 消费掉所有上传数据
  req.on('data', () => {});
  req.on('end', () => {
    res.set({
      'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
      'Access-Control-Allow-Origin': '*',
    });
    res.send('');
  });
});

// Ping 测试：返回空响应（GET 版本）
app.get('/speedtest/empty', (req, res) => {
  res.set({
    'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
    'Access-Control-Allow-Origin': '*',
  });
  res.send('');
});

// 获取客户端 IP
app.get('/speedtest/getIP', (req, res) => {
  // 支持 X-Forwarded-For（Cloudflare/Nginx 代理场景）
  const ip = req.headers['cf-connecting-ip'] ||
             req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
             req.connection.remoteAddress || '未知';
  res.set({
    'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
    'Access-Control-Allow-Origin': '*',
  });
  res.send(ip);
});

// ============================================================
// 启动爬虫引擎 + TG Bot
// ============================================================

// 启动 TG Bot（含自动发现引擎）
import('./tgBot.js').then(({ initBot }) => {
  initBot();
  console.log('🤖 Telegram Bot 已启动');
}).catch(err => {
  console.error('⚠️ Telegram Bot 启动失败:', err.message);
});

// 启动库存检测轮询（每 5 分钟）
// 每个产品检测约 4-7 秒，74 款轮完需 5-8 分钟，使用 5 分钟间隔避免并发堆积
runScraperCycle();
setInterval(() => {
  runScraperCycle();
}, 5 * 60 * 1000);

app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 VPS Monitor API Server running at http://localhost:${PORT}`);
  console.log(`📊 Serving static assets from /public`);
  console.log(`⚡ Speedtest endpoints: /speedtest/garbage, /speedtest/empty, /speedtest/getIP`);
});
