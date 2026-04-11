/**
 * scrape-all.mjs
 * 批量爬取各商家 VPS 套餐真实数据
 * 用 Puppeteer Stealth 穿透 Cloudflare / TLS 拦截
 */
import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import fs from 'fs';

puppeteer.use(StealthPlugin());

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ===== 推广 ID =====
const AFF = {
  bwh: 81381,
  dmit: 16687,
  rn: 19252,
  cc: 14121,
  colo: 1633,
  zgo: 1455,
};

// ===== 搬瓦工已知在售 PID 列表（来自社区和官方） =====
const BWH_PIDS = [
  // DC99 限量
  { pid: 145, note: 'DC99 V5 10G (CN2 GIA)' },
  { pid: 144, note: 'DC99 V5 10G 512MB (CN2 GIA)' },
  // DC6 CN2 GIA-E
  { pid: 87, note: 'DC9 Plan (CN2 GIA)' },
  { pid: 88, note: 'DC6 Plan V5 (CN2 GIA-E)' },
  // CN2 GIA-E 系列
  { pid: 95, note: 'CN2 GIA-E 20G' },
  { pid: 96, note: 'CN2 GIA-E 40G' },
  { pid: 97, note: 'CN2 GIA-E 80G' },
  { pid: 98, note: 'CN2 GIA-E 160G' },
  // BASIC / KVM
  { pid: 114, note: 'Basic-20G-KVM' },
  { pid: 130, note: 'Basic-40G-KVM (The Plan V3)' },
  { pid: 131, note: 'Basic-80G-KVM' },
  { pid: 132, note: 'Basic-160G-KVM' },
  // 限制类
  { pid: 151, note: 'DC99 MINIBOX Invite-only' },
  { pid: 94, note: 'THE PLAN (旧限量)' },
];

// ===== DMIT 已知产品组 =====
const DMIT_GIDS = [
  { gid: 9, label: 'LAX Premium (CN2 GIA)' },
  { gid: 18, label: 'LAX EB (9929+CMIN2)' },
  { gid: 16, label: 'LAX Tier1' },
  { gid: 11, label: 'HKG Premium' },
  { gid: 17, label: 'HKG Tier1' },
  { gid: 12, label: 'TYO Premium' },
  { gid: 20, label: 'TYO Tier1' },
];

let browser;

async function launch() {
  browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--ignore-certificate-errors'],
  });
}

// ============================
// 搬瓦工 (BandwagonHost)
// ============================
async function scrapeBWH() {
  console.log('\n===== 搬瓦工 BandwagonHost =====');
  const results = [];

  for (const { pid, note } of BWH_PIDS) {
    const page = await browser.newPage();
    try {
      const url = `https://bandwagonhost.com/cart.php?a=add&pid=${pid}`;
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 25000 });
      await sleep(4000);

      const html = await page.content();

      // Check out-of-stock
      const oos = html.toLowerCase().includes('out of stock');

      // Extract product name
      const nameMatch = html.match(/<strong>(VPS[^<]+)<\/strong>/i);
      const name = nameMatch ? nameMatch[1].trim() : note;

      // Extract price - look for "Annually" option
      const annualMatch = html.match(/\$([\d.]+)\s*USD\s*Annually/i);
      const monthlyMatch = html.match(/\$([\d.]+)\s*USD\s*Monthly/i);
      const quarterlyMatch = html.match(/\$([\d.]+)\s*USD\s*Quarterly/i);

      // Extract specs from the product description
      const ssdMatch = html.match(/SSD:\s*([\d]+)\s*GB/i);
      const ramMatch = html.match(/RAM:\s*([\d]+)\s*(MB|GB)/i);
      const cpuMatch = html.match(/CPU:\s*([\dx]+)\s*([^<\n]+)/i);
      const transferMatch = html.match(/Transfer:\s*([\d,]+)\s*GB/i);
      const linkMatch = html.match(/Link speed:\s*([\d.]+)\s*(Gigabit|Gbit)/i);
      const locationMatch = html.match(/Location:\s*([^<\n]+)/i);
      const inviteRequired = html.includes('Invite code required');

      let price = '未知';
      let period = '年';
      if (annualMatch) { price = `$${annualMatch[1]}`; period = '年'; }
      else if (quarterlyMatch) { price = `$${quarterlyMatch[1]}`; period = '季'; }
      else if (monthlyMatch) { price = `$${monthlyMatch[1]}`; period = '月'; }

      const product = {
        provider: 'bandwagonhost',
        pid,
        name,
        price: `${price}/${period}`,
        ram: ramMatch ? `${ramMatch[1]} ${ramMatch[2]}` : '?',
        disk: ssdMatch ? `${ssdMatch[1]} GB SSD` : '?',
        cpu: cpuMatch ? cpuMatch[1].replace('x', ' vCPU (') + (cpuMatch[2] ? cpuMatch[2].trim() + ')' : '') : '?',
        bandwidth: transferMatch ? `${transferMatch[1]} GB/mo` : '?',
        port: linkMatch ? `${linkMatch[1]} Gbps` : '?',
        location: locationMatch ? locationMatch[1].trim() : '?',
        inStock: !oos,
        inviteRequired,
        note,
      };
      results.push(product);
      console.log(`  [pid=${pid}] ${name} → ${price}/${period} ${oos ? '❌缺货' : '✅有货'} ${inviteRequired ? '🔑需邀请码' : ''}`);
    } catch (e) {
      console.log(`  [pid=${pid}] ERROR: ${e.message}`);
    } finally {
      await page.close();
    }
    await sleep(1500);
  }
  return results;
}

// ============================
// DMIT
// ============================
async function scrapeDMIT() {
  console.log('\n===== DMIT =====');
  const results = [];

  for (const { gid, label } of DMIT_GIDS) {
    const page = await browser.newPage();
    try {
      const url = `https://www.dmit.io/cart.php?gid=${gid}`;
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await sleep(8000);

      // Extract all product items from the listing page
      const products = await page.evaluate(() => {
        const items = [];
        // WHMCS product listing pages typically have product divs
        const productEls = document.querySelectorAll('.product, .product-group .product, [class*="product"]');
        productEls.forEach(el => {
          const nameEl = el.querySelector('h3, h4, .product-name, header, [class*="name"], [class*="title"]');
          const priceEl = el.querySelector('.price, [class*="price"], .product-price');
          const linkEl = el.querySelector('a[href*="pid="], a[href*="cart.php"]');

          // Try to get order link and extract pid
          let pid = null;
          let orderLink = '';
          if (linkEl) {
            orderLink = linkEl.href;
            const pidMatch = orderLink.match(/pid=(\d+)/);
            if (pidMatch) pid = parseInt(pidMatch[1]);
          }

          // Also search text for Out of Stock indicator
          const text = el.innerText || '';
          const oos = text.includes('Out of Stock') || text.includes('out of stock') || text.includes('Sold Out');

          items.push({
            name: nameEl ? nameEl.innerText.trim() : '',
            price: priceEl ? priceEl.innerText.trim() : '',
            pid,
            orderLink,
            inStock: !oos,
            fullText: text.substring(0, 500),
          });
        });
        return items;
      });

      // Also try the standard WHMCS product table format
      if (products.length === 0) {
        const altProducts = await page.evaluate(() => {
          const items = [];
          // Try table rows
          const rows = document.querySelectorAll('table tr, .product-item');
          rows.forEach(row => {
            const text = row.innerText || '';
            const link = row.querySelector('a[href*="pid="]');
            let pid = null;
            if (link) {
              const m = link.href.match(/pid=(\d+)/);
              if (m) pid = parseInt(m[1]);
            }
            if (pid || text.includes('$')) {
              items.push({ name: text.substring(0, 200), pid, fullText: text.substring(0, 500) });
            }
          });
          return items;
        });
        products.push(...altProducts);
      }

      console.log(`  [gid=${gid}] ${label}: found ${products.length} products`);
      products.forEach(p => {
        p.groupLabel = label;
        p.gid = gid;
        results.push(p);
        console.log(`    → ${p.name || '(no name)'} | pid=${p.pid} | ${p.price || '?'} | ${p.inStock === false ? '❌' : '✅'}`);
      });
    } catch (e) {
      console.log(`  [gid=${gid}] ERROR: ${e.message}`);
    } finally {
      await page.close();
    }
    await sleep(2000);
  }
  return results;
}

// ============================
// RackNerd - 已知特惠 PID 列表
// ============================
async function scrapeRackNerd() {
  console.log('\n===== RackNerd =====');
  const results = [];

  // 已知热门特惠 pid (来自社区整理)
  const RN_PIDS = [
    { pid: 838, note: '1GB KVM (2025 New Year)' },
    { pid: 839, note: '2GB KVM (2025 New Year)' },
    { pid: 840, note: '2.5GB KVM (2025 New Year)' },
    { pid: 841, note: '4GB KVM (2025 New Year)' },
    { pid: 830, note: '1GB KVM VPS (2024 New Year)' },
    { pid: 831, note: '2GB KVM VPS (2024 New Year)' },
    { pid: 832, note: '2.5GB KVM VPS (2024 New Year)' },
    { pid: 833, note: '4GB KVM VPS (2024 New Year)' },
    { pid: 792, note: '768MB KVM (Black Friday 2023)' },
    { pid: 793, note: '2GB KVM (Black Friday 2023)' },
    { pid: 794, note: '2.5GB KVM (Black Friday 2023)' },
  ];

  for (const { pid, note } of RN_PIDS) {
    const page = await browser.newPage();
    try {
      const url = `https://my.racknerd.com/cart.php?a=add&pid=${pid}`;
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
      await sleep(3000);
      const html = await page.content();

      const oos = html.toLowerCase().includes('out of stock');
      const nameMatch = html.match(/<strong>([^<]+)<\/strong>/);
      const annualMatch = html.match(/\$([\d.]+)\s*USD\s*Annually/i);
      const ssdMatch = html.match(/Pure SSD.*?(\d+)\s*GB/i) || html.match(/SSD.*?(\d+)\s*GB/i) || html.match(/(\d+)\s*GB.*?SSD/i);
      const ramMatch = html.match(/(\d+(?:\.\d+)?)\s*GB\s*(?:DDR4\s*)?RAM/i) || html.match(/RAM.*?(\d+)\s*(MB|GB)/i);
      const cpuMatch = html.match(/(\d+)\s*(?:vCPU|Core)/i);
      const bwMatch = html.match(/([\d.]+)\s*TB.*?Bandwidth/i) || html.match(/Transfer.*?([\d.]+)\s*TB/i);
      const portMatch = html.match(/([\d.]+)\s*Gbps/i);
      const locMatch = html.match(/Location.*?:?\s*([^<\n]+)/i);

      const price = annualMatch ? `$${annualMatch[1]}/年` : '?';
      const product = {
        provider: 'racknerd',
        pid,
        name: nameMatch ? nameMatch[1].trim() : note,
        price,
        ram: ramMatch ? `${ramMatch[1]} ${ramMatch[2] || 'GB'}` : '?',
        disk: ssdMatch ? `${ssdMatch[1]} GB SSD` : '?',
        cpu: cpuMatch ? `${cpuMatch[1]} vCPU` : '?',
        bandwidth: bwMatch ? `${bwMatch[1]} TB/mo` : '?',
        port: portMatch ? `${portMatch[1]} Gbps` : '?',
        location: locMatch ? locMatch[1].trim() : '?',
        inStock: !oos,
        note,
      };
      results.push(product);
      console.log(`  [pid=${pid}] ${product.name} → ${price} ${oos ? '❌' : '✅'}`);
    } catch (e) {
      console.log(`  [pid=${pid}] ERROR: ${e.message}`);
    } finally {
      await page.close();
    }
    await sleep(1500);
  }
  return results;
}

// ============================
// CloudCone
// ============================
async function scrapeCloudCone() {
  console.log('\n===== CloudCone =====');
  const results = [];
  const page = await browser.newPage();
  try {
    // CloudCone Flash Sale page
    await page.goto('https://app.cloudcone.com/compute/flashsale', { waitUntil: 'domcontentloaded', timeout: 20000 });
    await sleep(5000);

    const products = await page.evaluate(() => {
      const items = [];
      const cards = document.querySelectorAll('.plan-card, .product-card, [class*="plan"], [class*="card"]');
      cards.forEach(card => {
        const text = card.innerText || '';
        items.push({ fullText: text.substring(0, 600) });
      });
      // If no structured cards found, just get all text
      if (items.length === 0) {
        items.push({ fullText: document.body?.innerText?.substring(0, 3000) || '' });
      }
      return items;
    });
    console.log(`  Found ${products.length} items on FlashSale page`);
    products.forEach((p, i) => {
      console.log(`  [${i}] ${p.fullText.substring(0, 200)}`);
      results.push({ ...p, provider: 'cloudcone' });
    });
  } catch (e) {
    console.log(`  ERROR: ${e.message}`);
  } finally {
    await page.close();
  }
  return results;
}

// ============================
// ZGO Cloud (ZGOCLOUD)
// ============================
async function scrapeZGO() {
  console.log('\n===== ZGO Cloud =====');
  const results = [];

  const ZGO_GIDS = [
    { gid: 1, label: 'LA International' },
    { gid: 7, label: 'LA China Optimized' },
    { gid: 14, label: 'HK' },
    { gid: 15, label: 'JP' },
  ];

  for (const { gid, label } of ZGO_GIDS) {
    const page = await browser.newPage();
    try {
      const url = `https://clients.zgovps.com/cart.php?gid=${gid}`;
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 25000 });
      await sleep(6000);

      const products = await page.evaluate(() => {
        const items = [];
        // WHMCS layout
        const els = document.querySelectorAll('.product, .product-group .product, [class*="pricing"]');
        els.forEach(el => {
          const nameEl = el.querySelector('h3, h4, .product-name, header, [class*="name"], [class*="title"]');
          const priceEl = el.querySelector('.price, [class*="price"]');
          const linkEl = el.querySelector('a[href*="pid="]');
          let pid = null;
          if (linkEl) {
            const m = linkEl.href.match(/pid=(\d+)/);
            if (m) pid = parseInt(m[1]);
          }
          const text = el.innerText || '';
          const oos = text.includes('Out of Stock') || text.includes('缺货');
          items.push({
            name: nameEl ? nameEl.innerText.trim() : '',
            price: priceEl ? priceEl.innerText.trim() : '',
            pid,
            inStock: !oos,
            fullText: text.substring(0, 500),
          });
        });
        if (items.length === 0) {
          items.push({ fullText: document.body?.innerText?.substring(0, 3000) || '' });
        }
        return items;
      });

      console.log(`  [gid=${gid}] ${label}: found ${products.length} products`);
      products.forEach(p => {
        p.groupLabel = label;
        p.gid = gid;
        p.provider = 'zgocloud';
        results.push(p);
        console.log(`    → ${p.name || '(no name)'} | pid=${p.pid || '?'} | ${p.price || '?'} | ${p.inStock === false ? '❌' : '✅'}`);
      });
    } catch (e) {
      console.log(`  [gid=${gid}] ERROR: ${e.message}`);
    } finally {
      await page.close();
    }
    await sleep(2000);
  }
  return results;
}

// ============================
// ColoCrossing
// ============================
async function scrapeColoCrossing() {
  console.log('\n===== ColoCrossing =====');
  const results = [];
  const page = await browser.newPage();
  try {
    await page.goto('https://cloud.colocrossing.com/cloud-vps/', { waitUntil: 'domcontentloaded', timeout: 20000 });
    await sleep(5000);

    const products = await page.evaluate(() => {
      const items = [];
      const els = document.querySelectorAll('.product, .pricing-table, [class*="plan"], [class*="pricing"]');
      els.forEach(el => {
        const text = el.innerText || '';
        const linkEl = el.querySelector('a[href*="pid="]');
        let pid = null;
        if (linkEl) {
          const m = linkEl.href.match(/pid=(\d+)/);
          if (m) pid = parseInt(m[1]);
        }
        items.push({
          fullText: text.substring(0, 500),
          pid,
          provider: 'colocrossing',
        });
      });
      if (items.length === 0) {
        items.push({ fullText: document.body?.innerText?.substring(0, 3000) || '', provider: 'colocrossing' });
      }
      return items;
    });
    console.log(`  Found ${products.length} items`);
    products.forEach((p, i) => {
      console.log(`  [${i}] pid=${p.pid || '?'} | ${p.fullText.substring(0, 200)}`);
      results.push(p);
    });
  } catch (e) {
    console.log(`  ERROR: ${e.message}`);
  } finally {
    await page.close();
  }
  return results;
}

// ============================
// Main
// ============================
async function main() {
  console.log('🚀 开始批量爬取各商家 VPS 数据...\n');
  await launch();

  const bwhData = await scrapeBWH();
  const dmitData = await scrapeDMIT();
  const rnData = await scrapeRackNerd();
  const ccData = await scrapeCloudCone();
  const zgoData = await scrapeZGO();
  const coloData = await scrapeColoCrossing();

  // Save raw data for analysis
  const rawData = {
    timestamp: new Date().toISOString(),
    bandwagonhost: bwhData,
    dmit: dmitData,
    racknerd: rnData,
    cloudcone: ccData,
    zgocloud: zgoData,
    colocrossing: coloData,
  };

  fs.writeFileSync('scraped-raw.json', JSON.stringify(rawData, null, 2), 'utf8');
  console.log('\n✅ 原始数据已保存到 scraped-raw.json');

  await browser.close();
}

main().catch(e => {
  console.error('Fatal error:', e);
  process.exit(1);
});
