/**
 * browser.js — 共享 Puppeteer 浏览器单例
 *
 * scraper.js 和 discovery.js 共用同一个 Chromium 进程，
 * 避免同时开两个 Chromium 导致 CPU/内存翻倍。
 */
import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';

puppeteer.use(StealthPlugin());

let browserInstance = null;

const BROWSER_ARGS = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--ignore-certificate-errors',
  '--disable-blink-features=AutomationControlled',
  '--disable-dev-shm-usage',
  '--disk-cache-size=0',
  '--media-cache-size=0',
  '--disable-gpu',
  '--disable-software-rasterizer',
  '--disable-extensions',
  '--disable-background-networking',
  '--aggressive-cache-discard',
];

export async function getBrowser() {
  if (!browserInstance || !browserInstance.isConnected()) {
    console.log('[Browser] 启动 Chromium...');
    browserInstance = await puppeteer.launch({
      headless: 'new',
      args: BROWSER_ARGS,
    });
    browserInstance.on('disconnected', () => {
      console.log('[Browser] Chromium 断开，下次调用将重新启动');
      browserInstance = null;
    });
  }
  return browserInstance;
}
