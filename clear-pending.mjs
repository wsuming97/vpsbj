import db from './db.js';
import { runDiscovery } from './discovery.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function main() {
  console.log('开始强制清空待确认积压任务...');
  // 加载 catalog
  const catalog = JSON.parse(fs.readFileSync(path.join(__dirname, 'catalog.json'), 'utf8'));
  
  // 创建一个 fake bot
  const fakeBot = { sendMessage: (chatId, text) => console.log('[TG BOT]', text) };
  
  await runDiscovery(fakeBot, 'none', catalog, () => {
    fs.writeFileSync(path.join(__dirname, 'catalog.json'), JSON.stringify(catalog, null, 2));
    console.log('Catalog 已经热重载');
  });
  
  console.log('强制清理完成。');
  process.exit(0);
}

main();
