// 使用事件总线替代对 tgBot.js 的直接 import，打破循环依赖
import eventBus from './eventBus.js';
// 使用 SQLite 数据库替代 catalog.json
import db from './db.js';
import fetch from 'node-fetch';


// 从数据库加载产品列表（替代原来的 catalog.json 读取）
export let catalog = db.getAllProducts();

// Initialize state cache
export const stockState = {};

// ── 并发控制 ──
// HTTP 重定向检测极轻量，可大幅提升并发和频率
const CONCURRENT_CHECKS = 10;       // 同时最多 10 个产品并行检测（HTTP 请求轻量）
const DOMAIN_MIN_INTERVAL = 2000;   // 同域名两次请求最少间隔 2 秒
const domainLastCheck = new Map();  // domain → timestamp

// ── 智能跳过：长期缺货产品降频检测 ──
let cycleCount = 0;

// ── Discovery 互斥锁（已废弃，保留导出接口以兼容 tgBot.js） ──
export let discoveryRunning = false;
export function setDiscoveryRunning(val) { discoveryRunning = val; }

function getDomain(url) {
  try { return new URL(url).hostname; } catch { return url; }
}

// 根据连续缺货次数决定本轮是否跳过
function shouldCheckThisCycle(product) {
  const state = stockState[product.id];
  if (!state) return true;
  const oos = state.consecutiveOos || 0;
  if (oos >= 8) return cycleCount % 4 === 0; // 缺货 8 次+ → 每 4 轮查一次
  if (oos >= 4) return cycleCount % 2 === 0; // 缺货 4 次+ → 每 2 轮查一次
  return true;
}

function initStockState() {
  catalog.forEach(product => {
    if (!stockState[product.id]) {
      stockState[product.id] = {
        ...product,
        inStock: null,
        lastChecked: null,
        statusMessage: '检测中...',
        consecutiveOos: 0,
      };
    } else {
      const prev = stockState[product.id];
      stockState[product.id] = {
        ...product,
        inStock: prev.inStock,
        lastChecked: prev.lastChecked,
        statusMessage: prev.statusMessage,
        consecutiveOos: prev.consecutiveOos || 0,
      };
    }
  });
}

initStockState();

// 热加载：从 SQLite 重新读取产品列表
export function reloadCatalog() {
  catalog = db.getAllProducts();
  initStockState();
  console.log(`[System] Catalog reloaded from SQLite. Total products: ${catalog.length}`);
}

// Sleep function to avoid hitting rate limits
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));


/**
 * 纯 HTTP 重定向检测库存（借鉴 vpsjk.de 方案）
 * 
 * 原理：WHMCS 购物车系统的通用行为——
 *   有货 → 重定向到 cart.php?a=confproduct&i=0 (配置产品页)
 *   无货 → 停留在 cart.php?a=add&pid=XXX 或重定向回大厅
 * 
 * 优势：<1 秒/次，无需浏览器，不触发 Cloudflare，零内存占用
 */
async function followRedirects(url, maxHops = 8) {
  let currentUrl = url;
  for (let i = 0; i < maxHops; i++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    try {
      const res = await fetch(currentUrl, {
        redirect: 'manual',
        signal: controller.signal,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.5',
        },
      });
      clearTimeout(timeout);

      // 非重定向 → 到达终点
      if (res.status < 300 || res.status >= 400) {
        // 对于 200 响应，快速读取部分 body 以检测 Out of Stock 关键词
        let bodySnippet = '';
        try {
          const text = await res.text();
          bodySnippet = text.substring(0, 15000).toLowerCase();
        } catch {}
        return { finalUrl: currentUrl, statusCode: res.status, bodySnippet };
      }

      // 跟踪重定向
      const location = res.headers.get('location');
      if (!location) {
        return { finalUrl: currentUrl, statusCode: res.status, bodySnippet: '' };
      }

      // 处理相对路径重定向
      try {
        currentUrl = new URL(location, currentUrl).href;
      } catch {
        currentUrl = location;
      }
    } catch (err) {
      clearTimeout(timeout);
      throw err;
    }
  }
  return { finalUrl: currentUrl, statusCode: 0, bodySnippet: '' };
}

export async function checkProductStock(product) {
  try {
    // ── 域名级限速 ──
    const domain = getDomain(product.checkUrl);
    const lastMs = domainLastCheck.get(domain) || 0;
    const wait = Math.max(0, lastMs + DOMAIN_MIN_INTERVAL - Date.now());
    if (wait > 0) await sleep(wait);
    domainLastCheck.set(domain, Date.now());

    // ── 纯 HTTP 重定向检测 ──
    const { finalUrl, statusCode, bodySnippet } = await followRedirects(product.checkUrl);

    let finalUrlObj;
    try { finalUrlObj = new URL(finalUrl); } catch {}

    // 🛡️ 防线 1：反重定向劫持 — pid 丢失说明被踢回大厅（商品已下架）
    if (finalUrlObj && product.checkUrl.includes('pid=') &&
        !finalUrlObj.searchParams.has('pid') &&
        !finalUrlObj.searchParams.has('id') &&
        !finalUrlObj.searchParams.has('i')) {
      // 但是 confproduct 页面有 i= 参数，属于有货，不拦截
      if (!finalUrl.includes('confproduct') && !finalUrl.includes('configureproduct')) {
        return { success: true, inStock: false };
      }
    }

    // 🛡️ 防线 2：Cloudflare / WAF 拦截 → 视为检测失败，不改变库存状态
    if (statusCode === 403 || statusCode === 503) {
      return { success: false, inStock: false, error: `HTTP ${statusCode} (CF/WAF 拦截)` };
    }

    // 统一的缺货关键词检测（产品自带 + 通用内置）
    const BUILTIN_OOS_KEYWORDS = ['out of stock', 'sold out', 'currently unavailable', 'no longer available', 'product is currently out of stock'];
    const allOosKeywords = [...(product.outOfStockKeywords || []).map(k => k.toLowerCase()), ...BUILTIN_OOS_KEYWORDS];
    const hasOosKeyword = allOosKeywords.some(kw => bodySnippet.includes(kw));

    // 🎯 核心判断逻辑：
    //   1. confproduct/configureproduct URL → 有货（WHMCS 标准行为），除非 body 显式含 OOS
    //   2. 其他所有 URL → 检查 body 是否含 OOS 关键词
    //   3. 有 OOS 关键词 → 缺货；无 OOS 关键词 → 有货
    //   4. 403/503 → 已在上方拦截为 failed check
    let inStock = !hasOosKeyword;

    // 需要邀请码且无优惠码 → 等同缺货
    if (inStock && !product.promoCode && /invite\s*code\s*required|invitation\s*only|invite[\s-]*only/i.test(bodySnippet)) {
      inStock = false;
    }

    // 404 / 失效页面 → 缺货
    if (statusCode === 404 || /there's a problem|resource requested could not be found|stack error.*404|404 not found/i.test(bodySnippet)) {
      inStock = false;
    }

    return { success: true, inStock };
  } catch (error) {
    console.error(`[Scraper] Error checking ${product.id}:`, error.message);
    return { success: false, inStock: false, error: error.message };
  }
}

// ── 处理单个产品的检测结果（复用于串行和并发两种模式） ──
async function processCheckResult(product, result, restockedProducts) {
  if (result.success) {
    const previouslyInStock = stockState[product.id]?.inStock;

    stockState[product.id].inStock = result.inStock;
    stockState[product.id].lastChecked = new Date().toISOString();
    stockState[product.id].statusMessage = result.inStock ? 'In Stock' : 'Out of Stock';

    // 更新连续缺货计数
    if (result.inStock) {
      stockState[product.id].consecutiveOos = 0;
    } else {
      stockState[product.id].consecutiveOos = (stockState[product.id].consecutiveOos || 0) + 1;
    }

    // 记录库存翻转事件到 SQLite
    if (previouslyInStock !== null && previouslyInStock !== result.inStock) {
      const eventType = result.inStock ? 'restock' : 'outofstock';
      db.recordStockEvent(product.id, eventType, product.price);
    }

    // 实时推送库存状态变化到 SSE 客户端
    if (previouslyInStock !== result.inStock) {
      eventBus.emit('stock:changed', { ...stockState[product.id] });
    }

    // 只有从「确认缺货」变成「有货」才算补货，首次检测（null→true）不算
    const isRestock = previouslyInStock === false && result.inStock === true;

    if (isRestock) {
      console.log(`🚨 [RESTOCK ALERT] ${product.name} IS NOW IN STOCK!`);
      // 直接使用数据库中已有的价格信息推送补货通知（价格通过管理后台手动维护）
      restockedProducts.push({
        ...stockState[product.id],
        inStock: true,
      });
    }
  } else {
    stockState[product.id].lastChecked = new Date().toISOString();
    stockState[product.id].statusMessage = `Error: ${result.error}`;
  }
}

// ── 轮次叠加保护：上一轮未完成时跳过 ──
let scraperRunning = false;

export async function runScraperCycle() {
  // 上一轮还没跑完，跳过本轮避免叠加
  if (scraperRunning) {
    console.log(`[Scraper] ⏸ Previous cycle still running, skipping to avoid overlap`);
    return;
  }

  // Discovery 运行时暂停本轮，让出 CPU
  if (discoveryRunning) {
    console.log(`[Scraper] ⏸ Discovery is running, skipping this cycle to save CPU`);
    return;
  }

  scraperRunning = true;
  try {

  cycleCount++;
  const toCheck = catalog.filter(p => !p.isHidden && shouldCheckThisCycle(p));
  const skipped = catalog.length - toCheck.length;

  console.log(`[Scraper] Cycle #${cycleCount} — checking ${toCheck.length}/${catalog.length} products (${skipped} long-OOS skipped)`);

  const restockedProducts = [];

  // ── 并发执行：CONCURRENT_CHECKS 个 worker 同时从队列取任务 ──
  let idx = 0;
  async function worker() {
    while (idx < toCheck.length) {
      const product = toCheck[idx++];
      console.log(`  -> Checking ${product.name} (${product.providerName})...`);
      const result = await checkProductStock(product);
      await processCheckResult(product, result, restockedProducts);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(CONCURRENT_CHECKS, toCheck.length) }, () => worker())
  );

  // 按商家分组合并发送补货通知
  if (restockedProducts.length > 0) {
    const grouped = {};
    restockedProducts.forEach(p => {
      if (!grouped[p.provider]) grouped[p.provider] = [];
      grouped[p.provider].push(p);
    });
    for (const products of Object.values(grouped)) {
      eventBus.emit('restock', products);
    }
  }

  // 通知前端本轮已完成
  eventBus.emit('cycle:done', { cycleCount, total: catalog.length, checked: toCheck.length });
  console.log(`[Scraper] Cycle #${cycleCount} finished.`);

  } finally {
    scraperRunning = false;
  }
}
