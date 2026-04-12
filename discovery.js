/**
 * discoverer.js — 产品发现引擎
 * 
 * 功能：每 4 小时自动扫描各商家的 WHMCS 产品列表页（cart.php?gid=X），
 * 提取所有 PID，和 catalog.json 做 diff，新 PID 自动生成条目写入并热加载。
 * 
 * 数据源分两层：
 *   ① 商家官方产品列表页（cart.php?gid=X） — 主要来源、最权威
 *   ② 竞品库存站（stock.bwh91.com 等） — 辅助查漏补缺，可能挂掉不依赖
 * 
 * 与 scraper.js 配合：
 *   scraper.js 负责库存检测（每 15 分钟），本模块负责新品发现（每 4 小时）
 */
import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import cloudscraper from 'cloudscraper';
import * as cheerio from 'cheerio';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

puppeteer.use(StealthPlugin());

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ============================================================
// 推广 ID（与 scrape-all.mjs 保持一致）
// ============================================================
const AFF = {
  bwh: 81381,
  dmit: 16687,
  rn: 19252,
  cc: 14121,
  colo: 1633,
  zgo: 912,  // 你的 ZGO 推广 ID
};

// ============================================================
// 扫描源定义
// 每个源包含：商家信息 + 要扫描的 WHMCS gid 列表 + 官方域名
// ============================================================
const SCAN_SOURCES = [
  // ── 搬瓦工 ──
  // 搬瓦工不使用标准 gid 列表页，而是每个 PID 独立页面
  // 因此搬瓦工的新品发现依赖竞品库存站 + PID 递增探测
  {
    provider: 'bandwagonhost',
    providerName: '搬瓦工',
    domain: 'bandwagonhost.com',
    affParam: `aff=${AFF.bwh}`,
    // 搬瓦工采用 PID 递增探测策略：从已知最大 PID 开始向上探测
    mode: 'pid-probe',
    probeRange: 5,    // 每次向上探测 5 个 PID
    outOfStockKeywords: ['Out of Stock', 'out of stock'],
  },

  // ── DMIT ──
  {
    provider: 'dmit',
    providerName: 'DMIT',
    domain: 'www.dmit.io',
    affParam: `aff=${AFF.dmit}`,
    mode: 'gid-scan',
    gids: [
      { gid: 9, label: 'LAX Premium (CN2 GIA)' },
      { gid: 18, label: 'LAX Eyeball (9929+CMIN2)' },
      { gid: 16, label: 'LAX Tier1' },
      { gid: 11, label: 'HKG Premium' },
      { gid: 17, label: 'HKG Tier1' },
      { gid: 12, label: 'TYO Premium' },
      { gid: 20, label: 'TYO Tier1' },
    ],
    outOfStockKeywords: ['Out of Stock', 'out of stock'],
  },

  // ── RackNerd ──
  {
    provider: 'racknerd',
    providerName: 'RackNerd',
    domain: 'my.racknerd.com',
    affParam: `aff=${AFF.rn}`,
    mode: 'pid-probe',
    probeRange: 20, // RackNerd 活动频繁，探测范围大些
    outOfStockKeywords: ['Out of Stock', 'out of stock'],
  },

  // ── ZGO Cloud ──
  {
    provider: 'zgocloud',
    providerName: 'ZGO Cloud',
    domain: 'clients.zgovps.com',
    affParam: `aff=${AFF.zgo}`,
    mode: 'gid-scan',
    gids: [
      { gid: 1, label: 'LA International' },
      { gid: 7, label: 'LA China Optimized' },
      { gid: 14, label: 'HK' },
      { gid: 15, label: 'JP' },
    ],
    // ZGO 还有特惠聚合页（非标准 gid 格式）
    extraUrls: [
      { url: 'https://clients.zgovps.com/index.php?/cart/special-offer/&step=0', label: '特惠聚合页' },
    ],
    outOfStockKeywords: ['Out of Stock', 'out of stock'],
  },

  // ── ColoCrossing ──
  {
    provider: 'colocrossing',
    providerName: 'ColoCrossing',
    domain: 'cloud.colocrossing.com',
    affParam: `aff=${AFF.colo}`,
    mode: 'page-scan',
    scanUrls: [
      'https://cloud.colocrossing.com/cloud-vps/',
      'https://cloud.colocrossing.com/cart.php',
    ],
    outOfStockKeywords: ['Out of Stock', 'out of stock'],
  },

  // ── CloudCone ──
  // CloudCone 不使用 WHMCS，URL 格式为 app.cloudcone.com/vps/{id}/create
  {
    provider: 'cloudcone',
    providerName: 'CloudCone',
    domain: 'app.cloudcone.com',
    affParam: `ref=${AFF.cc}`,
    mode: 'cloudcone-probe',
    probeRange: 20,  // 从已知最大 ID 向上探测
    // CloudCone 活动页和促销帖聚合
    promoPages: [
      'https://cloudcone.com/offers/',
      'https://cloudcone.com/easter-sale/',
      'https://cloudcone.com/black-friday/',
      'https://cloudcone.com/new-year-sale/',
    ],
    outOfStockKeywords: ['sold out', 'Sold Out', 'unavailable', 'no longer available'],
  },
];

// ============================================================
// 竞品库存站 + VPS 测评/活动聚合站（辅助来源）
// 这些站点会汇总各商家最新活动链接，从中提取 pid 和产品链接
// ============================================================
const COMPETITOR_SOURCES = [
  // ── 库存站 ──
  { name: '搬瓦工库存站 (bwh91)', url: 'https://stock.bwh91.com/' },
  { name: 'DMIT库存站 (dmitea)', url: 'https://stock.dmitea.com/' },
  // ── VPS 活动聚合/测评站（首页，可获取最新活动帖链接） ──
  { name: '便宜VPS (pianyivps)', url: 'https://www.pianyivps.com/', deepScan: true },
  { name: 'VPS交流网', url: 'https://www.vpsjxw.com/', deepScan: true },
  { name: 'RAK VPS', url: 'https://rakvps.com/', deepScan: true },
  // ── VNCoupon 标签页（列表页 → 进入每篇活动详情提取产品链接） ──
  { name: 'VNCoupon (CloudCone)', url: 'https://vncoupon.com/tag/cloudcone/', deepScan: true },
  { name: 'VNCoupon (RackNerd)', url: 'https://vncoupon.com/tag/racknerd/', deepScan: true },
  { name: 'VNCoupon (DMIT)', url: 'https://vncoupon.com/tag/dmit/', deepScan: true },
  // ── VNCoupon 已知的重要活动详情页（直接含产品链接） ──
  { name: 'VNCoupon CC Hashtag活动', url: 'https://vncoupon.com/cloudcone-hashtag-2026-sale/' },
  { name: 'VNCoupon CC KVM特价', url: 'https://vncoupon.com/cloudcone-hourly-billed-kvm-offers-semi-managed-cloud-server/' },
  { name: 'VNCoupon RN 新年特价', url: 'https://vncoupon.com/racknerd-new-year-2022-vps-hosting-deals/' },
  { name: 'VNCoupon 便宜VPS列表', url: 'https://vncoupon.com/a-list-of-cheap-vps-hosting-under-12-year/' },
  // ── 商家官方活动页 ──
  { name: 'CloudCone Offers', url: 'https://cloudcone.com/offers/' },
  { name: 'RackNerd Blog', url: 'https://www.racknerd.com/blog/', deepScan: true },
  // ── LowEndTalk / LowEndBox ──
  { name: 'LowEndBox', url: 'https://lowendbox.com/', deepScan: true },
];

// ============================================================
// Puppeteer 浏览器管理
// ============================================================
let discoverBrowser = null;

async function getDiscoverBrowser() {
  if (!discoverBrowser || !discoverBrowser.isConnected()) {
    discoverBrowser = await puppeteer.launch({
      headless: 'new',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--ignore-certificate-errors',
        // ── 磁盘控制：防止 Chromium 缓存无限增长 ──
        '--disable-dev-shm-usage',
        '--disk-cache-size=0',
        '--media-cache-size=0',
        '--disable-gpu',
        '--disable-software-rasterizer',
        '--disable-extensions',
        '--disable-background-networking',
        '--aggressive-cache-discard',
      ],
    });
  }
  return discoverBrowser;
}

async function closeDiscoverBrowser() {
  if (discoverBrowser) {
    await discoverBrowser.close().catch(() => {});
    discoverBrowser = null;
  }
}

// ============================================================
// 从产品页面抓取真实名称、价格和优惠码
// ============================================================
async function scrapeProductDetails(browser, url) {
  const details = { name: null, price: null, promoCode: null, specs: {} };
  const page = await browser.newPage();
  try {
    // 先检查 URL 参数中是否已有优惠码
    try {
      const parsed = new URL(url);
      const urlPromo = parsed.searchParams.get('promocode') || parsed.searchParams.get('promo');
      if (urlPromo) details.promoCode = urlPromo;
    } catch {}

    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await sleep(4000);

    // 从页面中提取产品名称、价格和优惠码
    const info = await page.evaluate(() => {
      const result = { name: null, price: null, promoCode: null, hasPromoField: false };

      // ── 提取产品名称 ──
      const nameEl = document.querySelector('h1') ||
                     document.querySelector('.product-name') ||
                     document.querySelector('.product-title') ||
                     document.querySelector('#product-name');
      if (nameEl) {
        let n = nameEl.textContent.trim();
        n = n.replace(/^(Configure|Order|配置)\s*/i, '').trim();
        if (n && n.length > 1 && n.length < 150) result.name = n;
      }
      if (!result.name && document.title) {
        const t = document.title.replace(/- .*$/, '').replace(/\|.*$/, '').trim();
        if (t && t.length > 2 && t.length < 100) result.name = t;
      }

      // ── 检测优惠码输入框 ──
      // WHMCS 的优惠码输入框通常 name="promocode" 或 id="inputPromotionCode"
      const promoInput = document.querySelector('input[name="promocode"]') ||
                         document.querySelector('#inputPromotionCode') ||
                         document.querySelector('input[name="promo"]') ||
                         document.querySelector('input[placeholder*="romo"]');
      if (promoInput) {
        result.hasPromoField = true;
        // 如果输入框已有值（URL 带入或页面预填），直接取
        if (promoInput.value && promoInput.value.trim()) {
          result.promoCode = promoInput.value.trim();
        }
      }

      // ── 从页面文本中识别优惠码 ──
      const allText = document.body.innerText;

      // 常见优惠码模式：Coupon: XXXXX / Promo Code: XXXXX / 优惠码：XXXXX
      if (!result.promoCode) {
        const promoPatterns = [
          /(?:coupon|promo\s*code|promocode|discount\s*code|优惠码|折扣码)[:\s：]+([A-Z0-9_-]{3,30})/i,
          /(?:use|apply|enter)\s+(?:code\s+)?[\"\']?([A-Z0-9_-]{4,30})[\"\']?/i,
        ];
        for (const pat of promoPatterns) {
          const m = allText.match(pat);
          if (m) {
            result.promoCode = m[1];
            break;
          }
        }
      }

      // ── 提取价格（优先年付） ──
      const annualMatch = allText.match(/Annually[\s\S]*?\$(\d+[.,]\d{2})/i);
      if (annualMatch) {
        result.price = `$${annualMatch[1]}/年`;
      }
      if (!result.price) {
        const monthlyMatch = allText.match(/Monthly[\s\S]*?\$(\d+[.,]\d{2})/i);
        if (monthlyMatch) {
          result.price = `$${monthlyMatch[1]}/月`;
        }
      }
      if (!result.price) {
        const priceMatch = allText.match(/\$(\d+[.,]\d{2})\s*(?:USD|美元)?/i);
        if (priceMatch) {
          result.price = `$${priceMatch[1]}`;
        }
      }

      return result;
    });

    details.name = info.name;
    details.price = info.price;
    // URL 参数中的优惠码优先级高于页面检测
    if (!details.promoCode && info.promoCode) details.promoCode = info.promoCode;

    if (details.promoCode) {
      console.log(`[Discoverer]     🎫 检测到优惠码: ${details.promoCode}`);
    }

  } catch (err) {
    console.log(`[Discoverer]     ⚠️ 抓取产品详情失败: ${err.message}`);
  } finally {
    await page.close();
  }
  return details;
}

// ============================================================
// 从 WHMCS gid 列表页提取所有 PID
// ============================================================
async function extractPidsFromGidPage(browser, url) {
  const pids = new Set();
  const page = await browser.newPage();
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 25000 });
    await sleep(5000); // 等 CF 验证和 JS 渲染

    // 方法1：从所有链接中提取 pid=XXX
    const linkPids = await page.evaluate(() => {
      return Array.from(document.querySelectorAll('a[href*="pid="]'))
        .map(a => { const m = a.href.match(/pid=(\d+)/); return m ? m[1] : null; })
        .filter(Boolean);
    });
    linkPids.forEach(p => pids.add(p));

    // 方法2：从 hidden input 中提取（ZGO 特惠页格式）
    const inputPids = await page.evaluate(() => {
      return Array.from(document.querySelectorAll('input[name="id"]'))
        .map(el => el.value)
        .filter(v => /^\d+$/.test(v));
    });
    inputPids.forEach(p => pids.add(p));

    // 方法3：从页面源码中正则匹配 pid=XXX（兜底）
    const html = await page.content();
    let m;
    const regex = /pid=(\d+)/gi;
    while ((m = regex.exec(html)) !== null) pids.add(m[1]);

  } catch (err) {
    console.log(`[Discoverer]     ⚠️ 页面打开失败: ${err.message}`);
  } finally {
    await page.close();
  }
  return pids;
}

// ============================================================
// CloudCone 专用探测：URL 格式为 /vps/{id}/create
// ============================================================
async function probeCloudCone(browser, source, catalogRef) {
  const newProducts = [];

  // ── 方法1：从id递增探测 ──
  let maxId = 0;
  catalogRef.forEach(c => {
    if (c.provider === 'cloudcone' && c.checkUrl) {
      const m = c.checkUrl.match(/\/vps\/(\d+)\//); 
      if (m) maxId = Math.max(maxId, parseInt(m[1]));
    }
  });

  if (maxId === 0) {
    // 如果没有已知产品，从 490 开始探测（当前已知有 500）
    maxId = 490;
  }

  console.log(`[Discoverer]     ID 探测范围: ${maxId + 1} ~ ${maxId + source.probeRange}`);

  for (let id = maxId + 1; id <= maxId + source.probeRange; id++) {
    const page = await browser.newPage();
    try {
      const url = `https://app.cloudcone.com/vps/${id}/create`;
      const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
      await sleep(3000);

      // 检查是否是有效产品页面（非 404 或重定向）
      if (resp && resp.status() < 400) {
        const html = await page.content();
        // CloudCone 页面有价格、配置信息就说明是有效产品
        const isValid = html.includes('Create Server') || html.includes('Deploy') || 
                        html.includes('/month') || html.includes('/yr') ||
                        html.includes('SSD') || html.includes('RAM');
        
        if (isValid) {
          console.log(`[Discoverer]     ✅ ID=${id} 存在！`);

          // 提取产品信息
          const info = await page.evaluate(() => {
            const result = { name: null, price: null };
            // CloudCone 页面标题通常在 h1 或 title 中
            const h1 = document.querySelector('h1');
            if (h1) result.name = h1.textContent.trim();
            if (!result.name && document.title) {
              result.name = document.title.replace(/- CloudCone.*$/i, '').trim();
            }
            // 价格
            const allText = document.body.innerText;
            const yrMatch = allText.match(/\$(\d+[.,]\d{2})\s*\/\s*yr/i);
            if (yrMatch) {
              result.price = `$${yrMatch[1]}/年`;
            } else {
              const moMatch = allText.match(/\$(\d+[.,]\d{2})\s*\/\s*mo/i);
              if (moMatch) result.price = `$${moMatch[1]}/月`;
            }
            return result;
          });

          newProducts.push({
            id: id,
            name: info.name || `CloudCone VPS #${id}`,
            price: info.price || '价格待确认',
          });
        }
      }
    } catch (err) {
      // 页面加载失败可能是不存在，跳过
    } finally {
      await page.close();
    }
    await sleep(2000);
  }

  // ── 方法2：扫描促销页提取产品链接 ──
  if (source.promoPages) {
    for (const promoUrl of source.promoPages) {
      const page = await browser.newPage();
      try {
        console.log(`[Discoverer]   扫描促销页: ${promoUrl}`);
        await page.goto(promoUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
        await sleep(4000);

        // CloudCone 促销页链接格式: app.cloudcone.com/vps/{id}/create
        const links = await page.evaluate(() => {
          const results = [];
          document.querySelectorAll('a[href*="/vps/"]').forEach(a => {
            const m = a.href.match(/\/vps\/(\d+)\/(create|buy)/i);
            if (m) results.push(m[1]);
          });
          // 也搜索页面文本中的链接
          const html = document.body.innerHTML;
          const regex = /app\.cloudcone\.com\/vps\/(\d+)\//gi;
          let rm;
          while ((rm = regex.exec(html)) !== null) results.push(rm[1]);
          return [...new Set(results)];
        });

        // 同时尝试提取优惠码
        const promoCode = await page.evaluate(() => {
          const text = document.body.innerText;
          const m = text.match(/(?:coupon|promo\s*code|\u4f18\u60e0\u7801|\u6298\u6263\u7801)[:\s\uff1a]+([A-Z0-9_-]{3,30})/i);
          return m ? m[1] : null;
        });

        for (const vid of links) {
          const alreadyFound = newProducts.some(p => p.id == vid);
          if (!alreadyFound) {
            newProducts.push({
              id: parseInt(vid),
              name: `CloudCone VPS #${vid}`,
              price: '价格待确认',
              promoCode: promoCode,
            });
          } else if (promoCode) {
            // 已找到的产品补充优惠码
            const p = newProducts.find(x => x.id == vid);
            if (p && !p.promoCode) p.promoCode = promoCode;
          }
        }

        console.log(`[Discoverer]     提取到 ${links.length} 个产品链接${promoCode ? ', 优惠码: ' + promoCode : ''}`);
      } catch (err) {
        console.log(`[Discoverer]     ⚠️ 促销页扫描失败: ${err.message}`);
      } finally {
        await page.close();
      }
      await sleep(2000);
    }
  }

  return newProducts;
}

// ============================================================
// PID 递增探测：从已知最大 PID 开始向上试探
// ============================================================
async function probePids(browser, source, catalogRef) {
  const pids = new Set();

  // 找出 catalog 中该商家已有的最大 PID
  let maxPid = 0;
  catalogRef.forEach(c => {
    if (c.provider === source.provider && c.checkUrl) {
      const m = c.checkUrl.match(/pid=(\d+)/);
      if (m) maxPid = Math.max(maxPid, parseInt(m[1]));
    }
  });

  if (maxPid === 0) return pids; // 该商家没有已知 PID，跳过探测

  console.log(`[Discoverer]     PID 探测范围: ${maxPid + 1} ~ ${maxPid + source.probeRange}`);

  for (let pid = maxPid + 1; pid <= maxPid + source.probeRange; pid++) {
    const page = await browser.newPage();
    try {
      const url = `https://${source.domain}/cart.php?a=add&pid=${pid}`;
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
      await sleep(3000);

      const html = await page.content();
      // 如果页面返回了产品配置信息（而不是"Product not found"或空白页），说明这个 PID 存在
      const isValidProduct = !html.includes('Product not found') &&
                             !html.includes('Invalid') &&
                             !html.includes('does not exist') &&
                             (html.includes('Order Summary') || html.includes('Configure') ||
                              html.includes('Annually') || html.includes('Monthly') ||
                              html.includes('Out of Stock') || html.includes('Add to Cart'));

      if (isValidProduct) {
        pids.add(String(pid));
        console.log(`[Discoverer]     ✅ PID=${pid} 存在！`);
      }
    } catch (err) {
      // 超时或网络错误，跳过
    } finally {
      await page.close();
    }
    await sleep(1500);
  }

  return pids;
}

// ============================================================
// 从竞品库存站/测评站智能提取产品信息（cheerio DOM 解析）
// 返回 [{ pid, provider, providerName, domain, contextName, contextPrice, promoCode, isCloudCone }]
// ============================================================
async function extractFromCompetitorSites() {
  const allPids = [];
  const seen = new Set(); // 去重 key：provider-pid

  // 商家域名到 provider 的映射
  const domainMap = {
    'bandwagonhost.com': { provider: 'bandwagonhost', providerName: '搬瓦工', domain: 'bandwagonhost.com' },
    'bwh81.net': { provider: 'bandwagonhost', providerName: '搬瓦工', domain: 'bandwagonhost.com' },
    'bwh1.net': { provider: 'bandwagonhost', providerName: '搬瓦工', domain: 'bandwagonhost.com' },
    'dmit.io': { provider: 'dmit', providerName: 'DMIT', domain: 'www.dmit.io' },
    'racknerd.com': { provider: 'racknerd', providerName: 'RackNerd', domain: 'my.racknerd.com' },
    'my.racknerd.com': { provider: 'racknerd', providerName: 'RackNerd', domain: 'my.racknerd.com' },
    'colocrossing.com': { provider: 'colocrossing', providerName: 'ColoCrossing', domain: 'cloud.colocrossing.com' },
    'zgovps.com': { provider: 'zgocloud', providerName: 'ZGO Cloud', domain: 'clients.zgovps.com' },
  };

  /**
   * 从链接周围的 DOM 上下文中提取产品名称和价格
   * @param {cheerio.CheerioAPI} $ - cheerio 实例
   * @param {cheerio.Element} el - <a> 元素
   * @returns {{ contextName: string|null, contextPrice: string|null, promoCode: string|null }}
   */
  function extractContext($, el) {
    let contextName = null;
    let contextPrice = null;
    let promoCode = null;

    // ── 1. 提取产品名称 ──
    // 尝试从链接文字中抽有意义的名称
    const linkText = $(el).text().trim().replace(/\s+/g, ' ');
    if (linkText && linkText.length > 3 && linkText.length < 120 && !/^(http|img|查看|click|buy|order)/i.test(linkText)) {
      contextName = linkText;
    }

    // 尝试从最近的文章标题提取更完整的名称
    const article = $(el).closest('article, .post, .entry, li, tr, .product-item, .deal-item');
    if (article.length) {
      const heading = article.find('h1, h2, h3, h4, .entry-title, .post-title, .title').first().text().trim();
      if (heading && heading.length > 5 && heading.length < 200) {
        // 如果标题比链接文字信息量大，优先用标题
        if (!contextName || heading.length > contextName.length) {
          contextName = heading;
        }
      }
    }

    // 如果还没有名称，尝试从父容器的纯文本中截取
    if (!contextName) {
      const parent = $(el).closest('p, li, td, div').first();
      const parentText = parent.text().trim().replace(/\s+/g, ' ');
      if (parentText && parentText.length > 5 && parentText.length < 200) {
        contextName = parentText.substring(0, 120);
      }
    }

    // ── 2. 从上下文提取价格 ──
    // 取该链接所在的上下文块（表格行、列表项、段落）的纯文本
    const contextEl = $(el).closest('tr, li, p, div, article').first();
    const contextText = contextEl.length ? contextEl.text() : '';

    // 价格正则：匹配 $XX.XX/年月季 或 $XX.XX/yr/mo/quarterly
    const pricePatterns = [
      /\$(\d+\.\d{2})\s*\/\s*(?:年|yr|year|annually)/i,
      /\$(\d+\.\d{2})\s*\/\s*(?:月|mo|month|monthly)/i,
      /\$(\d+\.\d{2})\s*\/\s*(?:季|quarterly)/i,
      /(?:年付|annually|annual)[\s:：]*\$(\d+\.\d{2})/i,
      /\$(\d+\.\d{2})\s*(?:USD)?\s*(?:per\s+)?(?:year|annum)/i,
      /\$(\d+\.\d{2})\s*(?:USD)?\s*(?:per\s+)?month/i,
    ];
    const periodMap = [
      '年', '月', '季', '年', '年', '月',
    ];

    for (let i = 0; i < pricePatterns.length; i++) {
      const pm = contextText.match(pricePatterns[i]);
      if (pm) {
        contextPrice = `$${pm[1]}/${periodMap[i]}`;
        break;
      }
    }

    // 兜底：直接抓最小的 $X.XX（特价通常最便宜）
    if (!contextPrice) {
      const allPrices = [...contextText.matchAll(/\$(\d+\.\d{2})/g)].map(m => parseFloat(m[1]));
      if (allPrices.length > 0) {
        const minPrice = Math.min(...allPrices);
        contextPrice = `$${minPrice.toFixed(2)}`;
      }
    }

    // ── 3. 优惠码检测 ──
    const promoPatterns = [
      /(?:coupon|promo\s*code|promocode|优惠码|折扣码)[:\s：]+([A-Z0-9_-]{3,30})/i,
      /(?:use|apply|enter)\s+(?:code\s+)?["']?([A-Z0-9_-]{4,30})["']?/i,
    ];
    for (const pat of promoPatterns) {
      const pm = contextText.match(pat);
      if (pm) { promoCode = pm[1]; break; }
    }
    // 也检查 URL 参数中的优惠码
    const href = $(el).attr('href') || '';
    try {
      const u = new URL(href);
      const up = u.searchParams.get('promocode') || u.searchParams.get('promo');
      if (up) promoCode = up;
    } catch {}

    return { contextName, contextPrice, promoCode };
  }

  // ── 开始遍历所有竞品源 ──
  for (const source of COMPETITOR_SOURCES) {
    try {
      console.log(`[Discoverer]   📡 辅助源: ${source.name}`);
      const html = await cloudscraper.get(source.url);
      const $ = cheerio.load(html);

      // 定义处理一页 HTML 的函数
      function processPage(p$, pageName) {
        p$('a[href]').each((_, el) => {
          const href = p$(el).attr('href') || '';

          // ── WHMCS 格式: pid=XXX ──
          const pidMatch = href.match(/(?:https?:\/\/)?(?:www\.)?([\w.-]+)[^\s]*pid=(\d+)/i);
          if (pidMatch) {
            const matchedDomain = pidMatch[1];
            const pid = pidMatch[2];
            for (const [key, info] of Object.entries(domainMap)) {
              if (matchedDomain.includes(key)) {
                const dedup = `${info.provider}-${pid}`;
                if (!seen.has(dedup)) {
                  seen.add(dedup);
                  const ctx = extractContext(p$, el);
                  allPids.push({ pid, ...info, ...ctx });
                }
                break;
              }
            }
          }

          // ── CloudCone 格式: app.cloudcone.com/vps/{id}/create ──
          const ccMatch = href.match(/app\.cloudcone\.com\/vps\/(\d+)\/(create|buy)/i);
          if (ccMatch) {
            const ccId = ccMatch[1];
            const dedup = `cloudcone-${ccId}`;
            if (!seen.has(dedup)) {
              seen.add(dedup);
              const ctx = extractContext(p$, el);
              allPids.push({
                pid: ccId,
                provider: 'cloudcone',
                providerName: 'CloudCone',
                domain: 'app.cloudcone.com',
                isCloudCone: true,
                ...ctx,
              });
            }
          }
        });
      }

      // 处理当前页面
      processPage($, source.name);
      const beforeCount = allPids.length;

      // ── 两级扫描：如果源标记了 deepScan，进入每篇文章详情页去抓产品链接 ──
      if (source.deepScan) {
        // 提取本页所有内部文章链接（测评站文章通常包含在同域名下）
        const articleLinks = new Set();
        const sourceHost = new URL(source.url).hostname;
        $('a[href]').each((_, el) => {
          const href = $(el).attr('href') || '';
          try {
            const u = new URL(href, source.url);
            // 同域名、是文章路径（有多层的）、且非标签/分类/分页、非当前页
            if (u.hostname === sourceHost &&
                u.pathname.length > 5 &&
                !u.pathname.match(/\/(tag|category|page|author|feed|wp-|#)\//i) &&
                u.pathname !== new URL(source.url).pathname) {
              // 只留包含特价/活动关键词的文章，或商家名的文章
              const linkText = $(el).text().toLowerCase();
              const pathLower = u.pathname.toLowerCase();
              const isRelevant =
                /cloudcone|racknerd|dmit|bandwagon|colocross|zgo/i.test(pathLower + ' ' + linkText) ||
                /sale|deal|promo|offer|coupon|cheap|\$\d|flash|special|holiday|christmas|easter|black.?friday|new.?year|hashtag/i.test(pathLower + ' ' + linkText);
              if (isRelevant) {
                articleLinks.add(u.href);
              }
            }
          } catch {}
        });

        // 只深入前 8 篇文章（避免太慢）
        const articles = [...articleLinks].slice(0, 8);
        if (articles.length > 0) {
          console.log(`[Discoverer]     📎 深入扫描 ${articles.length} 篇相关文章...`);
        }
        for (const articleUrl of articles) {
          try {
            const aHtml = await cloudscraper.get(articleUrl);
            const a$ = cheerio.load(aHtml);
            processPage(a$, articleUrl);
            await sleep(800);
          } catch (err) {
            console.log(`[Discoverer]       ⚠️ 文章扫描失败: ${err.message}`);
          }
        }
      }

      const found = allPids.length - beforeCount;
      if (found > 0) console.log(`[Discoverer]     ✅ 从 ${source.name} 提取到 ${found} 条新链接`);
    } catch (err) {
      console.log(`[Discoverer]   ⚠️ 辅助源失败 [${source.name}]: ${err.message}`);
    }
  }

  return allPids;
}

// ============================================================
// 主扫描函数
// ============================================================
export async function runDiscovery(bot, adminChatId, catalogRef, reloadCatalog) {
  console.log(`\n[Discoverer] ═══════════════════════════════════════`);
  console.log(`[Discoverer] 🔍 产品发现引擎启动 — ${new Date().toLocaleString('zh-CN')}`);
  console.log(`[Discoverer] ═══════════════════════════════════════`);

  const catalogPath = path.join(__dirname, 'catalog.json');
  let totalNewCount = 0;
  const newsByProvider = {}; // { providerName: [pid] }

  const browser = await getDiscoverBrowser();

  // ── 第一层：扫描官方商家页面 ──
  for (const source of SCAN_SOURCES) {
    console.log(`\n[Discoverer] 📡 ${source.providerName} (${source.mode})`);
    let discoveredPids = new Set();

    try {
      if (source.mode === 'gid-scan') {
        // 逐个 gid 页面扫描
        for (const { gid, label } of source.gids) {
          const url = `https://${source.domain}/cart.php?gid=${gid}`;
          console.log(`[Discoverer]   扫描 gid=${gid} (${label})`);
          const pids = await extractPidsFromGidPage(browser, url);
          pids.forEach(p => discoveredPids.add(p));
          console.log(`[Discoverer]     提取到 ${pids.size} 个 PID`);
          await sleep(2000);
        }

        // 额外的非标准页面（如 ZGO 特惠聚合页）
        if (source.extraUrls) {
          for (const { url, label } of source.extraUrls) {
            console.log(`[Discoverer]   扫描 ${label}`);
            const pids = await extractPidsFromGidPage(browser, url);
            pids.forEach(p => discoveredPids.add(p));
            console.log(`[Discoverer]     提取到 ${pids.size} 个 PID`);
            await sleep(2000);
          }
        }
      } else if (source.mode === 'pid-probe') {
        // PID 递增探测
        discoveredPids = await probePids(browser, source, catalogRef);
      } else if (source.mode === 'page-scan') {
        // 通用页面扫描
        for (const url of source.scanUrls) {
          console.log(`[Discoverer]   扫描 ${url}`);
          const pids = await extractPidsFromGidPage(browser, url);
          pids.forEach(p => discoveredPids.add(p));
          console.log(`[Discoverer]     提取到 ${pids.size} 个 PID`);
          await sleep(2000);
        }
      } else if (source.mode === 'cloudcone-probe') {
        // CloudCone 专用探测
        const ccProducts = await probeCloudCone(browser, source, catalogRef);
        
        for (const cc of ccProducts) {
          const ccId = `cloudcone-auto-${cc.id}`;
          const exists = catalogRef.some(c =>
            c.id === ccId ||
            (c.provider === 'cloudcone' && c.checkUrl && c.checkUrl.includes(`/vps/${cc.id}/`))
          );

          if (!exists) {
            const newEntry = {
              id: ccId,
              provider: 'cloudcone',
              providerName: 'CloudCone',
              name: cc.name,
              price: cc.price,
              promoCode: cc.promoCode || null,
              specs: { cpu: '待确认', ram: '待确认', disk: '待确认', bandwidth: '待确认' },
              datacenters: ['待确认'],
              networkRoutes: ['普通线路'],
              outOfStockKeywords: source.outOfStockKeywords,
              checkUrl: `https://app.cloudcone.com/vps/${cc.id}/create`,
              affUrl: `https://app.cloudcone.com/vps/${cc.id}/create?${source.affParam}${cc.promoCode ? '&token=' + cc.promoCode : ''}`,
              isSpecialOffer: true
            };
            catalogRef.push(newEntry);
            totalNewCount++;
            if (!newsByProvider['CloudCone']) newsByProvider['CloudCone'] = [];
            newsByProvider['CloudCone'].push(cc.id);
            console.log(`[Discoverer]   🆕 新品: CloudCone ID=${cc.id} (${cc.name})`);
          }
        }
        continue; // CloudCone 已在内部处理完 diff，跳过后面通用的 WHMCS diff 逻辑
      }
    } catch (err) {
      console.error(`[Discoverer]   ❌ ${source.providerName} 扫描异常: ${err.message}`);
    }

    // 和 catalog 做 diff
    for (const pid of discoveredPids) {
      const exists = catalogRef.some(c =>
        (c.provider === source.provider && c.checkUrl && c.checkUrl.includes(`pid=${pid}`)) ||
        c.id === `${source.provider}-auto-${pid}` ||
        c.id === `${source.provider}-specials-${pid}` ||
        c.id === `${source.provider}-${pid}`
      );

      if (!exists) {
        // 自动抓取产品页面获取真实名称和价格
        const productUrl = `https://${source.domain}/cart.php?a=add&pid=${pid}`;
        console.log(`[Discoverer]     📝 抓取产品详情: PID=${pid}`);
        const details = await scrapeProductDetails(browser, productUrl);
        await sleep(1500);

        const realName = details.name || `${source.providerName} 新品 (pid=${pid})`;
        const realPrice = details.price || '价格待确认';
        console.log(`[Discoverer]     → 名称: ${realName}, 价格: ${realPrice}`);

        const newEntry = {
          id: `${source.provider}-auto-${pid}`,
          provider: source.provider,
          providerName: source.providerName,
          name: realName,
          price: realPrice,
          promoCode: details.promoCode || null,
          specs: { cpu: '待确认', ram: '待确认', disk: '待确认', bandwidth: '待确认' },
          datacenters: ['待确认'],
          networkRoutes: ['待确认'],
          outOfStockKeywords: source.outOfStockKeywords || ['Out of Stock', 'out of stock'],
          checkUrl: productUrl,
          affUrl: `https://${source.domain}/aff.php?${source.affParam}&pid=${pid}${details.promoCode ? '&promocode=' + details.promoCode : ''}`,
          isSpecialOffer: true
        };
        catalogRef.push(newEntry);
        totalNewCount++;
        if (!newsByProvider[source.providerName]) newsByProvider[source.providerName] = [];
        newsByProvider[source.providerName].push(pid);
        console.log(`[Discoverer]   🆕 新品: ${source.providerName} PID=${pid}`);
      }
    }
  }

  // ── 第二层：竞品库存站+测评站智能提取 ──
  console.log(`\n[Discoverer] 📡 辅助查漏补缺（竞品站+测评站 · 智能提取模式）`);
  const competitorPids = await extractFromCompetitorSites();
  let autoLiveCount = 0; // 直接上架数
  let pendingCount = 0;  // 待确认数

  for (const cp of competitorPids) {
    // ── CloudCone 分支 ──
    if (cp.isCloudCone) {
      const ccId = `cloudcone-auto-${cp.pid}`;
      const ccExists = catalogRef.some(c =>
        c.id === ccId ||
        (c.provider === 'cloudcone' && c.checkUrl && c.checkUrl.includes(`/vps/${cp.pid}/`))
      );
      if (!ccExists) {
        // 优先用上下文提取到的名称和价格
        const name = cp.contextName || `CloudCone VPS #${cp.pid}`;
        const price = cp.contextPrice || '价格待确认';
        const isAutoLive = price !== '价格待确认';

        const newEntry = {
          id: ccId, provider: 'cloudcone', providerName: 'CloudCone',
          name, price, promoCode: cp.promoCode || null,
          specs: { cpu: '待确认', ram: '待确认', disk: '待确认', bandwidth: '待确认' },
          datacenters: ['待确认'], networkRoutes: ['普通线路'],
          outOfStockKeywords: ['sold out', 'Sold Out', 'unavailable'],
          checkUrl: `https://app.cloudcone.com/vps/${cp.pid}/create`,
          affUrl: `https://app.cloudcone.com/vps/${cp.pid}/create?ref=${AFF.cc}`,
          isSpecialOffer: true
        };
        catalogRef.push(newEntry);
        totalNewCount++;
        if (isAutoLive) autoLiveCount++; else pendingCount++;
        if (!newsByProvider['CloudCone']) newsByProvider['CloudCone'] = [];
        newsByProvider['CloudCone'].push({ pid: cp.pid, name, price, autoLive: isAutoLive });
        console.log(`[Discoverer]   🆕 ${isAutoLive ? '✅ 直接上架' : '⏳ 待确认'}: CloudCone ID=${cp.pid} → ${name} ${price}`);
      }
      continue;
    }

    // ── 通用 WHMCS 商家分支 ──
    const exists = catalogRef.some(c =>
      (c.provider === cp.provider && c.checkUrl && c.checkUrl.includes(`pid=${cp.pid}`)) ||
      c.id === `${cp.provider}-auto-${cp.pid}` ||
      c.id === `${cp.provider}-specials-${cp.pid}` ||
      c.id === `${cp.provider}-${cp.pid}`
    );

    if (!exists) {
      const src = SCAN_SOURCES.find(s => s.provider === cp.provider);
      const affParam = src ? src.affParam : '';

      // 先用上下文提取的信息；不够再用 puppeteer 抓详情页
      let realName = cp.contextName;
      let realPrice = cp.contextPrice;
      let promoCode = cp.promoCode;

      // 如果上下文没提到价格，尝试进产品页面抓一次
      if (!realPrice) {
        const productUrl = `https://${cp.domain}/cart.php?a=add&pid=${cp.pid}`;
        console.log(`[Discoverer]     📝 上下文缺价格，进页面抓: PID=${cp.pid}`);
        const details = await scrapeProductDetails(browser, productUrl);
        await sleep(1500);
        if (!realName) realName = details.name;
        realPrice = details.price;
        if (!promoCode && details.promoCode) promoCode = details.promoCode;
      }

      realName = realName || `${cp.providerName} 新品 (pid=${cp.pid})`;
      realPrice = realPrice || '价格待确认';
      const isAutoLive = realPrice !== '价格待确认';

      const productUrl = `https://${cp.domain}/cart.php?a=add&pid=${cp.pid}`;
      const newEntry = {
        id: `${cp.provider}-auto-${cp.pid}`,
        provider: cp.provider,
        providerName: cp.providerName,
        name: realName,
        price: realPrice,
        promoCode: promoCode || null,
        specs: { cpu: '待确认', ram: '待确认', disk: '待确认', bandwidth: '待确认' },
        datacenters: ['待确认'],
        networkRoutes: ['待确认'],
        outOfStockKeywords: ['Out of Stock', 'out of stock'],
        checkUrl: productUrl,
        affUrl: affParam
          ? `https://${cp.domain}/aff.php?${affParam}&pid=${cp.pid}${promoCode ? '&promocode=' + promoCode : ''}`
          : productUrl,
        isSpecialOffer: true
      };
      catalogRef.push(newEntry);
      totalNewCount++;
      if (isAutoLive) autoLiveCount++; else pendingCount++;
      if (!newsByProvider[cp.providerName]) newsByProvider[cp.providerName] = [];
      newsByProvider[cp.providerName].push({ pid: cp.pid, name: realName, price: realPrice, autoLive: isAutoLive });
      console.log(`[Discoverer]   🆕 ${isAutoLive ? '✅ 直接上架' : '⏳ 待确认'}: ${cp.providerName} PID=${cp.pid} → ${realName} ${realPrice}`);
    }
  }

  // ── 写入 + 热加载 + TG 通知 ──
  if (totalNewCount > 0) {
    fs.writeFileSync(catalogPath, JSON.stringify(catalogRef, null, 2));
    reloadCatalog();
    console.log(`\n[Discoverer] ✅ 本轮发现 ${totalNewCount} 款新品，已写入 catalog.json 并热加载`);

    if (bot && adminChatId) {
      let msg = `🕵️ <b>产品发现引擎报告</b>\n\n`;
      msg += `本轮发现 <b>${totalNewCount}</b> 款新品`;
      if (autoLiveCount > 0) msg += `，其中 <b>${autoLiveCount}</b> 款已自动上架 🚀`;
      if (pendingCount > 0) msg += `，<b>${pendingCount}</b> 款待确认 ⏳`;
      msg += `\n\n`;
      for (const [provName, items] of Object.entries(newsByProvider)) {
        msg += `📦 <b>${provName}</b>: ${items.length} 款\n`;
        for (const item of (Array.isArray(items) && typeof items[0] === 'object' ? items : [])) {
          const icon = item.autoLive ? '✅' : '⏳';
          msg += `   ${icon} ${item.name} — ${item.price}\n`;
        }
        // 兼容旧格式（纯 pid 数组，来自第一层 WHMCS 扫描）
        if (Array.isArray(items) && items.length > 0 && typeof items[0] !== 'object') {
          msg += `   PID: ${items.join(', ')}\n`;
        }
        msg += `\n`;
      }
      if (pendingCount > 0) msg += `⚠️ 待确认产品请到后台补全信息`;
      bot.sendMessage(adminChatId, msg, { parse_mode: 'HTML' })
        .catch(e => console.error('[Discoverer] TG 通知失败:', e.message));
    }
  } else {
    console.log(`\n[Discoverer] ✅ 扫描完成，未发现新品。当前共 ${catalogRef.length} 款`);
  }

  await closeDiscoverBrowser();
  return totalNewCount;
}

// ============================================================
// 启动定时引擎（集成到 scraper.js 的主循环中使用）
// ============================================================
export function startDiscoveryEngine(bot, adminChatId, catalogRef, reloadCatalog, intervalHours = 4) {
  // 启动 60 秒后执行首次扫描（给 scraper 先加载完的时间）
  setTimeout(() => {
    runDiscovery(bot, adminChatId, catalogRef, reloadCatalog);
  }, 60 * 1000);

  // 定时循环
  setInterval(() => {
    runDiscovery(bot, adminChatId, catalogRef, reloadCatalog);
  }, intervalHours * 60 * 60 * 1000);

  console.log(`[Discoverer] 🚀 产品发现引擎已挂载，周期: 每 ${intervalHours} 小时`);
}
