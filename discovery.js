/**
 * discovery.js — 产品发现引擎
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
import fetch from 'node-fetch';
import * as cheerio from 'cheerio';
import db from './db.js';
// 共享 Chromium 单例，与 scraper.js 复用同一进程
import { getBrowser } from './browser.js';
import { JUNK_NAME_RE, AFF } from './constants.js';

const sleep = ms => new Promise(r => setTimeout(r, ms));

// 垃圾名称正则和推广 ID 统一来自 constants.js（唯一 truth source）

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
    probeRange: 10, // RackNerd 活动频繁但产品多从竞品站发现，探测范围适度
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
    mode: 'pid-probe',
    probeRange: 10,
    startPid: 10,     // 由于可能没有历史存量，提供一个安全起点，强制扫描
    outOfStockKeywords: ['Out of Stock', 'out of stock'],
  },

  // ── GreenCloud ──
  {
    provider: 'greencloud',
    providerName: 'GreenCloud',
    domain: 'greencloudvps.com',
    affParam: `aff=${AFF.greencloud}`,
    mode: 'gid-scan',
    gids: [
      { gid: 1, label: 'Special Offers / Anniversary' },
    ],
    extraUrls: [
      { url: 'https://greencloudvps.com/billing/promotions.php', label: '官方 Promotions' },
      { url: 'https://greencloudvps.com/billing/cart.php?gid=1', label: '特价与周年庆列表' },
      { url: 'https://greencloudvps.com/billing/store/cn-premium-optimized', label: 'CN Premium Optimized（中国优化线路）' },
      { url: 'https://greencloudvps.com/billing/store/budget-kvm-sale', label: 'Budget KVM Sale（特价 KVM）' },
    ],
    outOfStockKeywords: ['Out of Stock', 'out of stock', 'Sold Out', 'sold out'],
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
  { name: 'VNCoupon (RackNerd)', url: 'https://vncoupon.com/tag/racknerd/', deepScan: true },
  { name: 'VNCoupon (DMIT)', url: 'https://vncoupon.com/tag/dmit/', deepScan: true },
  { name: 'VNCoupon (GreenCloud)', url: 'https://vncoupon.com/tag/greencloud/', deepScan: true },
  // ── VNCoupon 已知的重要活动详情页（直接含产品链接） ──
  { name: 'VNCoupon RN 新年特价', url: 'https://vncoupon.com/racknerd-new-year-2022-vps-hosting-deals/' },
  { name: 'VNCoupon 便宜VPS列表', url: 'https://vncoupon.com/a-list-of-cheap-vps-hosting-under-12-year/' },
  // ── 商家官方活动页 ──
  { name: 'GreenCloud Promotions', url: 'https://greencloudvps.com/billing/promotions.php', deepScan: true },
  { name: 'RackNerd Blog', url: 'https://www.racknerd.com/blog/', deepScan: true },
  // ── LowEndTalk / LowEndBox ──
  { name: 'LowEndTalk GreenCloud', url: 'https://lowendtalk.com/discussions/tagged/greencloud', deepScan: true },
  { name: 'LowEndBox', url: 'https://lowendbox.com/', deepScan: true },
];

// ============================================================
// 浏览器由 browser.js 共享单例提供，此处不再独立管理
// ============================================================

// ============================================================
// 从产品页面抓取真实名称、价格和优惠码
// ============================================================
async function scrapeProductDetails(browser, url) {
  const details = { name: null, price: null, promoCode: null, billingCycles: null, specs: {} };
  const page = await browser.newPage();
  try {
    // 先检查 URL 参数中是否已有优惠码
    try {
      const parsed = new URL(url);
      const urlPromo = parsed.searchParams.get('promocode') || parsed.searchParams.get('promo');
      if (urlPromo) details.promoCode = urlPromo;
    } catch {}

    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
    
    // 🛡️ 发现引擎防线：反重定向劫持
    let urlObj;
    try { urlObj = new URL(page.url()); } catch(e) {}
    if (urlObj && url.includes('pid=') && !urlObj.searchParams.has('pid') && !urlObj.searchParams.has('id') && !urlObj.searchParams.has('i')) {
      console.log(`[Discoverer]     🚫 重定向劫持拦截: ${url} -> ${page.url()}`);
      details.isInvalid = true;
      return details;
    }

    await sleep(4000);

    // 从页面中提取产品名称、价格和优惠码
    const info = await page.evaluate(() => {
      const result = { name: null, price: null, promoCode: null, hasPromoField: false };

      // ── 检测是否无效页面 (404/失效) ──
      const allText = document.body.innerText;
      const title = document.title || '';
      if (allText.includes('404 Not found') || title.includes('404 Not Found') || allText.includes('The resource requested could not be found') || allText.includes('Stack Error')) {
        result.isInvalid = true;
      }

      // ── 提取产品名称（多策略，避免误取 WHMCS 通用标题） ──
      const junkTitles = /^(Shopping Cart|Configure|Order|Review|Checkout|Error|404|Oops)$/i;

      // 策略 1：WHMCS 产品配置区域（比 h1 更精确）
      const whmcsNameEl = document.querySelector('.product-title') ||
                          document.querySelector('.product-name') ||
                          document.querySelector('#product-name') ||
                          document.querySelector('.panel-heading .panel-title') ||
                          document.querySelector('.product-group h3') ||
                          document.querySelector('#order-standard_cart .header h1');
      if (whmcsNameEl) {
        let n = whmcsNameEl.textContent.trim().replace(/^(Configure|Order|配置)\s*/i, '').trim();
        if (n && n.length > 1 && n.length < 150 && !junkTitles.test(n)) result.name = n;
      }

      // 策略 2：面包屑导航（WHMCS 面包屑通常含真实产品名）
      if (!result.name) {
        const breadcrumb = document.querySelector('.breadcrumb li:last-child, .breadcrumb li.active, nav[aria-label="breadcrumb"] li:last-child');
        if (breadcrumb) {
          let n = breadcrumb.textContent.trim();
          if (n && n.length > 2 && n.length < 150 && !junkTitles.test(n)) result.name = n;
        }
      }

      // 策略 3：h1（兜底，但过滤掉 WHMCS 通用标题）
      if (!result.name) {
        const h1 = document.querySelector('h1');
        if (h1) {
          let n = h1.textContent.trim().replace(/^(Configure|Order|配置)\s*/i, '').trim();
          if (n && n.length > 1 && n.length < 150 && !junkTitles.test(n)) result.name = n;
        }
      }

      // 策略 4：document.title（去除站名后缀）
      if (!result.name && document.title) {
        const t = document.title.replace(/\s*[-|–—].*$/, '').trim();
        if (t && t.length > 2 && t.length < 100 && !junkTitles.test(t)) result.name = t;
      }

      // ── 剔除明确不是 VPS 的无关产品和垃圾页面 ──
      const nonVpsPatterns = /Shared Hosting|cPanel|Reseller|Virtual Web Hosting|Dedicated Server|Domain Registration|Addon|Extra IP|SSL Certificate|Shopping Cart|Oops|there.*problem|Cloud Virtual Private Servers|Web Hosting|Error|Page Not Found|404|just a moment|checking your browser|cloudflare|stack error/i;
      if (result.name && nonVpsPatterns.test(result.name)) {
        result.isInvalid = true;
        result.name = null;  // 不要存垃圾名称，让调用方用生成名或跳过
      }

      // ── 检测邀请码限制产品 ──
      // 仅标记 flag，不立刻判无效；后续如果提取到了邀请码/优惠码，仍可上架
      const invitePatterns = /invite\s*code\s*required|invitation\s*only|invite[\s-]*only|仅限邀请/i;
      result.inviteRequired = invitePatterns.test(allText);

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
      // allText 已在上方第 229 行声明

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

      // ── 提取价格 + 全部计费周期（精确解析 WHMCS 计费周期） ──
      // 策略：优先读 WHMCS 的 <select> 下拉框 DOM，正则兜底

      // ---- 第一优先级：WHMCS 下拉框精确提取（同时提取所有周期） ----
      const billingSelect = document.querySelector('select[name="billingcycle"]');
      if (billingSelect && billingSelect.options.length > 0) {
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
          result.price = defaultPrice
            ? (defaultPrice + (defaultDisplay ? '/' + defaultDisplay : ''))
            : Object.values(cycles)[0];
        }
        // 如果还是没有价格，降级到逐项扫描
        if (!result.price) {
          for (const opt of billingSelect.options) {
            const t = opt.textContent.trim();
            const pm = t.match(/\$(\d+[.,]\d{2})/);
            if (pm) { result.price = '$' + pm[1]; break; }
          }
        }
      }

      // ---- 第 1.5 优先级：DMIT 等自定义按钮式计费周期选择器 ----
      // DMIT 不用 <select>，用的是一组按钮（active 状态标识选中周期）
      // 同时右侧 Order Summary 面板显示 "$89.90 USD / Monthly"
      if (!result.price) {
        const cycleMap = {
          'monthly': '月', 'quarterly': '季', 'semi-annually': '半年',
          'annually': '年', 'biennially': '两年', 'triennially': '三年',
        };

        // 方式 A：找 active/selected 的计费周期按钮
        const activeBtn = document.querySelector('.billing-cycle .active, .billing-cycle .selected, [class*="billing"] .active, [class*="cycle"] .active, button.active[data-cycle], .btn-group .active');
        if (activeBtn) {
          const btnText = activeBtn.textContent.trim().toLowerCase();
          let detectedPeriod = '';
          for (const [key, val] of Object.entries(cycleMap)) {
            if (btnText.includes(key)) { detectedPeriod = val; break; }
          }
          if (detectedPeriod) {
            // 周期确定了，从 Order Summary 或页面正文中提取价格金额
            const summaryArea = document.querySelector('.order-summary, [class*="summary"], [class*="order"], .price-display, .total') || document.body;
            const summaryTxt = summaryArea.innerText;
            const pm = summaryTxt.match(/\$\s*(\d+[.,]\d{2})/);
            if (pm) {
              result.price = '$' + pm[1] + '/' + detectedPeriod;
            }
          }
        }
      }

      // ---- 第二优先级：结算摘要 DOM 区域内匹配 ----
      if (!result.price) {
        const summaryEl = document.querySelector('.order-summary, .product-pricing, #order-standard_cart, .total-due-today, .amt');
        const summaryText = summaryEl ? summaryEl.innerText : '';
        if (summaryText) {
          const patterns = [
            // 正向：周期词在前（WHMCS 格式）
            { re: /annually[:\s]*\$(\d+[.,]\d{2})/i, p: '年' },
            { re: /monthly[:\s]*\$(\d+[.,]\d{2})/i, p: '月' },
            { re: /quarterly[:\s]*\$(\d+[.,]\d{2})/i, p: '季' },
            // 反向：价格在前，周期词在后（DMIT Order Summary 格式: "$89.90 USD / Monthly"）
            { re: /\$(\d+[.,]\d{2})\s*(?:USD)?\s*\/?\s*Monthly/i, p: '月' },
            { re: /\$(\d+[.,]\d{2})\s*(?:USD)?\s*\/?\s*Annually/i, p: '年' },
            { re: /\$(\d+[.,]\d{2})\s*(?:USD)?\s*\/?\s*Quarterly/i, p: '季' },
            { re: /\$(\d+[.,]\d{2})\s*(?:USD)?\s*\/?\s*Semi-?Annually/i, p: '半年' },
            { re: /\$(\d+[.,]\d{2})\s*\/\s*yr/i, p: '年' },
            { re: /\$(\d+[.,]\d{2})\s*\/\s*mo/i, p: '月' },
          ];
          for (const { re, p } of patterns) {
            const m = summaryText.match(re);
            if (m) { result.price = '$' + m[1] + '/' + p; break; }
          }
        }
      }

      // ---- 第三优先级：全文正则，限制匹配距离 + 双向匹配 ----
      if (!result.price) {
        const strictPatterns = [
          // 紧邻格式
          { re: /\$(\d+[.,]\d{2})\s*\/\s*yr/i, p: '年' },
          { re: /\$(\d+[.,]\d{2})\s*\/\s*mo/i, p: '月' },
          // 反向：价格在前（DMIT 格式）
          { re: /\$(\d+[.,]\d{2})\s*(?:USD)?\s*\/?\s*Monthly/i, p: '月' },
          { re: /\$(\d+[.,]\d{2})\s*(?:USD)?\s*\/?\s*Annually/i, p: '年' },
          { re: /\$(\d+[.,]\d{2})\s*(?:USD)?\s*\/?\s*Quarterly/i, p: '季' },
          { re: /\$(\d+[.,]\d{2})\s*(?:USD)?\s*\/?\s*Semi-?Annually/i, p: '半年' },
          // 正向：周期词在前（限 50 字符距离）
          { re: /Annually.{0,50}\$(\d+[.,]\d{2})/i, p: '年' },
          { re: /Monthly.{0,50}\$(\d+[.,]\d{2})/i, p: '月' },
          { re: /Quarterly.{0,50}\$(\d+[.,]\d{2})/i, p: '季' },
        ];
        for (const { re, p } of strictPatterns) {
          const m = allText.match(re);
          if (m) { result.price = '$' + m[1] + '/' + p; break; }
        }
      }

      // ---- 最后兜底：裸 $XX.XX（不带周期） ----
      if (!result.price) {
        const priceMatch = allText.match(/\$(\d+[.,]\d{2})\s*(?:USD|美元)?/i);
        if (priceMatch) {
          result.price = '$' + priceMatch[1];
        }
      }

      return result;
    });

    details.name = info.name;
    details.price = info.price;
    details.isInvalid = info.isInvalid;
    if (info.billingCycles && Object.keys(info.billingCycles).length > 0) {
      details.billingCycles = info.billingCycles;
    }
    // URL 参数中的优惠码优先级高于页面检测
    if (!details.promoCode && info.promoCode) details.promoCode = info.promoCode;

    if (details.promoCode) {
      console.log(`[Discoverer]     🎫 检测到优惠码: ${details.promoCode}`);
    }

    // 需要邀请码但未找到任何邀请码/优惠码 → 不可公开购买，标记无效
    // 如果找到了优惠码/邀请码 → 可以上架（带码销售）
    if (info.inviteRequired && !details.promoCode) {
      details.isInvalid = true;
      console.log(`[Discoverer]     🔒 需要邀请码但未找到，标记为不可上架`);
    } else if (info.inviteRequired && details.promoCode) {
      console.log(`[Discoverer]     🔓 需要邀请码，已找到码 ${details.promoCode}，允许上架`);
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

  if (maxPid === 0) {
    if (source.startPid) maxPid = source.startPid;
    else return pids; // 该商家没有已知 PID，且无默认起点，跳过探测
  }

  console.log(`[Discoverer]     PID 探测范围: ${maxPid + 1} ~ ${maxPid + source.probeRange}`);

  for (let pid = maxPid + 1; pid <= maxPid + source.probeRange; pid++) {
    // 黑名单检查：已拉黑的 PID 直接跳过，不浪费浏览器资源
    const candidateId = `${source.provider}-auto-${pid}`;
    if (db.isIdPurged(candidateId)) {
      console.log(`[Discoverer]     ⚫ PID=${pid} 已拉黑，跳过`);
      continue;
    }
    const page = await browser.newPage();
    try {
      const url = `https://${source.domain}/cart.php?a=add&pid=${pid}`;
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
      
      let urlObj;
      try { urlObj = new URL(page.url()); } catch(e) {}
      if (urlObj && !urlObj.searchParams.has('pid') && !urlObj.searchParams.has('id') && !urlObj.searchParams.has('i')) {
        console.log(`[Discoverer]     ⏭️ PID=${pid} 重定向到大厅，判定为不存在/已下架`);
        continue;
      }
      
      await sleep(3000);

      const html = await page.content();
      // 只有不是 Not found 并且是正常的商品页面才验证
      const isNotInvalid = !html.includes('Product not found') &&
                           !html.includes('Invalid') &&
                           !html.includes('does not exist');

      // 对于基于 WHMCS PID 的盲扫，必须包含一些 VPS/服务器 相关的典型特征词才能算作潜在的 VPS 新品，
      // 否则可能会扫进几百个类似“虚拟主机”、“SSL证书”、“附加IP”等无关产品导致刷屏。
      const hasVpsKeywords = html.match(/KVM|VPS|RAM|GB|Ryzen|Intel|Core|Xeon|E5|VDS|Dedicated|Bandwidth|Transfer|Port|Network|Uplink/i) !== null;
      
      const containsOrderKeywords = html.includes('Order Summary') || html.includes('Configure') || 
                                    html.includes('Annually') || html.includes('Monthly') || 
                                    html.includes('Out of Stock') || html.includes('Add to Cart');

      const isValidProduct = isNotInvalid && hasVpsKeywords && containsOrderKeywords;

      // 额外检查：页面标题是否为 WHMCS 通用垃圾标题
      const pageTitle = await page.title().catch(() => '');
      const h1Text = await page.evaluate(() => {
        const h1 = document.querySelector('h1');
        return h1 ? h1.textContent.trim() : '';
      }).catch(() => '');
      const titleIsJunk = /^Shopping Cart/i.test(pageTitle) || /^Shopping Cart$/i.test(h1Text);

      if (isValidProduct && !titleIsJunk) {
        pids.add(String(pid));
        console.log(`[Discoverer]     ✅ PID=${pid} 存在且疑似 VPS！`);
      } else if (isValidProduct && titleIsJunk) {
        // 页面有VPS内容但标题是 "Shopping Cart" → 这是 WHMCS 通用购物车页面
        // 对于 BWH 这类不展示产品名的商家，仍然加入但后续 scrapeProductDetails 会尝试提取真名
        pids.add(String(pid));
        console.log(`[Discoverer]     ⚠️ PID=${pid} 疑似VPS但标题为"Shopping Cart"，将尝试深度提取`);
      } else if (isNotInvalid && containsOrderKeywords) {
        console.log(`[Discoverer]     ⏭️ PID=${pid} 存在，但未检测到VPS特征词，跳过以免误增无关商品`);
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
// 返回 [{ pid, provider, providerName, domain, contextName, contextPrice, promoCode }]
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
    'greencloudvps.com': { provider: 'greencloud', providerName: 'GreenCloud', domain: 'greencloudvps.com' },
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
      const html = await fetch(source.url, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' } }).then(r => r.text());
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
                /greencloud|racknerd|dmit|bandwagon|colocross|zgo/i.test(pathLower + ' ' + linkText) ||
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
            const aHtml = await fetch(articleUrl, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' } }).then(r => r.text());
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

  let totalNewCount = 0;
  const newsByProvider = {}; // { providerName: [pid] }

  const browser = await getBrowser();

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
      const candidateId = `${source.provider}-auto-${pid}`;
      const exists = catalogRef.some(c =>
        (c.provider === source.provider && c.checkUrl && c.checkUrl.includes(`pid=${pid}`)) ||
        c.id === candidateId ||
        c.id === `${source.provider}-specials-${pid}` ||
        c.id === `${source.provider}-${pid}`
      );

      // 黑名单检查：管理员删过的 PID 不再重新扫入
      if (exists || db.isIdPurged(candidateId)) {
        continue;
      }

        // 自动抓取产品页面获取真实名称和价格
        const productUrl = `https://${source.domain}/cart.php?a=add&pid=${pid}`;
        console.log(`[Discoverer]     📝 抓取产品详情: PID=${pid}`);
        const details = await scrapeProductDetails(browser, productUrl);
        await sleep(1500);

        // 统一垃圾页面检测：isInvalid 标记 + 名称关键词双重拦截
        if (details.isInvalid || (details.name && JUNK_NAME_RE.test(details.name))) {
           console.log(`[Discoverer]     🚫 拦截垃圾页面: ${details.name || '无标题'}`);
           if (!db.isIdPurged(candidateId)) {
             db.purgeProduct(candidateId);
           }
           continue;
        }

        // 没有名称也没有价格 = 页面加载失败（CF拦截等），跳过不入库
        if (!details.name && !details.price) {
          console.log(`[Discoverer]     ⏭️ PID=${pid} 无法获取名称和价格，跳过（不拉黑，下轮重试）`);
          continue;
        }

        const realName = details.name || `${source.providerName} 新品 (pid=${pid})`;
        const realPrice = details.price || '价格待确认';

        // 最终名称垃圾兜底
        if (JUNK_NAME_RE.test(realName)) {
          console.log(`[Discoverer]     🚫 拦截垃圾名称: ${realName}`);
          if (!db.isIdPurged(candidateId)) db.purgeProduct(candidateId);
          continue;
        }

        console.log(`[Discoverer]     → 名称: ${realName}, 价格: ${realPrice}`);

        const promoSuffix = details.promoCode ? `&promocode=${encodeURIComponent(details.promoCode)}` : '';
        const affUrl = source.provider === 'greencloud'
          ? `https://${source.domain}/billing/cart.php?a=add&pid=${pid}&${source.affParam}${promoSuffix}`
          : `https://${source.domain}/aff.php?${source.affParam}&pid=${pid}${promoSuffix}`;

        const newEntry = {
          id: `${source.provider}-auto-${pid}`,
          provider: source.provider,
          providerName: source.providerName,
          name: realName,
          price: realPrice,
          promoCode: details.promoCode || null,
          billingCycles: details.billingCycles || {},
          specs: { cpu: '待确认', ram: '待确认', disk: '待确认', bandwidth: '待确认' },
          datacenters: ['待确认'],
          networkRoutes: ['待确认'],
          outOfStockKeywords: source.outOfStockKeywords || ['Out of Stock', 'out of stock'],
          checkUrl: productUrl,
          affUrl,
          isSpecialOffer: true,
          source: 'discovered'
        };
        db.addProduct(newEntry);
        catalogRef.push(newEntry);
        totalNewCount++;
        if (!newsByProvider[source.providerName]) newsByProvider[source.providerName] = [];
        newsByProvider[source.providerName].push({ pid, name: realName, price: realPrice, autoLive: realPrice !== '价格待确认' });
        console.log(`[Discoverer]   🆕 新品: ${source.providerName} PID=${pid} → ${realName} ${realPrice}`);
    }
  }

  // ── 第二层：竞品库存站+测评站智能提取 ──
  console.log(`\n[Discoverer] 📡 辅助查漏补缺（竞品站+测评站 · 智能提取模式）`);
  const competitorPids = await extractFromCompetitorSites();
  let autoLiveCount = 0; // 直接上架数
  let pendingCount = 0;  // 待确认数

  for (const cp of competitorPids) {


    const buildWhmcsAffUrl = (domain, affParam, pid, promoCode) => {
      if (cp.provider === 'greencloud') {
        const promo = promoCode ? `&promocode=${encodeURIComponent(promoCode)}` : '';
        return `https://${domain}/billing/cart.php?a=add&pid=${pid}&${affParam}${promo}`;
      }
      return affParam
        ? `https://${domain}/aff.php?${affParam}&pid=${pid}${promoCode ? '&promocode=' + promoCode : ''}`
        : `https://${domain}/cart.php?a=add&pid=${pid}`;
    };

    // ── 通用 WHMCS 商家分支 ──
    const candidateId = `${cp.provider}-auto-${cp.pid}`;
    const exists = catalogRef.some(c =>
      (c.provider === cp.provider && c.checkUrl && c.checkUrl.includes(`pid=${cp.pid}`)) ||
      c.id === candidateId ||
      c.id === `${cp.provider}-specials-${cp.pid}` ||
      c.id === `${cp.provider}-${cp.pid}`
    );

    // 黑名单检查：管理员删过的 PID 不再重新扫入
    if (exists || db.isIdPurged(candidateId)) continue;

    {
      const src = SCAN_SOURCES.find(s => s.provider === cp.provider);
      const affParam = src ? src.affParam : '';

      // 先用上下文提取的信息；不够再用 puppeteer 抓详情页
      let realName = cp.contextName;
      let realPrice = cp.contextPrice;
      let promoCode = cp.promoCode;
      let scrapedDetails = null;

      // 上下文名称本身就是垃圾 → 直接拉黑
      if (realName && JUNK_NAME_RE.test(realName)) {
        console.log(`[Discoverer]     🚫 上下文名称是垃圾: ${realName}`);
        db.purgeProduct(candidateId);
        continue;
      }

      // 无论上下文是否有价格，强制进产品页面验证存活性并提取最新价格（核心：触发防重定向劫持护盾）
      const productUrl = `https://${cp.domain}/cart.php?a=add&pid=${cp.pid}`;
      console.log(`[Discoverer]     📝 强制进页面验证存活性: PID=${cp.pid}`);
      scrapedDetails = await scrapeProductDetails(browser, productUrl);
      await sleep(1500);

      if (scrapedDetails.isInvalid || (scrapedDetails.name && JUNK_NAME_RE.test(scrapedDetails.name))) {
         console.log(`[Discoverer]     🚫 拦截垃圾页面/已失效产品: ${scrapedDetails.name || '无标题'} (URL可能遭重定向)`);
         db.purgeProduct(candidateId);
         continue; // 彻底舍弃
      }

      // 优先采用从真实页面抓取出的名称和价格，如果抓取不到，才后备使用竞品站上下文中猜出的数据
      realName = scrapedDetails.name || realName;
      realPrice = scrapedDetails.price || realPrice;
      if (!promoCode && scrapedDetails.promoCode) promoCode = scrapedDetails.promoCode;

      realName = realName || `${cp.providerName} 新品 (pid=${cp.pid})`;
      realPrice = realPrice || '价格待确认';

      // 最终名称垃圾检查（即使来自上下文也要过滤）
      if (JUNK_NAME_RE.test(realName)) {
        console.log(`[Discoverer]     🚫 拦截垃圾名称: ${realName}`);
        db.purgeProduct(candidateId);
        continue;
      }

      const isAutoLive = realPrice !== '价格待确认';
      const realCycles = (scrapedDetails && scrapedDetails.billingCycles) ? scrapedDetails.billingCycles : {};

      const newEntry = {
        id: `${cp.provider}-auto-${cp.pid}`,
        provider: cp.provider,
        providerName: cp.providerName,
        name: realName,
        price: realPrice,
        promoCode: promoCode || null,
        billingCycles: realCycles,
        specs: { cpu: '待确认', ram: '待确认', disk: '待确认', bandwidth: '待确认' },
        datacenters: ['待确认'],
        networkRoutes: ['待确认'],
        outOfStockKeywords: ['Out of Stock', 'out of stock'],
        checkUrl: productUrl,
        affUrl: buildWhmcsAffUrl(cp.domain, affParam, cp.pid, promoCode),
        isSpecialOffer: true,
        source: 'discovered'
      };
      db.addProduct(newEntry);
      catalogRef.push(newEntry);
      totalNewCount++;
      if (isAutoLive) autoLiveCount++; else pendingCount++;
      if (!newsByProvider[cp.providerName]) newsByProvider[cp.providerName] = [];
      newsByProvider[cp.providerName].push({ pid: cp.pid, name: realName, price: realPrice, autoLive: isAutoLive });
      console.log(`[Discoverer]   🆕 ${isAutoLive ? '✅ 直接上架' : '⏳ 待确认'}: ${cp.providerName} PID=${cp.pid} → ${realName} ${realPrice}`);
    }
  }

  // ── 第三层：「待确认」自动重试补全 ──
  const pendingItems = catalogRef.filter(c =>
    (c.price === '价格待确认' || c.price === '待确认') && !c.isHidden
  );
  if (pendingItems.length > 0) {
    console.log(`\n[Discoverer] 🔄 自动重试补全 ${pendingItems.length} 个「待确认」产品`);
    let retryFixed = 0;
    const maxRetry = 60; // 提升了单次补全上限，以更快处理积压产品
    for (const item of pendingItems.slice(0, maxRetry)) {
      if (!item.checkUrl) continue;
      // locked 产品的静态字段受保护，跳过名称/价格覆盖（库存检测不受影响）
      if (db.isLocked(item.id)) {
        console.log(`[Discoverer]   🔒 ${item.id} 已锁定，跳过自动补全`);
        continue;
      }
      try {
        console.log(`[Discoverer]   🔁 重试: ${item.id}`);
        const details = await scrapeProductDetails(browser, item.checkUrl);
        // 垃圾页面 → purge 拉黑（不再仅隐藏，彻底阻止重新扫入）
        if (details.isInvalid || (details.name && JUNK_NAME_RE.test(details.name)) || !details.name) {
           db.purgeProduct(item.id);
           console.log(`[Discoverer]     🚫 垃圾/失效页面，已 purge 拉黑: ${details.name || '无标题'}`);
           continue;  // 从 pendingItems 循环中跳过
        } else if (details.price && details.price !== '价格待确认') {
          const updates = { price: details.price };
          item.price = details.price;
          if (details.name && (item.name.includes('新品') || item.name.includes('自动发现'))) {
            updates.name = details.name;
            item.name = details.name;
          }
          if (details.promoCode && !item.promoCode) {
            updates.promoCode = details.promoCode;
            item.promoCode = details.promoCode;
          }
          if (details.billingCycles && Object.keys(details.billingCycles).length > 0) {
            updates.billingCycles = details.billingCycles;
            item.billingCycles = details.billingCycles;
          }
          db.updateProduct(item.id, updates);
          retryFixed++;
          console.log(`[Discoverer]     ✅ 补全: ${item.name} → ${item.price}`);
        } else {
          console.log(`[Discoverer]     ❌ 仍无法获取价格`);
        }
        await sleep(2000);
      } catch (err) {
        console.log(`[Discoverer]     ⚠️ 重试失败: ${err.message}`);
      }
    }
    if (retryFixed > 0) {
      console.log(`[Discoverer] ✅ 本轮补全了 ${retryFixed}/${pendingItems.length} 个待确认产品`);
      totalNewCount += retryFixed;
    }
    if (pendingItems.length > maxRetry) {
      console.log(`[Discoverer] ⏭️ 剩余 ${pendingItems.length - maxRetry} 个待确认将在下轮重试`);
    }
  }

  // ── 热加载 + TG 通知（数据已实时写入 SQLite，不再需要写 catalog.json） ──
  if (totalNewCount > 0) {
    reloadCatalog();
    console.log(`\n[Discoverer] ✅ 本轮发现/补全 ${totalNewCount} 款产品，已写入 SQLite 并热加载`);

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
        msg += `\n`;
      }
      if (pendingCount > 0) msg += `⚠️ 待确认产品请到后台补全信息`;
      bot.sendMessage(adminChatId, msg, { parse_mode: 'HTML' })
        .catch(e => console.error('[Discoverer] TG 通知失败:', e.message));
    }
  } else {
    console.log(`\n[Discoverer] ✅ 扫描完成，未发现新品。当前共 ${catalogRef.length} 款`);
  }

  // 不关闭浏览器——与 scraper.js 共享同一 Chromium 实例，由 browser.js 统一管理
  return totalNewCount;
}

// ============================================================
// 启动定时引擎（集成到 scraper.js 的主循环中使用）
// ============================================================
export function startDiscoveryEngine(bot, adminChatId, catalogRef, reloadCatalog, intervalHours = 4, runFn = null) {
  // runFn 允许调用方传入带互斥锁包装的版本（如 tgBot.js 里的 guardedDiscovery）
  const doRun = runFn
    ? () => runFn(bot, adminChatId, catalogRef, reloadCatalog)
    : () => runDiscovery(bot, adminChatId, catalogRef, reloadCatalog);

  // 启动 60 秒后执行首次扫描（给 scraper 先加载完的时间）
  setTimeout(doRun, 60 * 1000);

  // 定时循环
  setInterval(doRun, intervalHours * 60 * 60 * 1000);

  console.log(`[Discoverer] 🚀 产品发现引擎已挂载，周期: 每 ${intervalHours} 小时`);
}
