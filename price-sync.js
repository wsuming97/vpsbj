/**
 * price-sync.js — 分商家价格同步（v3）
 *
 * 核心策略：
 *   - BWH：从 stock.bwh91.com 获取（绕开 CF 拦截）
 *   - DMIT：从 stock.dmitea.com 获取（绕开 CF 拦截）
 *   - 其他商家：直接 Puppeteer 抓取 WHMCS 页面
 *
 * 用法：
 *   node price-sync.js              # 同步所有产品
 *   node price-sync.js bandwagonhost
 *   node price-sync.js dmit
 *   node price-sync.js racknerd
 */

import db from './db.js';
import { getBrowser } from './browser.js';
import { fetchBwhData, fetchDmitData, extractPidFromUrl } from './competitor-scraper.js';

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function extractDomain(url) {
  try { return new URL(url).hostname; } catch { return ''; }
}

// ── WHMCS 价格解析（用于非 BWH/DMIT 商家的 Puppeteer 抓取） ──
const WHMCS_PRICE_EXTRACT_FN = `() => {
  const result = { price: null, billingCycles: null };
  const text = document.body?.innerText || '';
  const CYCLE_KEY_MAP = {
    'monthly': 'monthly', 'quarterly': 'quarterly',
    'semi-annually': 'semiAnnually', 'semi-annual': 'semiAnnually',
    'annually': 'annually', 'annual': 'annually',
    'biennially': 'biennially', 'trienn': 'triennially',
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
          // 取 WHMCS 默认选中项作为显示价格（不强制 annually）
          if (opt.selected || idx === select.selectedIndex) {
            defaultPrice = priceStr;
            const displayMap = { 'monthly':'月','quarterly':'季','semi-annually':'半年','annually':'年','biennially':'两年','triennially':'三年' };
            for (const [dk, dv] of Object.entries(displayMap)) {
              if (t.toLowerCase().includes(dk)) { defaultDisplay = dv; break; }
            }
          }
          break;
        }
      }
    });
    if (Object.keys(cycles).length > 0) {
      result.billingCycles = cycles;
      if (defaultPrice) {
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
    const isCF = bodyText.includes('Just a moment')
      || bodyText.includes('Checking your browser')
      || bodyText.includes('请稍候')
      || html.includes('cf-browser-verification')
      || html.includes('challenge-platform');
    if (!isCF && bodyText.length > 200) return true;
    if (!isCF && bodyText.length < 50) { await sleep(1000); continue; }
    try {
      const frames = page.frames();
      for (const frame of frames) {
        const checkbox = await frame.$('input[type="checkbox"]').catch(() => null);
        if (checkbox) { await checkbox.click().catch(() => {}); }
      }
    } catch {}
    await sleep(1500);
  }
  return false;
}

// ── Puppeteer 单个产品价格抓取（用于非 BWH/DMIT 商家） ──
async function scrapePriceViaPuppeteer(product) {
  const browser = await getBrowser();
  const page = await browser.newPage();

  try {
    await page.setViewport({ width: 1280, height: 720 });
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36');
    await page.goto(product.checkUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });

    const cfPassed = await waitForCF(page, 15000);
    if (!cfPassed) return null;

    await sleep(1500);
    await page.waitForSelector('select[name="billingcycle"]', { timeout: 5000 }).catch(() => {});

    const priceInfo = await page.evaluate(new Function('return (' + WHMCS_PRICE_EXTRACT_FN + ')()'));
    return priceInfo?.price ? priceInfo : null;
  } catch (e) {
    console.log(`   ⚠️  Puppeteer 错误: ${e.message.slice(0, 60)}`);
    return null;
  } finally {
    await page.close().catch(() => {});
  }
}

// ── DMIT 产品名匹配：防止 PID 被竞品站映射到不同产品 ──
// 提取关键词（机房+产品线）进行交叉验证
function dmitNameMatch(ourName, competitorName) {
  const normalize = s => s.toUpperCase().replace(/[^A-Z0-9]/g, ' ');
  const ours = normalize(ourName);
  const theirs = normalize(competitorName);

  // 提取机房关键词
  const dcKeywords = ['HKG', 'LAX', 'TYO', '香港', '洛杉矶', '日本', '东京'];
  // 提取产品线关键词
  const lineKeywords = ['PRO', 'EB', 'T1', 'SPRO', 'EYEBALL'];
  // 提取产品名称关键词
  const nameKeywords = ['WEE', 'TINY', 'MINI', 'MICRO', 'STARTER', 'CREATOR',
    'MALIBU', 'PALMSPRING', 'IRVINE', 'MONGKOK', 'TSUENWAN', 'VICTORIA',
    'LOKMACHAU', 'INTRO', 'CORONA', 'FONTANA', 'SHINAGAWA', 'NATHAN',
    'ECHO', 'GINZA', 'FIXED'];

  // 至少需要一个机房关键词匹配
  const ourDc = dcKeywords.find(k => ours.includes(k) || ours.includes(normalize(k)));
  const theirDc = dcKeywords.find(k => theirs.includes(k) || theirs.includes(normalize(k)));
  // 机房关键词中文映射
  const dcMap = { 'HKG': '香港', 'LAX': '洛杉矶', 'TYO': ['日本', '东京'] };

  let dcMatch = false;
  if (ourDc && theirDc) {
    dcMatch = ourDc === theirDc;
    if (!dcMatch) {
      // 检查中英文映射
      for (const [en, cn] of Object.entries(dcMap)) {
        const cnArr = Array.isArray(cn) ? cn : [cn];
        if ((ourDc === en && cnArr.includes(theirDc)) || (cnArr.includes(ourDc) && theirDc === en)) {
          dcMatch = true;
          break;
        }
      }
    }
  }

  // 至少需要一个产品名称关键词匹配
  const ourLine = lineKeywords.find(k => ours.includes(k));
  const theirLine = lineKeywords.find(k => theirs.includes(k));
  const lineMatch = ourLine && theirLine && ourLine === theirLine;

  // 名称关键词匹配（可选，增加置信度）
  const ourProdName = nameKeywords.find(k => ours.includes(k));
  const theirProdName = nameKeywords.find(k => theirs.includes(k));
  const nameMatch = ourProdName && theirProdName && ourProdName === theirProdName;

  // 如果双方都有机房关键词但不匹配 → 一定是不同产品
  if (ourDc && theirDc && !dcMatch) return false;

  // 机房+产品线都匹配 = 高置信度
  if (dcMatch && lineMatch) return true;
  // 产品名匹配（如 WEE, TINY）且至少一项其他匹配
  if (nameMatch && (dcMatch || lineMatch)) return true;

  return false;
}

// ══════════════════════════════════════════════════════
// 分商家同步策略
// ══════════════════════════════════════════════════════

/**
 * BWH 同步：从 stock.bwh91.com 批量获取
 */
async function syncBwh(products) {
  console.log(`\n${'═'.repeat(50)}`);
  console.log(`🌐 BWH 同步策略：stock.bwh91.com 竞品站`);
  console.log(`${'═'.repeat(50)}`);

  const competitorData = await fetchBwhData();
  if (competitorData.size === 0) {
    console.log('   ❌ 竞品站数据获取失败，跳过 BWH 同步');
    return { updated: 0, unchanged: 0, failed: products.length, report: [] };
  }

  let updated = 0, unchanged = 0, failed = 0;
  const report = [];

  for (const product of products) {
    const pid = extractPidFromUrl(product.checkUrl);
    console.log(`\n  [${product.name}] pid=${pid || 'N/A'}`);
    console.log(`   当前: ${product.price || '(空)'}`);

    if (!pid) {
      console.log('   ❌ 无法提取 PID，跳过');
      failed++;
      continue;
    }

    const data = competitorData.get(pid);
    if (!data) {
      console.log(`   ⚠️  竞品站无此 PID(${pid}) 数据，保留现有价格`);
      unchanged++;
      continue;
    }

    console.log(`   竞品站: ${data.price || '(无价格)'} | ${data.inStock ? '有货' : '缺货'}`);

    if (data.price && data.price !== product.price) {
      db.updateProduct(product.id, { price: data.price });
      db.recordPriceChange(product.id, product.price, data.price);
      console.log(`   ✅ ${product.price} → ${data.price}`);
      report.push({ id: product.id, name: product.name, old: product.price, new: data.price });
      updated++;
    } else {
      console.log(`   ✅ 价格正确，无需更新`);
      unchanged++;
    }
  }

  return { updated, unchanged, failed, report };
}

/**
 * DMIT 同步：从 stock.dmitea.com 批量获取
 */
async function syncDmit(products) {
  console.log(`\n${'═'.repeat(50)}`);
  console.log(`🌐 DMIT 同步策略：stock.dmitea.com 竞品站`);
  console.log(`${'═'.repeat(50)}`);

  const competitorData = await fetchDmitData();
  if (competitorData.size === 0) {
    console.log('   ❌ 竞品站数据获取失败，跳过 DMIT 同步');
    return { updated: 0, unchanged: 0, failed: products.length, report: [] };
  }

  let updated = 0, unchanged = 0, failed = 0;
  const report = [];

  for (const product of products) {
    const pid = extractPidFromUrl(product.checkUrl);
    console.log(`\n  [${product.name}] pid=${pid || 'N/A'}`);
    console.log(`   当前: ${product.price || '(空)'}`);

    if (!pid) {
      console.log('   ❌ 无法提取 PID，跳过');
      failed++;
      continue;
    }

    const data = competitorData.get(pid);
    if (!data) {
      console.log(`   ⚠️  竞品站无此 PID(${pid}) 数据，保留现有价格`);
      unchanged++;
      continue;
    }

    // 名称交叉验证：防止 PID 映射到不同产品
    const isNameMatch = dmitNameMatch(product.name, data.name);
    console.log(`   竞品站: ${data.name} ${data.price || '(无价格)'} | ${data.inStock ? '有货' : '缺货'} | 名称${isNameMatch ? '✓' : '✗'}`);

    if (!isNameMatch) {
      console.log(`   ⚠️  名称不匹配（我方: ${product.name} / 竞品: ${data.name}），跳过价格更新`);
      // 库存状态仍然可以参考（同一 PID 只要有货就是有货）
      unchanged++;
      continue;
    }

    if (data.price && data.price !== product.price) {
      db.updateProduct(product.id, { price: data.price });
      db.recordPriceChange(product.id, product.price, data.price);
      console.log(`   ✅ ${product.price} → ${data.price}`);
      report.push({ id: product.id, name: product.name, old: product.price, new: data.price });
      updated++;
    } else {
      console.log(`   ✅ 价格正确，无需更新`);
      unchanged++;
    }
  }

  return { updated, unchanged, failed, report };
}

/**
 * 通用商家同步：Puppeteer 直接抓取 WHMCS
 */
async function syncGeneric(provider, products) {
  console.log(`\n${'═'.repeat(50)}`);
  console.log(`🌐 ${provider} 同步策略：Puppeteer 直接抓取`);
  console.log(`${'═'.repeat(50)}`);

  let updated = 0, unchanged = 0, failed = 0;
  const report = [];

  for (let i = 0; i < products.length; i++) {
    const product = products[i];
    console.log(`\n  [${i + 1}/${products.length}] ${product.name}`);
    console.log(`   当前: ${product.price || '(空)'}`);

    // 域名限速
    if (i > 0) await sleep(3000 + Math.random() * 2000);

    const result = await scrapePriceViaPuppeteer(product);

    if (result?.price) {
      if (result.price !== product.price) {
        const updateData = { price: result.price };
        if (result.billingCycles && Object.keys(result.billingCycles).length > 0) {
          updateData.billingCycles = result.billingCycles;
        }
        db.updateProduct(product.id, updateData);
        db.recordPriceChange(product.id, product.price, result.price);
        console.log(`   ✅ ${product.price} → ${result.price}`);
        report.push({ id: product.id, name: product.name, old: product.price, new: result.price });
        updated++;
      } else {
        console.log(`   ✅ 价格正确，无需更新`);
        unchanged++;
      }
    } else {
      console.log(`   ❌ 抓取失败，保留现有价格`);
      failed++;
    }
  }

  return { updated, unchanged, failed, report };
}

// ── 主入口 ──
async function main() {
  const filterProvider = process.argv[2]?.toLowerCase();
  let products = db.getAllProducts().filter(p => !p.isHidden);

  if (filterProvider) {
    products = products.filter(p => p.provider === filterProvider);
    console.log(`🎯 只同步: ${filterProvider}（${products.length} 个产品）`);
  } else {
    console.log(`🚀 同步全部 ${products.length} 个产品价格`);
  }

  // 按商家分组
  const byProvider = {};
  products.forEach(p => {
    if (!byProvider[p.provider]) byProvider[p.provider] = [];
    byProvider[p.provider].push(p);
  });

  let totalUpdated = 0, totalUnchanged = 0, totalFailed = 0;
  const allReport = [];

  for (const [provider, providerProducts] of Object.entries(byProvider)) {
    let result;

    // 按商家选择不同的抓取策略
    switch (provider) {
      case 'bandwagonhost':
        result = await syncBwh(providerProducts);
        break;
      case 'dmit':
        result = await syncDmit(providerProducts);
        break;
      default:
        result = await syncGeneric(provider, providerProducts);
        break;
    }

    totalUpdated += result.updated;
    totalUnchanged += result.unchanged;
    totalFailed += result.failed;
    allReport.push(...result.report);
  }

  // 汇总报告
  const total = totalUpdated + totalUnchanged + totalFailed;
  console.log(`\n\n${'═'.repeat(50)}`);
  console.log(`📊 同步完成`);
  console.log(`   ✅ 更新: ${totalUpdated}  ⏭️ 未变: ${totalUnchanged}  ❌ 失败: ${totalFailed}`);
  console.log(`   成功率: ${total > 0 ? ((totalUpdated + totalUnchanged) / total * 100).toFixed(1) : 0}%`);

  if (allReport.length > 0) {
    console.log(`\n💰 价格变动明细:`);
    allReport.forEach(r => console.log(`   ${r.name}: ${r.old} → ${r.new}`));
  }

  if (totalFailed > 0) {
    console.log(`\n⚠️  ${totalFailed} 个产品价格未能验证，已保留现有价格`);
  }

  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
