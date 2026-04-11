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

      if (previouslyInStock !== true && result.inStock) {
        console.log(`🚨 [RESTOCK ALERT] ${product.name} IS NOW IN STOCK!`);
        restockedProducts.push({ ...stockState[product.id], inStock: true });
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
