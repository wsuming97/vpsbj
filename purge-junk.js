/**
 * 批量清理数据库中的历史垃圾产品
 *
 * 运行方式（服务器容器内）：
 *   docker compose cp purge-junk.js vps-tracker:/app/purge-junk.js
 *   docker compose exec vps-tracker node /app/purge-junk.js
 *
 * 逻辑：
 *   1. 扫描所有产品
 *   2. 名称命中垃圾模式的 → purge（删除 + 拉黑）
 *   3. 价格仍为"待确认"且超过 7 天未更新的 → 隐藏
 *   4. 输出清理报告
 */
import db from './db.js';

const JUNK_PATTERNS = /Shopping Cart|Shared Hosting|404|Oops|there.*problem|Cloud Virtual Private|Web Hosting|Error|Page Not Found|cPanel|Reseller|Domain Reg|just a moment|checking your browser|cloudflare|stack error|encountered a problem/i;

const allProducts = db.getAllProducts();

let purgedCount = 0;
let hiddenCount = 0;
const purgedList = [];
const hiddenList = [];

for (const p of allProducts) {
  // 1. 名称命中垃圾模式 → purge
  if (JUNK_PATTERNS.test(p.name)) {
    db.purgeProduct(p.id);
    purgedCount++;
    purgedList.push(`  🗑 ${p.id} — "${p.name}"`);
    continue;
  }

  // 2. 价格仍为待确认且已隐藏跳过
  if (p.isHidden) continue;

  // 3. 价格待确认 + 来源是 discovered → 隐藏（不删除，可手动恢复）
  if ((p.price === '待确认' || p.price === '价格待确认') && p.source === 'discovered') {
    db.updateProduct(p.id, { isHidden: true });
    hiddenCount++;
    hiddenList.push(`  ⏸ ${p.id} — "${p.name}" (${p.price})`);
  }
}

console.log(`\n[Purge Junk] 清理完成`);
console.log(`  已永久删除+拉黑: ${purgedCount} 个`);
if (purgedList.length > 0) {
  console.log(purgedList.join('\n'));
}
console.log(`  已隐藏(待确认产品): ${hiddenCount} 个`);
if (hiddenList.length > 0) {
  console.log(hiddenList.join('\n'));
}
console.log(`  剩余有效产品: ${allProducts.length - purgedCount} 个`);
