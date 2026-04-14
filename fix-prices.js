/**
 * fix-prices.js — 一次性修正服务器数据库里的错误价格
 * 这些价格是从本地正确的 catalog.json 迁移数据中提取的
 * 运行一次即可，不需要重复运行
 */
import db from './db.js';

const corrections = [
  // BWH — 服务器上因为旧 catalog.json 污染，多个套餐被写成了错误价格
  { id: 'bwh-dc9-special20g',    price: '$169.99/年' },
  { id: 'bwh-dc6-special40g',    price: '$299.99/年' },
  { id: 'bwh-hk-40g',            price: '$899.99/年' },
  { id: 'bwh-basic-20g',         price: '$169.99/年' },
  // DMIT 新品格式修正
  { id: 'dmit-new-237',          price: '$48.88/半年' },
  { id: 'dmit-new-245',          price: '$48.88/半年' },
  // DMIT 格式补齐（缺小数位）
  { id: 'dmit-tyo-eb-wee',       price: '$155.00/年' },
  { id: 'dmit-tyo-eb-ginza',     price: '$189.90/年' },
  { id: 'dmit-hk-pro-nathan',    price: '$178.80/年' },
  { id: 'dmit-hk-eb-weev2',      price: '$179.90/年' },
  // BWH 格式补齐
  { id: 'bwh-dc39-sakurabox',    price: '$79.00/年' },
  { id: 'bwh-dc39-v1',           price: '$79.00/年' },
  { id: 'bwh-dc39-v2',           price: '$99.00/年' },
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
    console.log(`✅  [OK]   ${id} — 价格已正确: ${price}`);
    skipped++;
    continue;
  }
  db.updateProduct(id, { price });
  console.log(`🔧 [FIX]  ${id}: "${product.price}" → "${price}"`);
  fixed++;
}

console.log(`\n修正完成：${fixed} 个已修正，${skipped} 个跳过`);
process.exit(0);
