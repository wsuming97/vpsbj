import fs from 'fs';
import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import * as cheerio from 'cheerio';
import path from 'path';
import { fileURLToPath } from 'url';
// 使用事件总线替代对 tgBot.js 的直接 import，打破循环依赖
import eventBus from './eventBus.js';
// 使用 SQLite 数据库替代 catalog.json
import db from './db.js';

puppeteer.use(StealthPlugin());

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 从数据库加载产品列表（替代原来的 catalog.json 读取）
export let catalog = db.getAllProducts();

// Initialize state cache
export const stockState = {};

function initStockState() {
  catalog.forEach(product => {
    if (!stockState[product.id]) {
      stockState[product.id] = {
        ...product,
        inStock: null,
        lastChecked: null,
        statusMessage: '检测中...'
      };
    } else {
      // update product info but keep stock
      const oldStock = stockState[product.id].inStock;
      const oldCheck = stockState[product.id].lastChecked;
      const oldMsg = stockState[product.id].statusMessage;
      stockState[product.id] = {
        ...product,
        inStock: oldStock,
        lastChecked: oldCheck,
        statusMessage: oldMsg
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

let browserInstance = null;

async function getBrowser() {
  if (!browserInstance) {
    browserInstance = await puppeteer.launch({
      headless: "new",
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--ignore-certificate-errors',
        '--disable-blink-features=AutomationControlled',
        // ── 磁盘控制：防止 Chromium 缓存无限增长 ──
        '--disable-dev-shm-usage',      // 不使用 /dev/shm，改用 /tmp
        '--disk-cache-size=0',           // 禁用磁盘缓存
        '--media-cache-size=0',          // 禁用媒体缓存
        '--disable-gpu',                 // 禁用 GPU（无头模式不需要）
        '--disable-software-rasterizer', // 禁用软件光栅化
        '--disable-extensions',          // 禁用扩展
        '--disable-background-networking',// 禁用后台网络请求
        '--aggressive-cache-discard',    // 积极丢弃缓存
      ]
    });
  }
  return browserInstance;
}

export async function checkProductStock(product) {
  let page = null;
  try {
    const browser = await getBrowser();
    page = await browser.newPage();
    
    // Set typical viewport and user agent
    await page.setViewport({ width: 1280, height: 720 });
    
    await page.goto(product.checkUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await sleep(5000);

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
    }

    return { success: true, inStock, html };
  } catch (error) {
    console.error(`[Scraper] Error checking ${product.id}:`, error.message);
    return { success: false, inStock: false, error: error.message };
  } finally {
    if (page) await page.close().catch(e=>null);
  }
}

export async function runScraperCycle() {
  console.log(`[Scraper] Starting cycle at ${new Date().toISOString()}`);

  // 收集本轮所有补货事件，按商家分组
  const restockedProducts = [];

  for (const product of catalog) {
    if (product.isHidden) continue;

    console.log(`  -> Checking ${product.name} (${product.providerName})...`);
    const result = await checkProductStock(product);
    
    if (result.success) {
      const previouslyInStock = stockState[product.id].inStock;
      
      stockState[product.id].inStock = result.inStock;
      stockState[product.id].lastChecked = new Date().toISOString();
      stockState[product.id].statusMessage = result.inStock ? 'In Stock' : 'Out of Stock';

      // 记录库存翻转事件到 SQLite
      if (previouslyInStock !== null && previouslyInStock !== result.inStock) {
        const eventType = result.inStock ? 'restock' : 'outofstock';
        db.recordStockEvent(product.id, eventType, product.price);
      }

      // 只有从「确认缺货」变成「有货」才算补货，首次检测（null→true）不算
      if (previouslyInStock === false && result.inStock === true) {
        console.log(`🚨 [RESTOCK ALERT] ${product.name} IS NOW IN STOCK!`);

        // ── 补货瞬间：实时抓取最新价格（硬件涨价可能导致价格变动） ──
        let livePrice = null;
        let liveCycles = null;
        let oldPrice = product.price;
        try {
          const browser = await getBrowser();
          const pricePage = await browser.newPage();
          try {
            await pricePage.goto(product.checkUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
            await sleep(4000);
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

              // ---- 优先级 1：WHMCS 下拉框 — 提取所有计费周期 ----
              const billingSelect = document.querySelector('select[name="billingcycle"]');
              if (billingSelect && billingSelect.options.length > 0) {
                const cycles = {};
                let defaultPrice = null;
                let defaultDisplay = null;
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

              // ---- 优先级 1.5：DMIT 按钮式计费周期 ----
              const activeBtn = document.querySelector('.billing-cycle .active, [class*="billing"] .active, [class*="cycle"] .active, button.active[data-cycle], .btn-group .active');
              if (activeBtn) {
                const btnText = activeBtn.textContent.trim().toLowerCase();
                let detectedPeriod = '';
                for (const [key, val] of Object.entries(cycleDisplayMap)) {
                  if (btnText.includes(key)) { detectedPeriod = val; break; }
                }
                if (detectedPeriod) {
                  const summaryArea = document.querySelector('.order-summary, [class*="summary"], [class*="order"]') || document.body;
                  const pm = summaryArea.innerText.match(/\$\s*(\d+[.,]\d{2})/);
                  if (pm) { result.price = '$' + pm[1] + '/' + detectedPeriod; return result; }
                }
              }

              // ---- 优先级 2：限定距离正则 + 双向匹配 ----
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
            if (priceInfo && priceInfo.price) {
              livePrice = priceInfo.price;
              liveCycles = priceInfo.billingCycles;
            }
          } finally {
            await pricePage.close();
          }
        } catch (e) {
          console.log(`[Scraper] 价格实时抓取失败: ${e.message}，使用缓存价格`);
        }

        // 如果抓到了新价格且和旧价格不同，更新数据库
        let priceChanged = false;
        if (livePrice && livePrice !== oldPrice) {
          priceChanged = true;
          console.log(`💰 [PRICE UPDATE] ${product.name}: ${oldPrice} → ${livePrice}`);

          // 更新价格，同时保存抓到的全部计费周期
          const updateData = { price: livePrice };
          if (liveCycles && Object.keys(liveCycles).length > 0) {
            updateData.billingCycles = liveCycles;
            console.log(`📅 [BILLING CYCLES] ${product.name}: 抓到 ${Object.keys(liveCycles).length} 个计费周期`);
          }
          db.updateProduct(product.id, updateData);
          // 记录价格变动历史
          db.recordPriceChange(product.id, oldPrice, livePrice);

          // 同步到内存
          stockState[product.id].price = livePrice;
          const catIdx = catalog.findIndex(c => c.id === product.id);
          if (catIdx !== -1) catalog[catIdx].price = livePrice;
        } else if (liveCycles && Object.keys(liveCycles).length > 0) {
          // 价格没变但抓到了多周期数据，也存一下
          db.updateProduct(product.id, { billingCycles: liveCycles });
          console.log(`📅 [BILLING CYCLES] ${product.name}: 补录 ${Object.keys(liveCycles).length} 个计费周期`);
        }

        restockedProducts.push({
          ...stockState[product.id],
          inStock: true,
          priceChanged,
          oldPrice: priceChanged ? oldPrice : null,
          livePrice: livePrice || oldPrice
        });
      }
    } else {
      stockState[product.id].lastChecked = new Date().toISOString();
      stockState[product.id].statusMessage = `Error: ${result.error}`;
    }

    await sleep(Math.floor(Math.random() * 3000) + 2000);
  }

  // 按商家分组合并通知
  if (restockedProducts.length > 0) {
    const grouped = {};
    restockedProducts.forEach(p => {
      if (!grouped[p.provider]) grouped[p.provider] = [];
      grouped[p.provider].push(p);
    });
    for (const [provider, products] of Object.entries(grouped)) {
      // 通过事件总线通知 TG Bot，避免循环依赖
      eventBus.emit('restock', products);
    }
  }
  
  console.log(`[Scraper] Cycle finished.`);
}
