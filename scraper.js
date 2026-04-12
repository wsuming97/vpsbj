import fs from 'fs';
import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import * as cheerio from 'cheerio';
import path from 'path';
import { fileURLToPath } from 'url';
// 使用事件总线替代对 tgBot.js 的直接 import，打破循环依赖
import eventBus from './eventBus.js';

puppeteer.use(StealthPlugin());

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Read catalog (make export let so we can update it)
const catalogPath = path.join(__dirname, 'catalog.json');
export let catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));

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

// Add a reload function for hot-reloading
export function reloadCatalog() {
  catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
  initStockState();
  console.log(`[System] Catalog reloaded dynamically. Total products: ${catalog.length}`);
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
    
    await page.goto(product.checkUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
    
    // Cloudflare wait if challenged
    await sleep(4000); 
    
    const html = await page.content();
    
    // Detect basic anti-bot failure
    if (html.includes('cf-browser-verification') && !html.includes(product.providerName)) {
      throw new Error('Blocked by Cloudflare/Bot Protection');
    }

    // Default to inStock unless we find an Out of Stock keyword
    let inStock = true;
    for (const keyword of product.outOfStockKeywords) {
      if (html.toLowerCase().includes(keyword.toLowerCase())) {
        inStock = false;
        break;
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

      // 只有从「确认缺货」变成「有货」才算补货，首次检测（null→true）不算
      if (previouslyInStock === false && result.inStock === true) {
        console.log(`🚨 [RESTOCK ALERT] ${product.name} IS NOW IN STOCK!`);

        // ── 补货瞬间：实时抓取最新价格（硬件涨价可能导致价格变动） ──
        let livePrice = null;
        let oldPrice = product.price;
        try {
          const pricePage = await browser.newPage();
          try {
            await pricePage.goto(product.checkUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
            await sleep(3000);
            const priceInfo = await pricePage.evaluate(() => {
              const text = document.body.innerText;

              // ---- 优先级 1：WHMCS 下拉框精确提取 ----
              const billingSelect = document.querySelector('select[name="billingcycle"]');
              if (billingSelect) {
                const selectedOption = billingSelect.options[billingSelect.selectedIndex];
                const selectedText = selectedOption ? selectedOption.textContent.trim() : '';
                const cycleMap = {
                  'monthly': '月', 'quarterly': '季', 'semi-annually': '半年',
                  'annually': '年', 'biennially': '两年', 'triennially': '三年',
                };
                const pm = selectedText.match(/\$(\d+[.,]\d{2})/);
                if (pm) {
                  let period = '';
                  for (const [key, val] of Object.entries(cycleMap)) {
                    if (selectedText.toLowerCase().includes(key)) { period = val; break; }
                  }
                  return '$' + pm[1] + '/' + (period || '未知周期');
                }
              }

              // ---- 优先级 2：限定距离正则 ----
              const strictPatterns = [
                { re: /\$(\d+[.,]\d{2})\s*\/\s*yr/i, p: '年' },
                { re: /\$(\d+[.,]\d{2})\s*\/\s*mo/i, p: '月' },
                { re: /Annually.{0,50}\$(\d+[.,]\d{2})/i, p: '年' },
                { re: /Monthly.{0,50}\$(\d+[.,]\d{2})/i, p: '月' },
              ];
              for (const { re, p } of strictPatterns) {
                const m = text.match(re);
                if (m) return '$' + m[1] + '/' + p;
              }
              return null;
            });
            if (priceInfo) livePrice = priceInfo;
          } finally {
            await pricePage.close();
          }
        } catch (e) {
          console.log(`[Scraper] 价格实时抓取失败: ${e.message}，使用缓存价格`);
        }

        // 如果抓到了新价格且和旧价格不同，更新 catalog
        let priceChanged = false;
        if (livePrice && livePrice !== oldPrice) {
          priceChanged = true;
          console.log(`💰 [PRICE UPDATE] ${product.name}: ${oldPrice} → ${livePrice}`);
          // 更新 catalog 文件中的价格
          const idx = catalog.findIndex(c => c.id === product.id);
          if (idx !== -1) {
            catalog[idx].price = livePrice;
            fs.writeFileSync(catalogPath, JSON.stringify(catalog, null, 2));
          }
          stockState[product.id].price = livePrice;
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
