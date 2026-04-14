/**
 * price-sync.js — 双层价格同步策略
 *
 * 策略层级（每个产品按此优先级尝试）：
 *   1. 直接爬 WHMCS cart.php（用 node-fetch，不用 Puppeteer，速度快）
 *      → 读取 meta[name="description"] 或 JSON-LD 里的价格
 *   2. 竞品站：stock.bwh91.com（BWH）/ stock.dmitea.com（DMIT）
 *      → 用 cheerio 解析 HTML，按 PID 匹配价格
 *   3. Puppeteer 渲染（最重，CF 绕过用）
 *      → 读 select[name="billingcycle"] 下拉框
 *   4. 无法获取 → 保留现有价格，标记 priceVerified=false
 *
 * 使用方法：
 *   node price-sync.js              # 同步所有产品
 *   node price-sync.js bandwagonhost # 只同步搬瓦工
 *   node price-sync.js dmit          # 只同步 DMIT
 */

import fetch from 'node-fetch';
import * as cheerio from 'cheerio';
import db from './db.js';
import { getBrowser } from './browser.js';

// ── 竞品站配置 ──
const COMPETITOR_PRICE_SOURCES = {
  bandwagonhost: [
    'https://stock.bwh81.net/',
    'https://stock.bwh91.com/',
  ],
  dmit: [
    'https://stock.dmitea.com/',
  ],
};

// ── 请求头（模拟浏览器，避免被竞品站拒绝） ──
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
};

const CYCLE_MAP = {
  'monthly': '月', 'quarterly': '季',
  'semi-annually': '半年', 'semi-annual': '半年',
  'annually': '年', 'annual': '年',
  'biennially': '两年', 'triennially': '三年',
};

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function extractPid(url) {
  const m = url.match(/[?&]pid=(\d+)/i);
  return m ? m[1] : null;
}

// ── 层1：直接 fetch WHMCS 页面（无 Puppeteer，快）──
async function tryDirectFetch(product) {
  try {
    const res = await fetch(product.checkUrl, {
      headers: HEADERS,
      timeout: 10000,
      redirect: 'follow',
    });
    if (!res.ok) return null;
    const html = await res.text();
    const $ = cheerio.load(html);

    // CF 拦截检测
    if (html.includes('cf-browser-verification') || html.includes('Just a moment') || html.length < 500) {
      return null;
    }

    // WHMCS select[name="billingcycle"]
    const select = $('select[name="billingcycle"]');
    if (select.length > 0) {
      const cycles = {};
      let defaultPrice = null, defaultCycle = null;
      let selectedIdx = parseInt(select.attr('data-selected') || '0', 10);

      select.find('option').each((i, el) => {
        const text = $(el).text().trim();
        const pm = text.match(/\$(\d+[.,]\d{2})/);
        if (!pm) return;
        const priceStr = '$' + pm[1].replace(',', '.');
        for (const [key, cKey] of Object.entries(CYCLE_MAP)) {
          if (text.toLowerCase().includes(key)) {
            cycles[cKey] = priceStr;
            const isSelected = $(el).attr('selected') !== undefined || i === selectedIdx;
            if (isSelected) { defaultPrice = priceStr; defaultCycle = cKey; }
            break;
          }
        }
      });

      if (Object.keys(cycles).length > 0) {
        // 优先年付，其次季付，最后月付
        const preferred = ['annually', 'quarterly', 'monthly'];
        const useCycle = preferred.find(c => cycles[c]) || Object.keys(cycles)[0];
        return {
          price: cycles[useCycle] + '/' + CYCLE_MAP[useCycle] || cycles[useCycle],
          billingCycles: cycles,
          source: 'direct-fetch',
        };
      }
    }
    return null;
  } catch {
    return null;
  }
}

// ── 层2：竞品站按 PID 匹配价格 ──
const competitorCache = {};

async function loadCompetitorSite(url) {
  if (competitorCache[url]) return competitorCache[url];
  try {
    const res = await fetch(url, { headers: HEADERS, timeout: 15000 });
    if (!res.ok) return null;
    const html = await res.text();
    competitorCache[url] = html;
    return html;
  } catch { return null; }
}

async function tryCompetitorSite(product) {
  const pid = extractPid(product.checkUrl);
  if (!pid) return null;

  const sources = COMPETITOR_PRICE_SOURCES[product.provider] || [];
  for (const siteUrl of sources) {
    const html = await loadCompetitorSite(siteUrl);
    if (!html) continue;

    const $ = cheerio.load(html);

    // 找 pid 匹配的链接或数据属性
    let price = null;

    // 方式1：链接里含 pid=XXX
    $('a[href*="pid=' + pid + '"], [data-pid="' + pid + '"]').each((_, el) => {
      if (price) return;
      const card = $(el).closest('[class*="card"], [class*="plan"], [class*="product"], li, tr, div');
      const text = card.text();
      const pm = text.match(/\$(\d+\.?\d{0,2})\s*\/\s*(yr|year|mo|month|annually|monthly|quarterly)/i);
      if (pm) {
        const amt = parseFloat(pm[1]);
        const period = pm[2].toLowerCase();
        const p = period.startsWith('yr') || period.startsWith('year') || period.startsWith('ann') ? '年'
          : period.startsWith('mo') || period.startsWith('mon') ? '月'
          : period.startsWith('qu') ? '季' : '年';
        price = `$${amt.toFixed(2)}/${p}`;
      }
    });

    // 方式2：整页搜索 pid 附近的价格
    if (!price) {
      const pidRegex = new RegExp(`pid=${pid}[^\\d]`);
      $('*').each((_, el) => {
        if (price) return;
        const text = $(el).text();
        if (pidRegex.test(text) || ($(el).attr('href') || '').includes('pid=' + pid)) {
          const pm = text.match(/\$(\d+\.?\d{0,2})\s*\/\s*(yr|mo|year|month)/i);
          if (pm) {
            const p = pm[2].startsWith('yr') || pm[2].startsWith('year') ? '年' : '月';
            price = `$${parseFloat(pm[1]).toFixed(2)}/${p}`;
          }
        }
      });
    }

    if (price) return { price, source: `competitor:${new URL(siteUrl).hostname}` };
  }
  return null;
}

// ── 层3：Puppeteer 渲染（最重，最后手段） ──
async function tryPuppeteer(product) {
  let page;
  try {
    const browser = await getBrowser();
    page = await browser.newPage();
    await page.goto(product.checkUrl, { waitUntil: 'domcontentloaded', timeout: 25000 });
    await Promise.race([
      page.waitForFunction(() => document.body?.innerText?.length > 300, { timeout: 5000 }),
      sleep(5000),
    ]).catch(() => {});

    const info = await page.evaluate(() => {
      const cycles = {};
      const CMAP = {
        'monthly': '月', 'quarterly': '季',
        'semi-annually': '半年', 'annually': '年',
        'biennially': '两年', 'triennially': '三年',
      };
      const select = document.querySelector('select[name="billingcycle"]');
      if (select) {
        Array.from(select.options).forEach(opt => {
          const t = opt.textContent.trim();
          const pm = t.match(/\$(\d+[.,]\d{2})/);
          if (!pm) return;
          for (const [key, label] of Object.entries(CMAP)) {
            if (t.toLowerCase().includes(key)) {
              cycles[key] = `$${pm[1].replace(',', '.')}/${label}`;
              break;
            }
          }
        });
      }
      const preferred = ['annually', 'quarterly', 'monthly'];
      const best = preferred.find(c => cycles[c]);
      return best ? { price: cycles[best], billingCycles: cycles } : null;
    });
    return info ? { ...info, source: 'puppeteer' } : null;
  } catch { return null; }
  finally { if (page) await page.close().catch(() => {}); }
}

// ── 主同步逻辑 ──
async function syncProduct(product) {
  const pid = extractPid(product.checkUrl);
  console.log(`\n🔍 ${product.name} (${product.provider} pid=${pid || 'N/A'})`);
  console.log(`   当前价格: ${product.price || '(空)'}`);

  // 层1：直接 fetch
  let result = await tryDirectFetch(product);
  if (result?.price) {
    console.log(`   ✅ 层1直接fetch: ${result.price} (${result.source})`);
    return result;
  }

  // 层2：竞品站
  result = await tryCompetitorSite(product);
  if (result?.price) {
    console.log(`   ✅ 层2竞品站: ${result.price} (${result.source})`);
    return result;
  }

  // 层3：Puppeteer
  console.log(`   ⏳ 层3 Puppeteer 渲染...`);
  result = await tryPuppeteer(product);
  if (result?.price) {
    console.log(`   ✅ 层3Puppeteer: ${result.price}`);
    return result;
  }

  console.log(`   ❌ 全部层级失败，保留现有价格`);
  return null;
}

async function main() {
  const filterProvider = process.argv[2]?.toLowerCase();
  let products = db.getAllProducts().filter(p => !p.isHidden);
  if (filterProvider) {
    products = products.filter(p => p.provider === filterProvider);
    console.log(`🎯 只同步: ${filterProvider}（${products.length} 个产品）`);
  } else {
    console.log(`🚀 同步全部 ${products.length} 个产品价格`);
  }

  let updated = 0, unchanged = 0, failed = 0;
  const report = [];

  for (const product of products) {
    await sleep(1500); // 礼貌间隔
    const result = await syncProduct(product);
    if (result?.price) {
      const oldPrice = product.price;
      if (result.price !== oldPrice) {
        db.updateProduct(product.id, {
          price: result.price,
          ...(result.billingCycles ? { billingCycles: result.billingCycles } : {}),
        });
        report.push({ id: product.id, old: oldPrice, new: result.price, source: result.source });
        updated++;
      } else {
        unchanged++;
      }
    } else {
      failed++;
    }
  }

  console.log('\n\n════════════════════════════════');
  console.log(`✅ 更新: ${updated}  ⏭️ 未变: ${unchanged}  ❌ 失败: ${failed}`);
  if (report.length > 0) {
    console.log('\n价格变动汇总:');
    report.forEach(r => console.log(`  ${r.id}: ${r.old} → ${r.new} (${r.source})`));
  }
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
