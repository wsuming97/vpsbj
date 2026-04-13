import db from './db.js';
import { runDiscovery } from './discovery.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function main() {
  console.log('开始强制清空待确认积压任务...');
  // 加载 catalog
  console.log('开始检测数据库异常积压...');
  const catalog = JSON.parse(fs.readFileSync(path.join(__dirname, 'catalog.json'), 'utf8'));
  
  // 查找并剔除 RackNerd 盲猜扫进去的废品（名字带自动发现 或 pid >= 1100）
  const initialLength = catalog.length;
  const filteredCatalog = catalog.filter(c => {
    if (c.provider === 'racknerd' && c.name.includes('自动发现') && (c.price === '待确认' || c.price === '价格待确认')) {
      const match = c.id.match(/pid=(\d+)/) || c.id.match(/-(\d+)$/);
      if (match && parseInt(match[1]) > 900) {
        // 其实直接从 sqlite 也要删
        db.deleteProduct(c.id);
        console.log(`🗑️ 删除垃圾探测产物: ${c.id}`);
        return false;
      }
    }
    return true;
  });

  if (filteredCatalog.length !== initialLength) {
    fs.writeFileSync(path.join(__dirname, 'catalog.json'), JSON.stringify(filteredCatalog, null, 2));
    console.log(`✅ 已从系统彻底清理 ${initialLength - filteredCatalog.length} 个非VPS的盲扫垃圾`);
  } else {
    // 没清理东西的话就调起以前的正常尝试逻辑
    const fakeBot = { sendMessage: (chatId, text) => console.log('[TG BOT]', text) };
    await runDiscovery(fakeBot, 'none', catalog, () => {
      fs.writeFileSync(path.join(__dirname, 'catalog.json'), JSON.stringify(catalog, null, 2));
    });
  }
  
  console.log('强制清理完成。');
  process.exit(0);
}

main();
