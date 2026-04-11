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
];

// ============================================================
// 竞品库存站（辅助来源，不作为唯一依赖）
// ============================================================
const COMPETITOR_SOURCES = [
  { name: '搬瓦工库存站 (bwh91)', url: 'https://stock.bwh91.com/' },
  { name: 'DMIT库存站 (dmitea)', url: 'https://stock.dmitea.com/' },
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
// 从竞品库存站提取 PID（辅助补全）
// ============================================================
async function extractFromCompetitorSites() {
  const allPids = []; // { pid, provider, providerName, domain }

  // 商家域名到 provider 的映射
  const domainMap = {
    'bandwagonhost.com': { provider: 'bandwagonhost', providerName: '搬瓦工', domain: 'bandwagonhost.com' },
    'bwh81.net': { provider: 'bandwagonhost', providerName: '搬瓦工', domain: 'bandwagonhost.com' },
    'dmit.io': { provider: 'dmit', providerName: 'DMIT', domain: 'www.dmit.io' },
    'racknerd.com': { provider: 'racknerd', providerName: 'RackNerd', domain: 'my.racknerd.com' },
    'my.racknerd.com': { provider: 'racknerd', providerName: 'RackNerd', domain: 'my.racknerd.com' },
  };

  for (const source of COMPETITOR_SOURCES) {
    try {
      console.log(`[Discoverer]   辅助源: ${source.name}`);
      const html = await cloudscraper.get(source.url);

      const regex = /https?:\/\/(?:www\.)?([\w.-]+)[^\s"'<>]*pid=(\d+)/gi;
      let m;
      while ((m = regex.exec(html)) !== null) {
        const matchedDomain = m[1];
        const pid = m[2];
        for (const [key, info] of Object.entries(domainMap)) {
          if (matchedDomain.includes(key)) {
            allPids.push({ pid, ...info });
            break;
          }
        }
      }
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
        const newEntry = {
          id: `${source.provider}-auto-${pid}`,
          provider: source.provider,
          providerName: source.providerName,
          name: `${source.providerName} 自动发现 (pid=${pid})`,
          price: '待确认',
          specs: { cpu: '待确认', ram: '待确认', disk: '待确认', bandwidth: '待确认' },
          datacenters: ['待确认'],
          networkRoutes: ['待确认'],
          outOfStockKeywords: source.outOfStockKeywords || ['Out of Stock', 'out of stock'],
          checkUrl: `https://${source.domain}/cart.php?a=add&pid=${pid}`,
          affUrl: `https://${source.domain}/aff.php?${source.affParam}&pid=${pid}`,
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

  // ── 第二层：竞品库存站辅助补全 ──
  console.log(`\n[Discoverer] 📡 辅助查漏补缺（竞品库存站）`);
  const competitorPids = await extractFromCompetitorSites();
  for (const cp of competitorPids) {
    const exists = catalogRef.some(c =>
      (c.provider === cp.provider && c.checkUrl && c.checkUrl.includes(`pid=${cp.pid}`)) ||
      c.id === `${cp.provider}-auto-${cp.pid}` ||
      c.id === `${cp.provider}-specials-${cp.pid}` ||
      c.id === `${cp.provider}-${cp.pid}`
    );

    if (!exists) {
      // 从 SCAN_SOURCES 中找对应的 affParam
      const src = SCAN_SOURCES.find(s => s.provider === cp.provider);
      const affParam = src ? src.affParam : '';

      const newEntry = {
        id: `${cp.provider}-auto-${cp.pid}`,
        provider: cp.provider,
        providerName: cp.providerName,
        name: `${cp.providerName} 自动发现 (pid=${cp.pid})`,
        price: '待确认',
        specs: { cpu: '待确认', ram: '待确认', disk: '待确认', bandwidth: '待确认' },
        datacenters: ['待确认'],
        networkRoutes: ['待确认'],
        outOfStockKeywords: ['Out of Stock', 'out of stock'],
        checkUrl: `https://${cp.domain}/cart.php?a=add&pid=${cp.pid}`,
        affUrl: affParam ? `https://${cp.domain}/aff.php?${affParam}&pid=${cp.pid}` : `https://${cp.domain}/cart.php?a=add&pid=${cp.pid}`,
        isSpecialOffer: true
      };
      catalogRef.push(newEntry);
      totalNewCount++;
      if (!newsByProvider[cp.providerName]) newsByProvider[cp.providerName] = [];
      newsByProvider[cp.providerName].push(cp.pid);
      console.log(`[Discoverer]   🆕 竞品站补全: ${cp.providerName} PID=${cp.pid}`);
    }
  }

  // ── 写入 + 热加载 + TG 通知 ──
  if (totalNewCount > 0) {
    fs.writeFileSync(catalogPath, JSON.stringify(catalogRef, null, 2));
    reloadCatalog();
    console.log(`\n[Discoverer] ✅ 本轮发现 ${totalNewCount} 款新品，已写入 catalog.json 并热加载`);

    if (bot && adminChatId) {
      let msg = `🕵️ <b>产品发现引擎报告</b>\n\n`;
      msg += `本轮扫描完成，发现 <b>${totalNewCount}</b> 款新产品，已自动加入监控：\n\n`;
      for (const [provName, pids] of Object.entries(newsByProvider)) {
        msg += `📦 <b>${provName}</b>: ${pids.length} 款新品\n`;
        msg += `   PID: ${pids.join(', ')}\n`;
        msg += `   ⚠️ 请确认名称和价格\n\n`;
      }
      msg += `登录网页后台编辑详细信息 →`;
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
