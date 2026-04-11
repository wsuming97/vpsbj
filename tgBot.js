import TelegramBot from 'node-telegram-bot-api';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import eventBus from './eventBus.js';
import { startDiscoveryEngine, runDiscovery } from './discovery.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export function initBot() {
  const token = process.env.TG_BOT_TOKEN;
  const channelId = process.env.TG_CHANNEL_ID || '@dmvpsjk';

  if (!token || token === 'YOUR_BOT_TOKEN_HERE') {
    console.warn('⚠️ 未配置有效的 TG_BOT_TOKEN，Telegram Bot 将不会启动。');
    return;
  }

  // 动态导入 scraper，避免循环依赖
  import('./scraper.js').then(m => {
    const catalog = m.catalog;
    const stockState = m.stockState;
    const reloadCatalog = m.reloadCatalog;

    let bot = new TelegramBot(token, { polling: true });
    console.log('🤖 Telegram Bot 控制台已启动，通知将发往频道:', channelId);

    // Verify Admin Middleware
    const requireAdmin = (msg) => {
      if (msg.chat.type !== 'private') return false;
      const adminId = process.env.TG_ADMIN_ID;
      // 兼容占位符未修改的情况，如果是真正的 adminId 才验证
      if (adminId && adminId !== 'YOUR_ADMIN_ID_HERE' && msg.chat.id.toString() !== adminId) {
        bot.sendMessage(msg.chat.id, '❌ 未经授权的访问。');
        return false;
      }
      return true;
    };

    // /start command
    bot.onText(/^\/start$/, (msg) => {
      if (!requireAdmin(msg)) return;
      bot.sendMessage(msg.chat.id,
        '🚀 **VPS 监控遥控器已就绪**\n\n' +
        '可用指令：\n' +
        '👉 /list - 查看所有监控产品\n' +
        '👉 /off <id> - 将指定产品下架(隐藏)\n' +
        '👉 /on <id> - 将指定产品上架(恢复监控)\n' +
        '👉 /add <链接> [名称] - 快捷添加新品监控\n' +
        '👉 /discover - 立即全网扫描挖掘潜在新品\n' +
        '👉 /status - 查看系统运行状态\n\n' +
        '💡 示例：\n' +
        '`/add https://www.dmit.io/cart.php?a=add&pid=999 DMIT新品`',
        { parse_mode: 'Markdown' }
      );
    });

    // /list command — 分页发送，避免超过 Telegram 4096 字符限制
    bot.onText(/^\/list$/, async (msg) => {
      if (!requireAdmin(msg)) return;

      const header = '📋 **当前监控清单：**\n\n';
      const chunks = [];
      let current = header;

      catalog.forEach(p => {
        const statusIcon = p.isHidden ? '❌ 下架' : '✅ 监控中';
        const entry = `ID: \`${p.id}\`\n名称: ${p.name}\n状态: ${statusIcon}\n\n`;

        // Telegram 单条消息限制 4096 字符，留 100 余量
        if (current.length + entry.length > 3900) {
          chunks.push(current);
          current = '';
        }
        current += entry;
      });
      if (current) chunks.push(current);

      for (let i = 0; i < chunks.length; i++) {
        const pageLabel = chunks.length > 1 ? `\n— 第 ${i + 1}/${chunks.length} 页 —` : '';
        await bot.sendMessage(msg.chat.id, chunks[i] + pageLabel, { parse_mode: 'Markdown' });
      }
    });

    // /off <id> command
    bot.onText(/^\/off (.+)/, (msg, match) => {
      if (!requireAdmin(msg)) return;

      const id = match[1].trim();
      const productIndex = catalog.findIndex(p => p.id === id);

      if (productIndex === -1) {
        return bot.sendMessage(msg.chat.id, `⚠️ 找不到 ID 为 \`${id}\` 的产品。\n提示：请使用 /list 查看确切的 ID。`, { parse_mode: 'Markdown' });
      }

      catalog[productIndex].isHidden = true;
      fs.writeFileSync(path.join(__dirname, 'catalog.json'), JSON.stringify(catalog, null, 2));
      reloadCatalog();

      bot.sendMessage(msg.chat.id, `✅ 成功下架产品！\n*${catalog[productIndex].name}* 已从网页前端隐藏，爬虫也已停止对此产品的监控。`, { parse_mode: 'Markdown' });
    });

    // /on <id> command
    bot.onText(/^\/on (.+)/, (msg, match) => {
      if (!requireAdmin(msg)) return;

      const id = match[1].trim();
      const productIndex = catalog.findIndex(p => p.id === id);

      if (productIndex === -1) {
        return bot.sendMessage(msg.chat.id, `⚠️ 找不到 ID 为 \`${id}\` 的产品。\n提示：请使用 /list 查看确切的 ID。`, { parse_mode: 'Markdown' });
      }

      catalog[productIndex].isHidden = false;
      fs.writeFileSync(path.join(__dirname, 'catalog.json'), JSON.stringify(catalog, null, 2));
      reloadCatalog();

      bot.sendMessage(msg.chat.id, `✅ 成功上架产品！\n*${catalog[productIndex].name}* 已恢复在网页前端的显示，爬虫正在努力监测中。`, { parse_mode: 'Markdown' });
    });

    // /status command
    bot.onText(/^\/status$/, (msg) => {
      if (!requireAdmin(msg)) return;

      const count = catalog.filter(p => !p.isHidden).length;
      const cacheSize = Object.keys(stockState).length;

      bot.sendMessage(msg.chat.id,
        `📊 **系统状态图**\n\n` +
        `运行时间： ${(process.uptime() / 60 / 60).toFixed(2)} 小时\n` +
        `监控任务数： ${count}/${catalog.length}\n` +
        `抓取引擎状态： 正常运行中 ✅`,
        { parse_mode: 'Markdown' }
      );
    });

    // ============================================================
    // /add <url> [名称] — 快捷添加新产品监控
    // ============================================================
    const providerMap = {
      'bandwagonhost.com': { provider: 'bandwagonhost', providerName: '搬瓦工', affBase: 'https://bandwagonhost.com/aff.php?aff=81381&pid=' },
      'bwh81.net': { provider: 'bandwagonhost', providerName: '搬瓦工', affBase: 'https://bandwagonhost.com/aff.php?aff=81381&pid=' },
      'bwh91.com': { provider: 'bandwagonhost', providerName: '搬瓦工', affBase: 'https://bandwagonhost.com/aff.php?aff=81381&pid=' },
      'dmit.io': { provider: 'dmit', providerName: 'DMIT', affBase: 'https://www.dmit.io/aff.php?aff=16687&pid=' },
      'dmitea.com': { provider: 'dmit', providerName: 'DMIT', affBase: 'https://www.dmit.io/aff.php?aff=16687&pid=' },
      'racknerd.com': { provider: 'racknerd', providerName: 'RackNerd', affBase: 'https://my.racknerd.com/aff.php?aff=19252&pid=' },
      'my.racknerd.com': { provider: 'racknerd', providerName: 'RackNerd', affBase: 'https://my.racknerd.com/aff.php?aff=19252&pid=' },
      'zgovps.com': { provider: 'zgocloud', providerName: 'ZGO Cloud', affBase: null },
      'cloudcone.com': { provider: 'cloudcone', providerName: 'CloudCone', affBase: null },
      'colocrossing.com': { provider: 'colocrossing', providerName: 'ColoCrossing', affBase: null },
    };

    bot.onText(/^\/add (.+)/, async (msg, match) => {
      if (!requireAdmin(msg)) return;

      const args = match[1].trim().split(/\s+/);
      const url = args[0];
      const customName = args.slice(1).join(' ') || null;

      // 识别商家
      let matched = null;
      let domain = '';
      try {
        const parsed = new URL(url);
        domain = parsed.hostname.replace('www.', '');
        for (const [key, val] of Object.entries(providerMap)) {
          if (domain.includes(key.replace('www.', ''))) {
            matched = val;
            break;
          }
        }
      } catch {
        return bot.sendMessage(msg.chat.id, '❌ 无法解析的URL，请粘贴完整的购买/分类链接。');
      }

      if (!matched) {
        matched = { provider: 'unknown', providerName: '未知商家', affBase: null };
      }

      bot.sendMessage(msg.chat.id, '⏳ 正在解析该页面，智能提取聚合页中的所有商品...');

      let pids = new Set();
      const urlPidMatch = url.match(/pid=(\d+)/);
      if (urlPidMatch) pids.add(urlPidMatch[1]);

      try {
        const cloudscraper = (await import('cloudscraper')).default;
        const html = await cloudscraper.get(url);
        let m;
        const pidRegex = /pid=(\d+)/gi;
        while ((m = pidRegex.exec(html)) !== null) pids.add(m[1]);

        const inputRegex = /<input[^>]*name=["']id["'][^>]*value=["'](\d+)["']/gi;
        while ((m = inputRegex.exec(html)) !== null) pids.add(m[1]);

        const ccRegex = /(?:cloudcone\.com(?:\.cn)?\/(?:vps|compute)\/(\d+)\/create)/gi;
        while ((m = ccRegex.exec(html)) !== null) {
          pids.add(m[1]);
          matched = { provider: 'cloudcone', providerName: 'CloudCone', affBase: null };
        }
      } catch (err) {
        console.log('[tgBot /add] 智能提取页面失败 (可能触发CF拦截):', err.message);
      }

      if (pids.size === 0) {
        return bot.sendMessage(msg.chat.id, `⚠️ 无法从该链接识别出任何产品 PID！`);
      }

      let addedCount = 0;
      for (const pid of pids) {
        const id = `${matched.provider}-auto-${pid}`;
        let exists = catalog.find(p => p.id === id || (p.checkUrl && p.checkUrl.includes(`pid=${pid}`)));
        if (exists) continue;

        let affUrl = url;
        if (matched.affBase) affUrl = matched.affBase + pid;
        let checkUrl = (url.includes('pid=') || !matched.affBase) ? url : `https://${domain}/cart.php?a=add&pid=${pid}`;

        catalog.push({
          id,
          provider: matched.provider,
          providerName: matched.providerName,
          name: `${customName || matched.providerName + ' 活动机'} (pid=${pid})`,
          price: '待确认',
          specs: { cpu: '待确认', ram: '待确认', disk: '待确认', bandwidth: '待确认' },
          datacenters: ['待确认'],
          networkRoutes: ['待确认'],
          outOfStockKeywords: ['Out of Stock', 'out of stock'],
          checkUrl,
          affUrl,
          isSpecialOffer: true
        });
        addedCount++;
      }

      if (addedCount > 0) {
        fs.writeFileSync(path.join(__dirname, 'catalog.json'), JSON.stringify(catalog, null, 2));
        reloadCatalog();
        bot.sendMessage(msg.chat.id,
          `✅ 页面提取成功！已批量上架 **${addedCount}** 款新机器并在后台开启监控！\n` +
          `识别到的 PID: ${Array.from(pids).join(', ')}\n\n` +
          `如需修改详细名称/价格，请登录网页后台编辑。`,
          { parse_mode: 'Markdown' }
        );
      } else {
        bot.sendMessage(msg.chat.id, `⚠️ 提取到了 ${pids.size} 个机器联动项，但它们已全在你的监控库中，无需重复录入。`);
      }
    });

    // /discover 手动触发一次全量扫描
    bot.onText(/^\/discover/, async (msg) => {
      if (!requireAdmin(msg)) return;
      bot.sendMessage(msg.chat.id, '🔍 收到指令，正在启动产品发现引擎（需 Puppeteer 逐页扫描，预计 3-5 分钟）...');
      const count = await runDiscovery(bot, msg.chat.id, catalog, reloadCatalog);
      if (count === 0) bot.sendMessage(msg.chat.id, '✅ 扫描完毕，所有商家官方页面及竞品站均未发现新品。');
    });

    // 启动后台自动发现引擎（每 4 小时自动跑一轮）
    const adminId = process.env.TG_ADMIN_ID || null;
    startDiscoveryEngine(bot, adminId, catalog, reloadCatalog, 4);

    // 订阅 EventBus 的补货通知
    eventBus.on('restock', (products) => {
      notifyStockChange(products, token, channelId, bot);
    });

  }).catch(err => {
    console.error('⚠️ 初始化 Bot 时加载 catalog 失败:', err);
  });
}

// 内部发送通知函数（事件驱动调用）
function notifyStockChange(products, token, channelId, bot) {
  if (!Array.isArray(products)) products = [products];
  if (products.length === 0) return;

  const providerName = products[0].providerName;

  let message = `📦 <b>${providerName} 补货通知</b>\n`;
  message += `${providerName} 有 ${products.length} 款产品补货了\n\n`;

  products.forEach((product, i) => {
    const sp = product.specs || {};
    const routes = (product.networkRoutes || []).join('/') || '普通线路';
    const dcs = (product.datacenters || []).join('/') || '未知';
    const buyUrl = product.affUrl || product.checkUrl;
    
    const specLine = [sp.cpu, sp.ram, sp.disk, sp.bandwidth].filter(Boolean).join('/');
    const portInfo = sp.port ? `@${sp.port}` : '';

    message += `📦 <b>${providerName} - [${product.name}]</b>\n`;
    message += `${specLine}${portInfo}\n`;
    message += `├ 线路：${routes} · ${dcs}\n`;
    message += `💰 <b>${product.price}</b>\n`;
    message += `🛒 <a href="${buyUrl}">点击直达购买</a>\n`;

    if (i < products.length - 1) message += `\n`; 
  });

  message += `\n━━━━━━━━━━━━━━\n`;
  message += `欢迎关注VPS补货监控频道：@dmvpsjk\n`;
  message += `https://vps.yyinai.com`;

  bot.sendMessage(channelId, message, {
    parse_mode: 'HTML',
    disable_web_page_preview: false
  }).catch(e => console.error('[TG Error] 发送群组通知失败:', e.message));
}
