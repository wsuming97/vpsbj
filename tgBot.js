import TelegramBot from 'node-telegram-bot-api';
import path from 'path';
import { fileURLToPath } from 'url';
import eventBus from './eventBus.js';
import db from './db.js';
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

    // 注册命令菜单快捷键（点击输入框旁的 / 按钮即可看到）
    bot.setMyCommands([
      { command: 'stock',    description: '📦 查看当前有货产品' },
      { command: 'stats',    description: '📊 各商家库存统计概览' },
      { command: 'status',   description: '⚙️ 系统运行状态' },
      { command: 'site',     description: '🌐 获取网页面板地址' },
      { command: 'add',      description: '➕ 添加新品监控' },
      { command: 'discover', description: '🔍 全网扫描挖掘新品' },
      { command: 'list',     description: '📋 查看全部监控清单' },
    ]).then(() => console.log('✅ Bot 命令菜单已注册'))
      .catch(e => console.warn('⚠️ 注册命令菜单失败:', e.message));

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
        '📌 常用指令：\n' +
        '👉 /stock - 查看当前有货产品\n' +
        '👉 /stats - 各商家库存统计概览\n' +
        '👉 /add <链接> [名称] - 快捷添加新品监控\n' +
        '👉 /discover - 立即全网扫描挖掘新品\n' +
        '👉 /status - 系统运行状态\n' +
        '👉 /site - 获取网页面板地址\n\n' +
        '🔧 管理指令：\n' +
        '👉 /list - 查看全部监控清单（含缺货）\n' +
        '👉 /off <id> - 暂停监控某产品\n' +
        '👉 /on <id> - 恢复监控某产品\n\n' +
        '💡 示例：\n' +
        '`/add https://www.dmit.io/cart.php?a=add&pid=999 DMIT新品`',
        { parse_mode: 'Markdown' }
      );
    });

    // /stock command — 只显示当前有货的产品
    bot.onText(/^\/stock$/, async (msg) => {
      if (!requireAdmin(msg)) return;

      const inStockItems = Object.values(stockState).filter(p => !p.isHidden && p.inStock === true);

      if (inStockItems.length === 0) {
        return bot.sendMessage(msg.chat.id, '📭 当前没有任何产品有货。\n爬虫正在持续监控中，补货时会自动通知你。');
      }

      const chunks = [];
      let current = `✅ **当前有货产品（${inStockItems.length} 款）：**\n\n`;

      inStockItems.forEach(p => {
        const sp = p.specs || {};
        const specLine = [sp.cpu, sp.ram, sp.disk].filter(Boolean).join(' / ');
        const buyUrl = p.affUrl || p.checkUrl;
        const entry = `📦 *${p.providerName}* — ${p.name}\n` +
          `${specLine ? '   配置：' + specLine + '\n' : ''}` +
          `   💰 ${p.price || '价格待确认'}\n` +
          `   🛒 [点击购买](${buyUrl})\n\n`;

        if (current.length + entry.length > 3900) {
          chunks.push(current);
          current = '';
        }
        current += entry;
      });
      if (current) chunks.push(current);

      for (let i = 0; i < chunks.length; i++) {
        const pageLabel = chunks.length > 1 ? `\n— 第 ${i + 1}/${chunks.length} 页 —` : '';
        await bot.sendMessage(msg.chat.id, chunks[i] + pageLabel, { parse_mode: 'Markdown', disable_web_page_preview: true });
      }
    });

    // /stats command — 各商家库存统计概览
    bot.onText(/^\/stats$/, (msg) => {
      if (!requireAdmin(msg)) return;

      // 按商家分组统计
      const providerStats = {};
      catalog.forEach(p => {
        if (p.isHidden) return;
        const key = p.providerName || p.provider;
        if (!providerStats[key]) providerStats[key] = { total: 0, inStock: 0, outOfStock: 0, checking: 0 };
        providerStats[key].total++;

        const state = stockState[p.id];
        if (!state || state.inStock === null) {
          providerStats[key].checking++;
        } else if (state.inStock) {
          providerStats[key].inStock++;
        } else {
          providerStats[key].outOfStock++;
        }
      });

      const totalInStock = Object.values(providerStats).reduce((s, v) => s + v.inStock, 0);
      const totalAll = catalog.filter(p => !p.isHidden).length;

      let text = `📊 **库存统计概览**\n\n`;
      text += `全局：${totalInStock} 款有货 / ${totalAll} 款监控中\n\n`;

      for (const [name, s] of Object.entries(providerStats)) {
        const bar = s.inStock > 0 ? '🟢' : '🔴';
        text += `${bar} **${name}**：${s.inStock}/${s.total} 有货`;
        if (s.checking > 0) text += ` (${s.checking} 检测中)`;
        text += '\n';
      }

      bot.sendMessage(msg.chat.id, text, { parse_mode: 'Markdown' });
    });

    // /site command — 获取网页面板地址
    bot.onText(/^\/site$/, (msg) => {
      if (!requireAdmin(msg)) return;
      const port = process.env.PORT || 4000;
      const host = process.env.SITE_URL || `http://185.45.192.190:${port}`;
      bot.sendMessage(msg.chat.id,
        `🌐 **网页面板地址**\n\n` +
        `前台展示页：${host}\n` +
        `后台管理页：${host}/admin.html\n\n` +
        `💡 前台只显示有货产品，库存由爬虫自动更新。`,
        { parse_mode: 'Markdown' }
      );
    });

    // /list command — 完整监控清单（含缺货），分页发送
    bot.onText(/^\/list$/, async (msg) => {
      if (!requireAdmin(msg)) return;

      const chunks = [];
      let current = `📋 **全部监控清单（${catalog.length} 款）：**\n\n`;

      catalog.forEach(p => {
        const state = stockState[p.id];
        let icon = '⏳';
        if (p.isHidden) icon = '⏸️';
        else if (state && state.inStock === true) icon = '✅';
        else if (state && state.inStock === false) icon = '❌';

        const entry = `${icon} \`${p.id}\` ${p.name}\n`;

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

      db.updateProduct(id, { isHidden: true });
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

      db.updateProduct(id, { isHidden: false });
      reloadCatalog();

      bot.sendMessage(msg.chat.id, `✅ 成功上架产品！\n*${catalog[productIndex].name}* 已恢复在网页前端的显示，爬虫正在努力监测中。`, { parse_mode: 'Markdown' });
    });

    // /status command — 增强版系统状态
    bot.onText(/^\/status$/, (msg) => {
      if (!requireAdmin(msg)) return;

      const activeCount = catalog.filter(p => !p.isHidden).length;
      const inStockCount = Object.values(stockState).filter(p => !p.isHidden && p.inStock === true).length;
      const errorCount = Object.values(stockState).filter(p => !p.isHidden && p.statusMessage && p.statusMessage.startsWith('Error')).length;

      bot.sendMessage(msg.chat.id,
        `📊 **系统状态**\n\n` +
        `⏱ 运行时间：${(process.uptime() / 60 / 60).toFixed(2)} 小时\n` +
        `📦 监控产品：${activeCount}/${catalog.length}\n` +
        `✅ 当前有货：${inStockCount} 款\n` +
        `❌ 当前缺货：${activeCount - inStockCount - errorCount} 款\n` +
        (errorCount > 0 ? `⚠️ 探测异常：${errorCount} 款\n` : '') +
        `🔄 抓取引擎：正常运行中 ✅\n` +
        `🔁 轮询间隔：每 5 分钟`,
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
      'zgovps.com': { provider: 'zgocloud', providerName: 'ZGO Cloud', affBase: 'https://clients.zgovps.com/aff.php?aff=912&pid=' },
      'cloudcone.com': { provider: 'cloudcone', providerName: 'CloudCone', affBase: null },   // CloudCone 用 ref= 格式，特殊处理
      'app.cloudcone.com': { provider: 'cloudcone', providerName: 'CloudCone', affBase: null },
      'colocrossing.com': { provider: 'colocrossing', providerName: 'ColoCrossing', affBase: 'https://cloud.colocrossing.com/aff.php?aff=1633&pid=' },
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
        const resp = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' } });
        const html = await resp.text();
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
        if (matched.affBase) {
          affUrl = matched.affBase + pid;
        } else if (matched.provider === 'cloudcone') {
          // CloudCone 用 ref= 参数，URL 格式为 /vps/{id}/create?ref=...
          affUrl = `https://app.cloudcone.com/vps/${pid}/create?ref=14121`;
        }
        let checkUrl = matched.provider === 'cloudcone'
          ? `https://app.cloudcone.com/vps/${pid}/create`
          : (url.includes('pid=') || !matched.affBase) ? url : `https://${domain}/cart.php?a=add&pid=${pid}`;

        const newProduct = {
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
          isSpecialOffer: true,
          source: 'manual'
        };
        db.addProduct(newProduct);
        addedCount++;
      }

      if (addedCount > 0) {
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

    // 价格变动提示
    if (product.priceChanged && product.oldPrice) {
      message += `💰 <b>${product.livePrice}</b>`;
      message += ` ⚠️ <s>${product.oldPrice}</s> → 价格已更新\n`;
    } else {
      message += `💰 <b>${product.price}</b>\n`;
    }

    if (product.promoCode) {
      message += `🎫 优惠码：<code>${product.promoCode}</code>\n`;
    }

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
