/**
 * fix-prices.js — 综合价格修正（v2）
 *
 * 修正来源：
 *   1. price-sync.js 成功抓取的真实价格
 *   2. 搜索引擎核实的公开价格
 *   3. 格式统一（补齐小数位 $xx → $xx.00）
 *
 * 运行：node fix-prices.js
 */
import db from './db.js';

const corrections = [
  // ═══════════════════════════════════════════
  // BWH — 格式修正（补齐小数位）
  // ═══════════════════════════════════════════
  { id: 'bwh-dc39-sakurabox',    price: '$79.00/年' },
  { id: 'bwh-dc39-v1',           price: '$79.00/年' },
  { id: 'bwh-dc39-v2',           price: '$99.00/年' },

  // ═══════════════════════════════════════════
  // DMIT — price-sync 成功抓取的真实价格（来自官网 WHMCS）
  // ═══════════════════════════════════════════
  // TYO Pro 系列（price-sync Puppeteer 成功抓取，可信度高）
  { id: 'dmit-tyo-pro-tiny-new', price: '$21.90/月' },
  { id: 'dmit-tyo-pro-starter',  price: '$39.90/月' },
  { id: 'dmit-tyo-pro-mini',     price: '$79.90/月' },
  { id: 'dmit-tyo-pro-micro',    price: '$159.90/月' },
  // HKG Pro TINY 旧版（price-sync 确认）
  { id: 'dmit-hk-pro-tiny-old',  price: '$39.90/月' },
  // HKG EB WEEv2（price-sync 确认）
  { id: 'dmit-hk-eb-weev2',      price: '$16.90/月' },
  // HKG Pro TINY（price-sync 确认 $119.99/年 未变）
  // HKG T1 WEE（price-sync 确认 $36.90/年 未变）

  // ═══════════════════════════════════════════
  // DMIT — 格式统一（$xx.x → $xx.x0，$xxx → $xxx.00）
  // ═══════════════════════════════════════════
  { id: 'dmit-la-pro-wee',       price: '$39.90/月' },
  { id: 'dmit-la-pro-malibu',    price: '$49.90/月' },
  { id: 'dmit-la-pro-palmspring', price: '$100.00/月' },
  { id: 'dmit-la-pro-irvine',    price: '$159.00/月' },
  { id: 'dmit-hk-pro-mongkok',   price: '$149.00/月' },
  { id: 'dmit-hk-pro-tsuenwan',  price: '$259.00/月' },
  { id: 'dmit-hk-pro-victoria',  price: '$298.00/月' },
  { id: 'dmit-hk-pro-lokmachau', price: '$358.00/月' },
  { id: 'dmit-la-eb-intro',      price: '$29.90/月' },
  { id: 'dmit-la-eb-corona',     price: '$49.90/月' },
  { id: 'dmit-la-eb-fontana',    price: '$100.00/月' },
  { id: 'dmit-la-t1-wee',        price: '$36.90/年' },
  { id: 'dmit-hk-t1-wee',        price: '$36.90/年' },
  { id: 'dmit-tyo-t1-wee',       price: '$36.90/年' },
  { id: 'dmit-new-237',          price: '$9.90/月' },
  { id: 'dmit-new-245',          price: '$9.90/月' },
  { id: 'dmit-hk-pro-nathan',    price: '$178.80/年' },
  { id: 'dmit-tyo-eb-wee',       price: '$155.00/年' },
  { id: 'dmit-tyo-eb-ginza',     price: '$189.90/年' },
  { id: 'dmit-la-spro-fixed',    price: '$179.90/月' },

  // ═══════════════════════════════════════════
  // GreenCloud — 格式统一
  // ═══════════════════════════════════════════
  { id: 'gc-cn-tyo-mini',        price: '$25.00/月' },
  { id: 'gc-cn-tyo-1',           price: '$45.00/月' },
  { id: 'gc-cn-sg-mini',         price: '$25.00/月' },
  { id: 'gc-cn-sg-1',            price: '$45.00/月' },
  { id: 'gc-budget-jp-iij-2',    price: '$40.00/年' },
  { id: 'gc-budget-jp-sb-2',     price: '$40.00/年' },
  { id: 'gc-budget-sg-dc1-2',    price: '$35.00/年' },
  { id: 'gc-budget-hk-2',        price: '$35.00/年' },
];

let fixed = 0;
let skipped = 0;

for (const { id, price } of corrections) {
  const product = db.getProduct(id);
  if (!product) {
    console.log(`⚠️  [SKIP] ${id} — 产品不在数据库中`);
    skipped++;
    continue;
  }
  if (product.price === price) {
    console.log(`✅  [OK]   ${id} — 已正确: ${price}`);
    skipped++;
    continue;
  }
  const old = product.price;
  db.updateProduct(id, { price });
  console.log(`🔧 [FIX]  ${id}: "${old}" → "${price}"`);
  fixed++;
}

// 删除残留的 CloudCone（已停止监控）
const cc = db.getProduct('cc-la-sc2');
if (cc) {
  db.updateProduct('cc-la-sc2', { isHidden: true });
  console.log(`🗑️  [HIDE] cc-la-sc2 — CloudCone 已隐藏`);
}

console.log(`\n修正完成：${fixed} 个已修正，${skipped} 个跳过`);
process.exit(0);
