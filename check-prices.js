import db from './db.js';

const all = db.getAllProducts();
const visible = all.filter(p => p.isHidden !== 1 && p.isHidden !== true);
const stale = visible.filter(p => {
  if (!p.price) return true;
  if (p.price === '待确认' || p.price === '价格待确认') return true;
  if (!p.price.includes('$')) return true;
  return false;
});

console.log('总有效产品:', visible.length);
console.log('价格缺失/待确认:', stale.length);
if (stale.length > 0) {
  console.log('\n--- 问题产品 ---');
  stale.forEach(p => console.log(` - ${p.id} | ${p.provider} | "${p.price}"`));
}

console.log('\n--- 所有产品价格 ---');
visible.forEach(p => console.log(` ${p.provider.padEnd(16)} | ${(p.price || '(空)').padEnd(20)} | ${p.id}`));

process.exit(0);
