import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import { runScraperCycle, stockState, catalog, reloadCatalog } from './scraper.js';
import db from './db.js';
import eventBus from './eventBus.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 4000;

// Middleware
app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// ── 一次性迁移：清除已废弃商家 CloudCone 的全部数据 ──
{
  const ccProducts = db.db.prepare("SELECT id FROM products WHERE provider = 'cloudcone'").all();
  if (ccProducts.length > 0) {
    for (const p of ccProducts) db.purgeProduct(p.id);
    reloadCatalog();
    console.log(`[Migration] 🧹 已清除 ${ccProducts.length} 个废弃 CloudCone 产品并拉黑`);
  }
}

// Public API endpoints
app.get('/api/vps/stock', (req, res) => {
  // 网页前端只显示有货的产品（非隐藏 + inStock === true）
  // 支持 ?all=1 查询参数返回全部（供调试用）
  const showAll = req.query.all === '1';
  const stockList = Object.values(stockState).filter(p => {
    if (p.isHidden) return false;
    // 隐藏还未人工补全价格（处于待确认状态）的商品
    if (p.price === '待确认' || p.price === '价格待确认') return false; 
    if (showAll) return true;
    return p.inStock === true;
  });
  res.json({
    success: true,
    data: stockList,
    lastScrapeTime: stockList.length > 0 ? stockList[0].lastChecked : null
  });
});

app.get('/api/vps/providers', (req, res) => {
  // 只返回有在售（有货）商品的商家
  const providers = {};
  Object.values(stockState).forEach(p => {
    if (!p.isHidden && p.inStock === true) {
      providers[p.provider] = p.providerName;
    }
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

// ── SSE：实时推送库存变化到前端 ──
const sseClients = new Set();

app.get('/api/sse', (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',  // 禁用 nginx 缓冲
  });
  res.flushHeaders();

  // 发送初始完整库存快照
  const initData = Object.values(stockState).filter(p => !p.isHidden);
  res.write(`data: ${JSON.stringify({ type: 'init', data: initData })}\n\n`);

  sseClients.add(res);

  // 保活 ping，每 20 秒，用真正的 data 帧（注释行部分 Nginx 不计入活跃流量）
  const ping = setInterval(() => res.write(`data: ${JSON.stringify({ type: 'ping' })}\n\n`), 20000);

  req.on('close', () => {
    clearInterval(ping);
    sseClients.delete(res);
  });
});

function broadcastSSE(payload) {
  const msg = `data: ${JSON.stringify(payload)}\n\n`;
  sseClients.forEach(res => {
    try { res.write(msg); } catch (_) { sseClients.delete(res); }
  });
}

// 监听库存变化事件，广播给所有 SSE 客户端
eventBus.on('stock:changed', product => {
  broadcastSSE({ type: 'stock_update', product });
});

// 每轮扫描完成后广播进度
eventBus.on('cycle:done', info => {
  broadcastSSE({ type: 'cycle_done', ...info, ts: new Date().toISOString() });
});

app.get('/api/vps/stock/:productId', (req, res) => {
  const { productId } = req.params;
  const product = stockState[productId] || catalog.find(p => p.id === productId);

  if (!product || product.isHidden) {
    return res.status(404).json({ success: false, error: 'Product not found' });
  }

  res.json({ success: true, data: product });
});


// Admin API - Password protection middleware
function requireAdmin(req, res, next) {
  const token = req.headers['authorization'];
  const adminToken = process.env.ADMIN_TOKEN || 'admin888';
  if (token === adminToken) {
    next();
  } else {
    res.status(401).json({ success: false, error: 'Unauthorized' });
  }
}

// ── 垃圾/待确认判定逻辑（唯一 truth source，前端直接读后端字段） ──
const JUNK_PATTERNS = [
  /oops/i, /there's a problem/i, /invalid/i, /404/i, /not found/i,
  /shopping cart/i, /error/i, /stack error/i, /encountered a problem/i,
  /just a moment/i, /checking your browser/i, /cloudflare/i,
  /shared hosting/i, /cpanel/i, /reseller/i, /dedicated server/i,
  /virtual web hosting/i, /ssl certificate/i
];
function isJunkProduct(p) {
  return JUNK_PATTERNS.some(pat => pat.test(p.name));
}
function isPendingProduct(p) {
  if (isJunkProduct(p)) return false;
  return (p.price === '待确认' || p.price === '价格待确认');
}

app.get('/api/admin/catalog', requireAdmin, (req, res) => {
  // 附加分类字段，前端直接使用，不再维护独立正则
  const tagged = catalog.map(p => ({
    ...p,
    _isJunk: isJunkProduct(p),
    _isPending: isPendingProduct(p),
  }));
  res.json({ success: true, data: tagged });
});

app.post('/api/admin/catalog/:id/toggle', requireAdmin, (req, res) => {
  const id = req.params.id;
  const product = db.getProduct(id);
  if (!product) return res.status(404).json({ success: false, error: 'Not found' });
  
  const newHidden = !product.isHidden;
  db.updateProduct(id, { isHidden: newHidden });
  
  // Hot reload
  reloadCatalog();
  res.json({ success: true, isHidden: newHidden });
});

app.post('/api/admin/catalog', requireAdmin, (req, res) => {
  const newProduct = req.body;
  if (!newProduct.id || !newProduct.name) return res.status(400).json({ success: false, error: 'Invalid product data' });
  
  // 管理员手动添加 → 从黑名单移除（如果之前被清理过）
  db.clearPurgedId(newProduct.id);
  db.addProduct(newProduct);
  
  reloadCatalog();
  res.json({ success: true, data: newProduct });
});

// 编辑产品信息（名称、价格、优惠码等）
app.put('/api/admin/catalog/:id', requireAdmin, (req, res) => {
  const id = req.params.id;
  const product = db.getProduct(id);
  if (!product) return res.status(404).json({ success: false, error: 'Not found' });
  
  const updates = req.body;
  // 允许编辑的字段白名单
  const editable = ['name', 'price', 'promoCode', 'isHidden', 'affUrl', 'checkUrl', 'billingCycles', 'testEndpoints', 'locked', 'source', 'isSpecialOffer', 'specs', 'datacenters', 'networkRoutes', 'outOfStockKeywords'];
  const filteredUpdates = {};
  editable.forEach(field => {
    if (updates[field] !== undefined) {
      filteredUpdates[field] = updates[field];
    }
  });
  
  // 如果修改了价格，记录历史
  if (filteredUpdates.price && filteredUpdates.price !== product.price) {
    db.recordPriceChange(id, product.price, filteredUpdates.price);
  }
  
  db.updateProduct(id, filteredUpdates);
  reloadCatalog();
  res.json({ success: true, data: db.getProduct(id) });
});

// 删除产品
app.delete('/api/admin/catalog/:id', requireAdmin, (req, res) => {
  const id = req.params.id;
  if (!db.productExists(id)) return res.status(404).json({ success: false, error: 'Not found' });
  
  db.deleteProduct(id);
  reloadCatalog();
  res.json({ success: true });
});

// 批量清理「待确认」+ 垃圾产品（一键清空无效数据）
app.post('/api/admin/purge-pending', requireAdmin, (req, res) => {
  const allProducts = db.getAllProducts();
  
  // 复用模块级 isJunkProduct / isPendingProduct 判定逻辑
  const pendingItems = allProducts.filter(p => {
    if (isJunkProduct(p)) return true;
    if (!isPendingProduct(p)) return false;
    // 待确认 + 名称含"自动发现"/"新品" 才清理
    return p.name.includes('自动发现') || p.name.includes('新品');
  });
  
  let deleted = 0;
  for (const item of pendingItems) {
    db.purgeProduct(item.id); // purge = 删除 + 拉黑，垃圾数据永不重新扫入
    deleted++;
  }
  
  if (deleted > 0) reloadCatalog();
  
  console.log(`[Admin] 🧹 批量清理了 ${deleted} 个垃圾/待确认产品`);
  res.json({ success: true, deleted });
});

// 批量删除选中的产品（前端勾选后调用）
app.post('/api/admin/batch-delete', requireAdmin, (req, res) => {
  const { ids } = req.body;
  if (!Array.isArray(ids) || ids.length === 0) {
    return res.status(400).json({ success: false, error: 'ids 为空' });
  }
  
  let deleted = 0;
  for (const id of ids) {
    if (db.productExists(id)) {
      db.deleteProduct(id);
      deleted++;
    }
  }
  
  if (deleted > 0) reloadCatalog();
  console.log(`[Admin] 🗑 批量删除了 ${deleted} 个产品`);
  res.json({ success: true, deleted });
});

// ============================================================
// 历史数据 API
// ============================================================

// 获取某产品的价格和库存变动历史
app.get('/api/vps/stock/:productId/history', (req, res) => {
  const { productId } = req.params;
  if (!db.productExists(productId)) {
    return res.status(404).json({ success: false, error: 'Product not found' });
  }
  const priceHistory = db.getPriceHistory(productId);
  const stockEvents = db.getStockEvents(productId);
  res.json({ success: true, data: { priceHistory, stockEvents } });
});

// 获取全局最近动态事件
app.get('/api/vps/events', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 20, 100);
  const events = db.getRecentEvents(limit);
  res.json({ success: true, data: events });
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
