/**
 * seed.js — 从 seed-products.json 批量导入产品到 SQLite
 * 用法: node seed.js
 */
import fs from 'fs';
import db from './db.js';

const file = new URL('./seed-products.json', import.meta.url);
const products = JSON.parse(fs.readFileSync(file, 'utf8'));

let added = 0, skipped = 0;
for (const p of products) {
  if (db.productExists(p.id)) {
    skipped++;
    continue;
  }
  db.addProduct(p);
  added++;
}

console.log(`[Seed] 完成！新增 ${added} 条，跳过 ${skipped} 条已存在，总计 ${db.getAllProducts().length} 条`);
