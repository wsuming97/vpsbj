/**
 * db.js — SQLite 数据访问层
 *
 * 职责：
 *   1. 管理 SQLite 数据库连接和表结构
 *   2. 首次启动时从 catalog.json 一次性迁移数据
 *   3. 封装所有读写操作，供 scraper / discovery / server 调用
 *   4. 记录价格变动和库存事件历史
 *
 * 数据库文件位置：./data/vps.db（Docker 部署时通过 volume 挂载到宿主机）
 */

import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 确保 data 目录存在
const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const DB_PATH = path.join(dataDir, 'vps-monitor.db');
const db = new Database(DB_PATH);

// 启用 WAL 模式，提升并发读写性能
db.pragma('journal_mode = WAL');

// ============================================================
// 建表
// ============================================================
function createTables() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS products (
      id                  TEXT PRIMARY KEY,
      provider            TEXT NOT NULL,
      provider_name       TEXT,
      name                TEXT NOT NULL,
      specs               TEXT DEFAULT '{}',
      price               TEXT,
      billing_cycles      TEXT DEFAULT '{}',
      check_url           TEXT,
      aff_url             TEXT,
      datacenters         TEXT DEFAULT '[]',
      network_routes      TEXT DEFAULT '[]',
      out_of_stock_keywords TEXT DEFAULT '[]',
      test_endpoints      TEXT DEFAULT '[]',
      speedtest_url       TEXT,
      promo_code          TEXT,
      priority            TEXT DEFAULT 'medium',
      is_special_offer    INTEGER DEFAULT 0,
      is_hidden           INTEGER DEFAULT 0,
      source              TEXT DEFAULT 'manual',
      locked              INTEGER DEFAULT 0,
      created_at          TEXT DEFAULT (datetime('now')),
      updated_at          TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS price_history (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      product_id    TEXT NOT NULL,
      old_price     TEXT,
      new_price     TEXT,
      billing_cycles TEXT,
      changed_at    TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (product_id) REFERENCES products(id)
    );

    CREATE TABLE IF NOT EXISTS stock_events (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      product_id      TEXT NOT NULL,
      event_type      TEXT NOT NULL,
      price_at_event  TEXT,
      occurred_at     TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (product_id) REFERENCES products(id)
    );

    CREATE INDEX IF NOT EXISTS idx_price_history_product ON price_history(product_id);
    CREATE INDEX IF NOT EXISTS idx_stock_events_product ON stock_events(product_id);
    CREATE INDEX IF NOT EXISTS idx_products_provider ON products(provider);
  `);
}

// ============================================================
// 从 catalog.json 一次性迁移
// ============================================================
function migrateFromCatalog() {
  const catalogPath = path.join(__dirname, 'catalog.json');
  if (!fs.existsSync(catalogPath)) {
    console.log('[DB] catalog.json 不存在，跳过迁移');
    return;
  }

  // 检查数据库是否已有数据
  const count = db.prepare('SELECT COUNT(*) as cnt FROM products').get();
  if (count.cnt > 0) {
    console.log(`[DB] 数据库已有 ${count.cnt} 条产品，跳过迁移`);
    return;
  }

  console.log('[DB] 首次启动，从 catalog.json 导入数据...');
  const catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));

  const insert = db.prepare(`
    INSERT OR IGNORE INTO products (
      id, provider, provider_name, name, specs, price, billing_cycles,
      check_url, aff_url, datacenters, network_routes, out_of_stock_keywords,
      test_endpoints, speedtest_url, promo_code, priority,
      is_special_offer, is_hidden, source, locked
    ) VALUES (
      @id, @provider, @provider_name, @name, @specs, @price, @billing_cycles,
      @check_url, @aff_url, @datacenters, @network_routes, @out_of_stock_keywords,
      @test_endpoints, @speedtest_url, @promo_code, @priority,
      @is_special_offer, @is_hidden, @source, @locked
    )
  `);

  const insertMany = db.transaction((products) => {
    for (const p of products) {
      insert.run({
        id: p.id,
        provider: p.provider,
        provider_name: p.providerName || null,
        name: p.name,
        specs: JSON.stringify(p.specs || {}),
        price: p.price || null,
        billing_cycles: JSON.stringify(p.billingCycles || {}),
        check_url: p.checkUrl || null,
        aff_url: p.affUrl || null,
        datacenters: JSON.stringify(p.datacenters || []),
        network_routes: JSON.stringify(p.networkRoutes || []),
        out_of_stock_keywords: JSON.stringify(p.outOfStockKeywords || []),
        test_endpoints: JSON.stringify(p.testEndpoints || []),
        speedtest_url: p.speedtestUrl || null,
        promo_code: p.promoCode || null,
        priority: p.priority || 'medium',
        is_special_offer: p.isSpecialOffer ? 1 : 0,
        is_hidden: p.isHidden ? 1 : 0,
        source: 'manual',  // catalog.json 里的都视为手动录入
        locked: 0,
      });
    }
  });

  insertMany(catalog);
  console.log(`[DB] ✅ 成功导入 ${catalog.length} 个产品到 SQLite`);

  // 迁移完成后将 catalog.json 重命名为 .bak，避免被其他模块再次读取
  const bakPath = catalogPath + '.bak';
  try {
    fs.renameSync(catalogPath, bakPath);
    console.log(`[DB] 📦 catalog.json 已重命名为 catalog.json.bak（备份保留）`);
  } catch (e) {
    console.log(`[DB] ⚠️ catalog.json 重命名失败: ${e.message}（不影响运行）`);
  }
}

// ============================================================
// 数据库行 → 前端兼容的 JS 对象（JSON 字段自动解析）
// ============================================================
function rowToProduct(row) {
  if (!row) return null;
  return {
    id: row.id,
    provider: row.provider,
    providerName: row.provider_name,
    name: row.name,
    specs: JSON.parse(row.specs || '{}'),
    price: row.price,
    billingCycles: JSON.parse(row.billing_cycles || '{}'),
    checkUrl: row.check_url,
    affUrl: row.aff_url,
    datacenters: JSON.parse(row.datacenters || '[]'),
    networkRoutes: JSON.parse(row.network_routes || '[]'),
    outOfStockKeywords: JSON.parse(row.out_of_stock_keywords || '[]'),
    testEndpoints: JSON.parse(row.test_endpoints || '[]'),
    speedtestUrl: row.speedtest_url,
    promoCode: row.promo_code,
    priority: row.priority,
    isSpecialOffer: row.is_special_offer === 1,
    isHidden: row.is_hidden === 1,
    source: row.source,
    locked: row.locked === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// ============================================================
// CRUD 操作
// ============================================================

/** 获取全部产品（已解析 JSON） */
function getAllProducts() {
  const rows = db.prepare('SELECT * FROM products').all();
  return rows.map(rowToProduct);
}


/** 获取单个产品 */
function getProduct(id) {
  const row = db.prepare('SELECT * FROM products WHERE id = ?').get(id);
  return rowToProduct(row);
}

/** 检查产品是否存在 */
function productExists(id) {
  const row = db.prepare('SELECT 1 FROM products WHERE id = ?').get(id);
  return !!row;
}

/** 检查产品是否被锁定（手动录入保护） */
function isLocked(id) {
  const row = db.prepare('SELECT locked FROM products WHERE id = ?').get(id);
  return row ? row.locked === 1 : false;
}

/**
 * 添加新产品
 * @param {Object} product - 前端格式的产品对象（camelCase）
 * @returns {boolean} 是否成功插入
 */
function addProduct(product) {
  const stmt = db.prepare(`
    INSERT OR IGNORE INTO products (
      id, provider, provider_name, name, specs, price, billing_cycles,
      check_url, aff_url, datacenters, network_routes, out_of_stock_keywords,
      test_endpoints, speedtest_url, promo_code, priority,
      is_special_offer, is_hidden, source, locked
    ) VALUES (
      @id, @provider, @provider_name, @name, @specs, @price, @billing_cycles,
      @check_url, @aff_url, @datacenters, @network_routes, @out_of_stock_keywords,
      @test_endpoints, @speedtest_url, @promo_code, @priority,
      @is_special_offer, @is_hidden, @source, @locked
    )
  `);

  const result = stmt.run({
    id: product.id,
    provider: product.provider,
    provider_name: product.providerName || null,
    name: product.name,
    specs: JSON.stringify(product.specs || {}),
    price: product.price || null,
    billing_cycles: JSON.stringify(product.billingCycles || {}),
    check_url: product.checkUrl || null,
    aff_url: product.affUrl || null,
    datacenters: JSON.stringify(product.datacenters || []),
    network_routes: JSON.stringify(product.networkRoutes || []),
    out_of_stock_keywords: JSON.stringify(product.outOfStockKeywords || []),
    test_endpoints: JSON.stringify(product.testEndpoints || []),
    speedtest_url: product.speedtestUrl || null,
    promo_code: product.promoCode || null,
    priority: product.priority || 'medium',
    is_special_offer: product.isSpecialOffer ? 1 : 0,
    is_hidden: product.isHidden ? 1 : 0,
    source: product.source || 'discovered',
    locked: product.locked ? 1 : 0,
  });

  return result.changes > 0;
}

/**
 * 更新产品（部分字段）
 * @param {string} id - 产品 ID
 * @param {Object} updates - 要更新的字段（camelCase 格式）
 */
function updateProduct(id, updates) {
  // camelCase → snake_case 字段映射
  const fieldMap = {
    name: 'name',
    price: 'price',
    billingCycles: 'billing_cycles',
    promoCode: 'promo_code',
    isHidden: 'is_hidden',
    isSpecialOffer: 'is_special_offer',
    affUrl: 'aff_url',
    checkUrl: 'check_url',
    specs: 'specs',
    datacenters: 'datacenters',
    networkRoutes: 'network_routes',
    testEndpoints: 'test_endpoints',
    speedtestUrl: 'speedtest_url',
    priority: 'priority',
    source: 'source',
    locked: 'locked',
    providerName: 'provider_name',
    outOfStockKeywords: 'out_of_stock_keywords',
  };

  const sets = [];
  const values = {};

  for (const [camel, val] of Object.entries(updates)) {
    const col = fieldMap[camel];
    if (!col) continue;

    // JSON 字段需要序列化
    const jsonFields = ['specs', 'billingCycles', 'datacenters', 'networkRoutes',
                        'testEndpoints', 'outOfStockKeywords'];
    if (jsonFields.includes(camel)) {
      values[col] = JSON.stringify(val);
    } else if (typeof val === 'boolean') {
      values[col] = val ? 1 : 0;
    } else {
      values[col] = val;
    }
    sets.push(`${col} = @${col}`);
  }

  if (sets.length === 0) return;

  sets.push("updated_at = datetime('now')");
  values.id = id;

  const sql = `UPDATE products SET ${sets.join(', ')} WHERE id = @id`;
  db.prepare(sql).run(values);
}

/** 删除产品 */
function deleteProduct(id) {
  db.prepare('DELETE FROM products WHERE id = ?').run(id);
}

/** 按商家批量更新产品 */
function updateProductsByProvider(provider, updates) {
  const rows = db.prepare('SELECT id FROM products WHERE provider = ?').all(provider);
  for (const row of rows) {
    updateProduct(row.id, updates);
  }
  return rows.length;
}

// ============================================================
// 历史记录
// ============================================================

/** 记录价格变动 */
function recordPriceChange(productId, oldPrice, newPrice, billingCycles = null) {
  db.prepare(`
    INSERT INTO price_history (product_id, old_price, new_price, billing_cycles)
    VALUES (?, ?, ?, ?)
  `).run(productId, oldPrice, newPrice, billingCycles ? JSON.stringify(billingCycles) : null);
}

/** 记录库存事件（补货/缺货） */
function recordStockEvent(productId, eventType, priceAtEvent = null) {
  db.prepare(`
    INSERT INTO stock_events (product_id, event_type, price_at_event)
    VALUES (?, ?, ?)
  `).run(productId, eventType, priceAtEvent);
}

/** 获取某产品的价格历史 */
function getPriceHistory(productId, limit = 50) {
  return db.prepare(`
    SELECT * FROM price_history WHERE product_id = ? ORDER BY changed_at DESC LIMIT ?
  `).all(productId, limit);
}

/** 获取某产品的库存事件历史 */
function getStockEvents(productId, limit = 50) {
  return db.prepare(`
    SELECT * FROM stock_events WHERE product_id = ? ORDER BY occurred_at DESC LIMIT ?
  `).all(productId, limit);
}

/** 获取全局最近事件（首页展示用） */
function getRecentEvents(limit = 20) {
  return db.prepare(`
    SELECT se.*, p.name as product_name, p.provider_name
    FROM stock_events se
    JOIN products p ON se.product_id = p.id
    ORDER BY se.occurred_at DESC
    LIMIT ?
  `).all(limit);
}

// ============================================================
// 初始化（建表 + 迁移）
// ============================================================
function initDB() {
  createTables();
  migrateFromCatalog();
  const count = db.prepare('SELECT COUNT(*) as cnt FROM products').get();
  console.log(`[DB] SQLite 就绪，共 ${count.cnt} 个产品，数据库文件: ${DB_PATH}`);
}

// 自动初始化
initDB();

// ============================================================
// 导出
// ============================================================
export default {
  db,               // 原始 db 实例（高级用途）
  getAllProducts,

  getProduct,
  productExists,
  isLocked,
  addProduct,
  updateProduct,
  updateProductsByProvider,
  deleteProduct,
  recordPriceChange,
  recordStockEvent,
  getPriceHistory,
  getStockEvents,
  getRecentEvents,
};
