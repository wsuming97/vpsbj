/**
 * seed.js — 从 seed-products.json 导入产品到 SQLite
 * 用法: node seed.js
 */
import db from './db.js';
import fs from 'fs';

const products = JSON.parse(fs.readFileSync('./seed-products.json', 'utf8'));
let added = 0, skipped = 0;

for (const p of products) {
  try {
    const exists = db.getAllProducts().find(e => e.id === p.id);
    if (exists) { skipped++; continue; }
    db.addProduct(p);
    added++;
  } catch (e) {
    console.log(`⚠️ 跳过 ${p.id}: ${e.message}`);
    skipped++;
  }
}

console.log(`✅ 导入完成: ${added} 新增, ${skipped} 跳过, 总计 ${db.getAllProducts().length} 个产品`);
process.exit(0);
