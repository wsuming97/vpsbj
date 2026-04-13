// 使用事件总线替代对 tgBot.js 的直接 import，打破循环依赖
import eventBus from './eventBus.js';
// 使用 SQLite 数据库替代 catalog.json
import db from './db.js';
// 共享 Chromium 单例，与 discovery.js 复用同一进程
import { getBrowser } from './browser.js';


// 从数据库加载产品列表（替代原来的 catalog.json 读取）
export let catalog = db.getAllProducts();

// Initialize state cache
export const stockState = {};

// ── 并发控制 ──
const CONCURRENT_CHECKS = 3;        // 同时最多 3 个产品并行检测
const DOMAIN_MIN_INTERVAL = 6000;   // 同域名两次请求最少间隔 6 秒
const domainLastCheck = new Map();  // domain → timestamp

// ── 智能跳过：长期缺货产品降频检测 ──
let cycleCount = 0;

// ── Discovery 互斥锁：Discovery 跑时 scraper 让出 CPU ──
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


export async function checkProductStock(product) {
  let page = null;
  try {
    // ── 域名级限速：同域名请求不得超过 1 次 / 6s ──
    const domain = getDomain(product.checkUrl);
    const lastMs = domainLastCheck.get(domain) || 0;
    const wait = Math.max(0, lastMs + DOMAIN_MIN_INTERVAL - Date.now());
    if (wait > 0) await sleep(wait);
    domainLastCheck.set(domain, Date.now());

    const browser = await getBrowser();
    page = await browser.newPage();

    // Set typical viewport and user agent
    await page.setViewport({ width: 1280, height: 720 });

    await page.goto(product.checkUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });

    // 智能等待：内容出现则提前结束，最多等 5s
    await Promise.race([
      page.waitForFunction(() => (document.body?.innerText?.trim()?.length || 0) > 200, { timeout: 5000 }),
      sleep(5000),
    ]).catch(() => {}); // 超时不抛出，继续检测
    await sleep(500); // 最小缓冲

    const html = await page.content();
    const htmlLower = html.toLowerCase();

    // Detect blank / empty page (JS渲染失败或被拦截返回空壳)
    const bodyLen = await page.evaluate(() => (document.body ? document.body.innerText.trim().length : 0));
    if (bodyLen < 100) {
      throw new Error('Page returned empty content (possible bot block or JS render failure)');
    }

    // Detect Cloudflare and anti-bot challenges
    const cfPatterns = ['cf-browser-verification', 'just a moment', 'checking your browser', 'enable javascript and cookies'];
    if (cfPatterns.some(p => htmlLower.includes(p))) {
      throw new Error('Blocked by Cloudflare/Bot Protection');
    }

    // Detect 404 / invalid pages — mark as out of stock (not throw, avoid false restock alert)
    const invalidPagePatterns = ["there's a problem", 'the resource requested could not be found', 'stack error - 404', '404 not found'];
    const isInvalidPage = invalidPagePatterns.some(p => htmlLower.includes(p)) && bodyLen < 2000;

    let inStock = true;
    if (isInvalidPage) {
      inStock = false;
    } else {
      for (const keyword of product.outOfStockKeywords) {
        if (htmlLower.includes(keyword.toLowerCase())) {
          inStock = false;
          break;
        }
      }
      // 需要邀请码且该产品没有配置邀请码/优惠码 → 等同缺货
      // 如果产品已配置了 promoCode（从竞品站或手动录入），则不拦截
      if (inStock && !product.promoCode && /invite\s*code\s*required|invitation\s*only|invite[\s-]*only/i.test(html)) {
        inStock = false;
      }
    }

    return { success: true, inStock, html };
  } catch (error) {
    console.error(`[Scraper] Error checking ${product.id}:`, error.message);
    return { success: false, inStock: false, error: error.message };
  } finally {
    if (page) await page.close().catch(e=>null);
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
    if (previouslyInStock === false && result.inStock === true) {
      console.log(`🚨 [RESTOCK ALERT] ${product.name} IS NOW IN STOCK!`);

      // ── 补货瞬间：实时抓取最新价格 ──
      let livePrice = null;
      let liveCycles = null;
      const oldPrice = product.price;
      try {
        const browser = await getBrowser();
        const pricePage = await browser.newPage();
        try {
          await pricePage.goto(product.checkUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
          await Promise.race([
            pricePage.waitForFunction(() => (document.body?.innerText?.trim()?.length || 0) > 200, { timeout: 4000 }),
            sleep(4000),
          ]).catch(() => {});
          const priceInfo = await pricePage.evaluate(() => {
            const result = { price: null, billingCycles: null };
            const text = document.body.innerText;
            const cycleKeyMap = {
              'monthly': 'monthly', 'quarterly': 'quarterly',
              'semi-annually': 'semiAnnually', 'semi-annual': 'semiAnnually',
              'annually': 'annually', 'annual': 'annually',
              'biennially': 'biennially', 'trienn': 'triennially',
            };
            const cycleDisplayMap = {
              'monthly': '月', 'quarterly': '季', 'semi-annually': '半年',
              'annually': '年', 'biennially': '两年', 'triennially': '三年',
            };
            // 优先级 1：WHMCS 下拉框
            const billingSelect = document.querySelector('select[name="billingcycle"]');
            if (billingSelect && billingSelect.options.length > 0) {
              const cycles = {};
              let defaultPrice = null, defaultDisplay = null;
              Array.from(billingSelect.options).forEach((opt, idx) => {
                const t = opt.textContent.trim();
                const pm = t.match(/\$(\d+[.,]\d{2})/);
                if (!pm) return;
                const priceStr = '$' + pm[1];
                for (const [key, cKey] of Object.entries(cycleKeyMap)) {
                  if (t.toLowerCase().includes(key)) {
                    cycles[cKey] = priceStr;
                    if (idx === billingSelect.selectedIndex) {
                      defaultPrice = priceStr;
                      for (const [dk, dv] of Object.entries(cycleDisplayMap)) {
                        if (t.toLowerCase().includes(dk)) { defaultDisplay = dv; break; }
                      }
                    }
                    break;
                  }
                }
              });
              if (Object.keys(cycles).length > 0) {
                result.billingCycles = cycles;
                result.price = defaultPrice ? (defaultPrice + (defaultDisplay ? '/' + defaultDisplay : '')) : null;
                return result;
              }
            }
            // 优先级 2：正则匹配
            const strictPatterns = [
              { re: /\$(\d+[.,]\d{2})\s*\/\s*yr/i, p: '年' },
              { re: /\$(\d+[.,]\d{2})\s*\/\s*mo/i, p: '月' },
              { re: /\$(\d+[.,]\d{2})\s*(?:USD)?\s*\/?\s*Monthly/i, p: '月' },
              { re: /\$(\d+[.,]\d{2})\s*(?:USD)?\s*\/?\s*Annually/i, p: '年' },
              { re: /\$(\d+[.,]\d{2})\s*(?:USD)?\s*\/?\s*Quarterly/i, p: '季' },
              { re: /\$(\d+[.,]\d{2})\s*(?:USD)?\s*\/?\s*Semi-?Annually/i, p: '半年' },
              { re: /Annually.{0,50}\$(\d+[.,]\d{2})/i, p: '年' },
              { re: /Monthly.{0,50}\$(\d+[.,]\d{2})/i, p: '月' },
            ];
            for (const { re, p } of strictPatterns) {
              const m = text.match(re);
              if (m) { result.price = '$' + m[1] + '/' + p; return result; }
            }
            return result;
          });
          if (priceInfo?.price) { livePrice = priceInfo.price; liveCycles = priceInfo.billingCycles; }
        } finally {
          await pricePage.close();
        }
      } catch (e) {
        console.log(`[Scraper] 价格实时抓取失败: ${e.message}`);
      }

      let priceChanged = false;
      if (livePrice && livePrice !== oldPrice) {
        priceChanged = true;
        console.log(`💰 [PRICE UPDATE] ${product.name}: ${oldPrice} → ${livePrice}`);
        const updateData = { price: livePrice };
        if (liveCycles && Object.keys(liveCycles).length > 0) updateData.billingCycles = liveCycles;
        db.updateProduct(product.id, updateData);
        db.recordPriceChange(product.id, oldPrice, livePrice);
        stockState[product.id].price = livePrice;
        const catIdx = catalog.findIndex(c => c.id === product.id);
        if (catIdx !== -1) catalog[catIdx].price = livePrice;
      } else if (liveCycles && Object.keys(liveCycles).length > 0) {
        db.updateProduct(product.id, { billingCycles: liveCycles });
      }

      restockedProducts.push({
        ...stockState[product.id],
        inStock: true,
        priceChanged,
        oldPrice: priceChanged ? oldPrice : null,
        livePrice: livePrice || oldPrice,
      });
    }
  } else {
    stockState[product.id].lastChecked = new Date().toISOString();
    stockState[product.id].statusMessage = `Error: ${result.error}`;
  }
}

export async function runScraperCycle() {
  // Discovery 运行时暂停本轮，让出 CPU
  if (discoveryRunning) {
    console.log(`[Scraper] ⏸ Discovery is running, skipping this cycle to save CPU`);
    return;
  }

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
}
