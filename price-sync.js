/**
 * price-sync.js — 加强版价格同步（v2）
 *
 * 核心改进：
 *   - 同域名复用浏览器 Tab + Cookie（CF 验证只需过一次）
 *   - 增加 CF Challenge 自动等待（最长 15s）
 *   - 失败自动重试（最多 2 次）
 *   - 优先从 WHMCS 分组页批量提取所有产品价格
 *
 * 用法：
 *   node price-sync.js              # 同步所有产品
 *   node price-sync.js bandwagonhost
 *   node price-sync.js dmit
 *   node price-sync.js greencloud
 */

import db from './db.js';
import { getBrowser } from './browser.js';

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function extractPid(url) {
  const m = url.match(/[?&]pid=(\d+)/i);
  return m ? m[1] : null;
}

function extractDomain(url) {
  try { return new URL(url).hostname; } catch { return ''; }
}

// ── WHMCS 价格解析（在页面内执行） ──
const WHMCS_PRICE_EXTRACT_FN = `() => {
  const result = { price: null, billingCycles: null };
  const text = document.body?.innerText || '';
  const CYCLE_KEY_MAP = {
    'monthly': 'monthly', 'quarterly': 'quarterly',
    'semi-annually': 'semiAnnually', 'semi-annual': 'semiAnnually',
    'annually': 'annually', 'annual': 'annually',
    'biennially': 'biennially', 'trienn': 'triennially',
  };
  const CYCLE_DISPLAY = {
    'monthly': '月', 'quarterly': '季', 'semi-annually': '半年',
    'annually': '年', 'biennially': '两年', 'triennially': '三年',
  };

  // 优先级 1：WHMCS select 下拉框
  const select = document.querySelector('select[name="billingcycle"]');
  if (select && select.options.length > 0) {
    const cycles = {};
    let defaultPrice = null, defaultDisplay = null;
    Array.from(select.options).forEach((opt, idx) => {
      const t = opt.textContent.trim();
      const pm = t.match(/\\$(\\d+[.,]\\d{2})/);
      if (!pm) return;
      const priceStr = '$' + pm[1].replace(',', '.');
      for (const [key, cKey] of Object.entries(CYCLE_KEY_MAP)) {
        if (t.toLowerCase().includes(key)) {
          cycles[cKey] = priceStr;
          if (opt.selected || idx === select.selectedIndex) {
            defaultPrice = priceStr;
            for (const [dk, dv] of Object.entries(CYCLE_DISPLAY)) {
              if (t.toLowerCase().includes(dk)) { defaultDisplay = dv; break; }
            }
          }
          break;
        }
      }
    });
    if (Object.keys(cycles).length > 0) {
      result.billingCycles = cycles;
      // 选择最适合显示的周期：年 > 半年 > 季 > 月
      const preferred = ['annually', 'semiAnnually', 'quarterly', 'monthly'];
      for (const pKey of preferred) {
        if (cycles[pKey]) {
          const label = pKey === 'annually' ? '年' : pKey === 'semiAnnually' ? '半年'
            : pKey === 'quarterly' ? '季' : '月';
          result.price = cycles[pKey] + '/' + label;
          break;
        }
      }
      if (!result.price && defaultPrice) {
        result.price = defaultPrice + (defaultDisplay ? '/' + defaultDisplay : '');
      }
      return result;
    }
  }

  // 优先级 2：页面文本正则
  const patterns = [
    { re: /\\$(\\d+[.,]\\d{2})\\s*(?:USD)?\\s*\\/?\\s*Annually/i, p: '年' },
    { re: /\\$(\\d+[.,]\\d{2})\\s*(?:USD)?\\s*\\/?\\s*Semi-?Annually/i, p: '半年' },
    { re: /\\$(\\d+[.,]\\d{2})\\s*(?:USD)?\\s*\\/?\\s*Quarterly/i, p: '季' },
    { re: /\\$(\\d+[.,]\\d{2})\\s*\\/?\\s*yr/i, p: '年' },
    { re: /\\$(\\d+[.,]\\d{2})\\s*(?:USD)?\\s*\\/?\\s*Monthly/i, p: '月' },
    { re: /\\$(\\d+[.,]\\d{2})\\s*\\/?\\s*mo/i, p: '月' },
    { re: /Annually.{0,50}\\$(\\d+[.,]\\d{2})/i, p: '年' },
  ];
  for (const { re, p } of patterns) {
    const m = text.match(re);
    if (m) { result.price = '$' + m[1].replace(',', '.') + '/' + p; return result; }
  }
  return result;
}`;

// ── CF Challenge 等待 ──
async function waitForCF(page, maxWait = 15000) {
  const start = Date.now();
  while (Date.now() - start < maxWait) {
    const bodyText = await page.evaluate(() => document.body?.innerText?.trim() || '').catch(() => '');
    const html = await page.content().catch(() => '');
    
    // CF 特征检测
    const isCF = bodyText.includes('Just a moment') 
      || bodyText.includes('Checking your browser')
      || bodyText.includes('请稍候')
      || html.includes('cf-browser-verification')
      || html.includes('challenge-platform');
    
    if (!isCF && bodyText.length > 200) return true; // CF 已通过
    if (!isCF && bodyText.length < 50) {
      await sleep(1000); // 页面可能还在加载
      continue;
    }
    
    // 尝试点击 CF turnstile checkbox
    try {
      const frames = page.frames();
      for (const frame of frames) {
        const checkbox = await frame.$('input[type="checkbox"]').catch(() => null);
        if (checkbox) { await checkbox.click().catch(() => {}); }
      }
    } catch {}
    
    await sleep(1500);
  }
  return false; // 超时
}

// ── 同域名 Session 池（复用 page + cookie） ──
const domainPages = new Map(); // domain → { page, lastUsed }

async function getDomainPage(domain) {
  if (domainPages.has(domain)) {
    const entry = domainPages.get(domain);
    if (!entry.page.isClosed()) {
      entry.lastUsed = Date.now();
      return entry.page;
    }
  }
  const browser = await getBrowser();
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 720 });
  // 设置 UA
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36');
  domainPages.set(domain, { page, lastUsed: Date.now() });
  return page;
}

async function closeAllPages() {
  for (const [, entry] of domainPages) {
    try { if (!entry.page.isClosed()) await entry.page.close(); } catch {}
  }
  domainPages.clear();
}

// ── 单个产品价格抓取（复用 session） ──
async function scrapeProductPrice(product, retries = 2) {
  const domain = extractDomain(product.checkUrl);
  
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const page = await getDomainPage(domain);
      
      // 导航到产品页
      await page.goto(product.checkUrl, { 
        waitUntil: 'domcontentloaded', 
        timeout: 30000 
      });
      
      // 等待 CF Challenge（如果有）
      const cfPassed = await waitForCF(page, 15000);
      if (!cfPassed) {
        // CF 没过，关闭这个 page 重开（换 session）
        if (attempt < retries) {
          console.log(`   ⏱️  CF 超时，重试 ${attempt + 1}/${retries}...`);
          try { if (!page.isClosed()) await page.close(); } catch {}
          domainPages.delete(domain);
          await sleep(3000 + Math.random() * 2000); // 随机等待
          continue;
        }
        return null;
      }
      
      // 额外等待 JS 渲染
      await sleep(1500);
      
      // 等待 billingcycle select 出现（WHMCS 页面）
      await page.waitForSelector('select[name="billingcycle"]', { timeout: 5000 }).catch(() => {});
      
      // 提取价格
      const priceInfo = await page.evaluate(new Function('return (' + WHMCS_PRICE_EXTRACT_FN + ')()'));
      
      if (priceInfo?.price) {
        return priceInfo;
      }
      
      // select 没找到，尝试正则兜底
      if (attempt < retries) {
        console.log(`   🔄 未找到价格，重试 ${attempt + 1}/${retries}...`);
        await sleep(2000);
        continue;
      }
      
      return null;
    } catch (e) {
      if (attempt < retries) {
        console.log(`   ⚠️  错误: ${e.message.slice(0, 60)}，重试...`);
        try { 
          const p = domainPages.get(domain);
          if (p && !p.page.isClosed()) await p.page.close(); 
        } catch {}
        domainPages.delete(domain);
        await sleep(3000);
        continue;
      }
      return null;
    }
  }
  return null;
}

// ── 批量抓取：WHMCS 分组页 ──
async function scrapeGroupPage(domain, gid) {
  const groupUrl = `https://${domain}/cart.php?gid=${gid}`;
  console.log(`\n📦 尝试分组页: ${groupUrl}`);
  
  try {
    const page = await getDomainPage(domain);
    await page.goto(groupUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    
    const cfPassed = await waitForCF(page, 15000);
    if (!cfPassed) return {};
    
    await sleep(2000);
    
    // 从分组页提取所有产品的 pid → price 映射
    const pidPrices = await page.evaluate(() => {
      const result = {};
      // WHMCS 分组页通常有 "Order Now" 链接，里面含 pid
      const links = document.querySelectorAll('a[href*="pid="]');
      links.forEach(link => {
        const href = link.getAttribute('href') || '';
        const pidMatch = href.match(/pid=(\d+)/);
        if (!pidMatch) return;
        const pid = pidMatch[1];
        
        // 向上找最近的产品容器
        const container = link.closest('.product, .package, [class*="plan"], [class*="pricing"], .panel, .card, div');
        if (!container) return;
        
        const text = container.textContent;
        // 尝试匹配价格
        const patterns = [
          /\$(\d+[.,]\d{2})\s*(?:USD)?\s*\/?\s*(?:Annually|yr)/i,
          /\$(\d+[.,]\d{2})\s*(?:USD)?\s*\/?\s*(?:Semi-?Annually)/i,
          /\$(\d+[.,]\d{2})\s*(?:USD)?\s*\/?\s*(?:Quarterly)/i,
          /\$(\d+[.,]\d{2})\s*(?:USD)?\s*\/?\s*(?:Monthly|mo)/i,
        ];
        const labels = ['年', '半年', '季', '月'];
        
        for (let i = 0; i < patterns.length; i++) {
          const m = text.match(patterns[i]);
          if (m) {
            result[pid] = '$' + m[1].replace(',', '.') + '/' + labels[i];
            break;
          }
        }
      });
      return result;
    });
    
    const count = Object.keys(pidPrices).length;
    if (count > 0) {
      console.log(`   ✅ 分组页提取到 ${count} 个产品价格`);
    } else {
      console.log(`   ❌ 分组页未提取到价格`);
    }
    return pidPrices;
  } catch (e) {
    console.log(`   ❌ 分组页失败: ${e.message.slice(0, 60)}`);
    return {};
  }
}

// ── 主同步逻辑 ──
async function main() {
  const filterProvider = process.argv[2]?.toLowerCase();
  let products = db.getAllProducts().filter(p => !p.isHidden);
  if (filterProvider) {
    products = products.filter(p => p.provider === filterProvider);
    console.log(`🎯 只同步: ${filterProvider}（${products.length} 个产品）`);
  } else {
    console.log(`🚀 同步全部 ${products.length} 个产品价格`);
  }

  // 按域名分组
  const byDomain = {};
  products.forEach(p => {
    const domain = extractDomain(p.checkUrl);
    if (!byDomain[domain]) byDomain[domain] = [];
    byDomain[domain].push(p);
  });

  let updated = 0, unchanged = 0, failed = 0;
  const report = [];

  for (const [domain, domainProducts] of Object.entries(byDomain)) {
    console.log(`\n${'═'.repeat(50)}`);
    console.log(`🌐 域名: ${domain}（${domainProducts.length} 个产品）`);
    console.log(`${'═'.repeat(50)}`);

    // Step 1: 尝试从分组页批量获取（提取所有不同的 gid）
    const gids = new Set();
    domainProducts.forEach(p => {
      // 从 checkUrl 中推断 gid 不太可能，跳过分组页
      // 但可以从 cart.php?a=add&pid=XX 推断
    });

    // Step 2: 逐个产品爬取（复用同域名 session）
    for (let i = 0; i < domainProducts.length; i++) {
      const product = domainProducts[i];
      const pid = extractPid(product.checkUrl);
      
      console.log(`\n[${i + 1}/${domainProducts.length}] ${product.name} (pid=${pid || 'N/A'})`);
      console.log(`   当前: ${product.price || '(空)'}`);
      
      // 域名限速：同域名间隔 2-4 秒
      if (i > 0) await sleep(2000 + Math.random() * 2000);
      
      const result = await scrapeProductPrice(product);
      
      if (result?.price) {
        const oldPrice = product.price;
        if (result.price !== oldPrice) {
          const updateData = { price: result.price };
          if (result.billingCycles && Object.keys(result.billingCycles).length > 0) {
            updateData.billingCycles = result.billingCycles;
          }
          db.updateProduct(product.id, updateData);
          console.log(`   ✅ ${oldPrice} → ${result.price}`);
          report.push({ id: product.id, name: product.name, old: oldPrice, new: result.price });
          updated++;
        } else {
          console.log(`   ✅ 价格正确，无需更新`);
          unchanged++;
        }
      } else {
        console.log(`   ❌ 所有尝试失败，保留现有价格`);
        failed++;
      }
    }
    
    // 域名切换时关闭旧 page 释放资源
    const entry = domainPages.get(domain);
    if (entry && !entry.page.isClosed()) {
      await entry.page.close().catch(() => {});
    }
    domainPages.delete(domain);
  }

  // 清理
  await closeAllPages();

  // 汇总报告
  console.log(`\n\n${'═'.repeat(50)}`);
  console.log(`📊 同步完成`);
  console.log(`   ✅ 更新: ${updated}  ⏭️ 未变: ${unchanged}  ❌ 失败: ${failed}`);
  console.log(`   成功率: ${((updated + unchanged) / (updated + unchanged + failed) * 100).toFixed(1)}%`);
  
  if (report.length > 0) {
    console.log(`\n💰 价格变动明细:`);
    report.forEach(r => console.log(`   ${r.name}: ${r.old} → ${r.new}`));
  }
  
  if (failed > 0) {
    console.log(`\n⚠️  ${failed} 个产品价格未能验证，已保留现有价格`);
  }
  
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
