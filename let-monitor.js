/**
 * let-monitor.js — LowEndTalk 闪购监控模块
 *
 * 监控 LET 指定帖子中目标用户（默认 NDTN / GreenCloud 官方）的新发言，
 * 检测到闪购/促销信息时通过 Telegram 推送通知。
 *
 * 技术方案：FlareSolverr（绕 Cloudflare）+ Cheerio（解析 HTML）
 *
 * 依赖：
 *   - FlareSolverr 容器（docker-compose 中配置）
 *   - cheerio（已有依赖）
 *   - node-fetch（已有依赖）
 */

import fetch from 'node-fetch';
import * as cheerio from 'cheerio';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ============================================================
// 配置
// ============================================================

const CONFIG = {
  // FlareSolverr 服务地址（Docker 内部网络）
  flareSolverrUrl: process.env.FLARESOLVERR_URL || 'http://flaresolverr:8191/v1',

  // 监控目标帖子列表（可扩展多个帖子）
  targets: [
    {
      id: 'greencloud-216691',
      discussionId: 216691,
      slug: 'greencloud-top-1-provider-2024-2025-double-promotions-and-flash-sale-giveaways',
      baseUrl: 'https://lowendtalk.com/discussion/216691/greencloud-top-1-provider-2024-2025-double-promotions-and-flash-sale-giveaways',
      targetUser: 'NDTN',           // 监控的用户名
      label: 'GreenCloud 闪购',     // TG 推送时的标签
    },
  ],

  // 轮询间隔（毫秒）— 每 3 秒检查一次（FlareSolverr 实际耗时 10-30s，防重叠保护）
  checkInterval: 3 * 1000,

  // FlareSolverr 请求超时（毫秒）
  solverTimeout: 60000,

  // 已读评论 ID 持久化文件
  seenFile: path.join(__dirname, 'data', 'let-seen-ids.json'),
};

// ============================================================
// 状态管理
// ============================================================

// 已处理的评论 ID 集合（防止重复推送）
let seenCommentIds = new Set();

/** 从磁盘加载已读 ID */
function loadSeenIds() {
  try {
    if (fs.existsSync(CONFIG.seenFile)) {
      const data = JSON.parse(fs.readFileSync(CONFIG.seenFile, 'utf8'));
      seenCommentIds = new Set(data);
      console.log(`[LET] 已加载 ${seenCommentIds.size} 个已读评论 ID`);
    }
  } catch (err) {
    console.warn(`[LET] 加载已读 ID 失败: ${err.message}`);
  }
}

/** 持久化已读 ID 到磁盘 */
function saveSeenIds() {
  try {
    // 只保留最近 2000 条，避免文件无限增长
    const arr = [...seenCommentIds].slice(-2000);
    seenCommentIds = new Set(arr);
    fs.writeFileSync(CONFIG.seenFile, JSON.stringify(arr), 'utf8');
  } catch (err) {
    console.warn(`[LET] 保存已读 ID 失败: ${err.message}`);
  }
}

// ============================================================
// FlareSolverr 请求封装
// ============================================================

/**
 * 通过 FlareSolverr 获取页面 HTML（绕过 Cloudflare）
 * @param {string} url - 目标 URL
 * @returns {string|null} HTML 内容，失败返回 null
 */
async function fetchViaFlaresolverr(url) {
  try {
    const res = await fetch(CONFIG.flareSolverrUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        cmd: 'request.get',
        url,
        maxTimeout: CONFIG.solverTimeout,
      }),
    });

    if (!res.ok) {
      console.error(`[LET] FlareSolverr 返回 ${res.status}`);
      return null;
    }

    const data = await res.json();

    if (data.status === 'ok' && data.solution?.response) {
      return data.solution.response;
    }

    console.error(`[LET] FlareSolverr 解析失败:`, data.message || '未知错误');
    return null;
  } catch (err) {
    console.error(`[LET] FlareSolverr 请求失败: ${err.message}`);
    return null;
  }
}

// ============================================================
// HTML 解析
// ============================================================

/**
 * 从帖子页面 HTML 中提取总页数
 */
function extractTotalPages(html) {
  const $ = cheerio.load(html);
  // Vanilla Forums 分页器：最后一页链接 class="LastPage"
  const lastPageLink = $('a.LastPage, .Pager-p.LastPage a').attr('href');
  if (lastPageLink) {
    const match = lastPageLink.match(/\/p(\d+)/);
    if (match) return parseInt(match[1], 10);
  }
  // 备选：直接数分页按钮
  let maxPage = 1;
  $('a.Pager-p, .Pager a').each((_, el) => {
    const href = $(el).attr('href') || '';
    const m = href.match(/\/p(\d+)/);
    if (m) maxPage = Math.max(maxPage, parseInt(m[1], 10));
  });
  return maxPage;
}

/**
 * 从帖子页面 HTML 中提取指定用户的评论
 * @param {string} html - 页面 HTML
 * @param {string} targetUser - 目标用户名
 * @returns {Array<{commentId, author, content, html, links, timestamp}>}
 */
function extractUserComments(html, targetUser) {
  const $ = cheerio.load(html);
  const comments = [];

  $('li.Item.Comment, li.ItemComment').each((_, el) => {
    const $el = $(el);

    // 提取作者名
    const author = $el.find('.Author a.Username, .Comment-Author a').text().trim();
    if (author.toLowerCase() !== targetUser.toLowerCase()) return;

    // 提取评论 ID（用于去重）
    const rawId = $el.attr('id') || '';
    const commentId = rawId.replace('Comment_', '') || `unknown_${Date.now()}_${Math.random()}`;

    // 提取内容
    const $message = $el.find('div.Message, .Comment-Body .Message');
    const contentHtml = $message.html() || '';
    const contentText = $message.text().trim();

    // 提取所有链接
    const links = [];
    $message.find('a[href]').each((_, a) => {
      const href = $(a).attr('href');
      const text = $(a).text().trim();
      if (href) links.push({ href, text });
    });

    // 提取时间戳
    const timestamp = $el.find('time').attr('datetime') ||
                      $el.find('.DateCreated').text().trim() || '';

    comments.push({
      commentId,
      author,
      content: contentText,
      html: contentHtml,
      links,
      timestamp,
    });
  });

  return comments;
}

/**
 * 从评论内容中提取闪购/促销信息
 * @param {Object} comment - 评论对象
 * @returns {Object|null} 提取到的闪购信息，非促销内容返回 null
 */
function extractDealInfo(comment) {
  const text = comment.content.toLowerCase();

  // 闪购/促销关键词检测
  const dealKeywords = [
    'flash', 'sale', 'deal', 'promo', 'coupon', 'discount',
    'limited', 'offer', 'special', 'giveaway', 'free',
    'double', 'promotion', '$', 'off', 'save',
    '/yr', '/mo', '/year', '/month', 'annually', 'monthly',
    'cart.php', 'billing/store',
  ];

  const isDeal = dealKeywords.some(kw => text.includes(kw));
  if (!isDeal) return null;

  // 提取购买链接
  const purchaseLinks = comment.links.filter(l =>
    l.href.includes('greencloudvps.com') ||
    l.href.includes('cart.php') ||
    l.href.includes('billing/store') ||
    l.href.includes('aff.php')
  );

  // 提取价格信息
  const priceMatches = comment.content.match(/\$\d+(?:\.\d{1,2})?(?:\s*\/\s*(?:yr|year|mo|month|annually|monthly|quarterly))?/gi) || [];

  // 提取优惠码
  const promoMatches = comment.content.match(/(?:code|coupon|promo)[:\s]*([A-Z0-9_-]{3,20})/gi) || [];

  return {
    purchaseLinks,
    prices: [...new Set(priceMatches)],
    promoCodes: promoMatches.map(m => m.replace(/^(?:code|coupon|promo)[:\s]*/i, '').trim()),
    isFlashSale: text.includes('flash') || text.includes('limited') || text.includes('hurry'),
  };
}

// ============================================================
// 核心监控循环
// ============================================================

/**
 * 检查单个帖子的新发言
 * @param {Object} target - 监控目标配置
 * @param {Function} onNewDeal - 发现新闪购时的回调
 */
async function checkTarget(target, onNewDeal) {
  // 第一步：获取第一页确定总页数（或直接用上次记录的页数）
  const firstPageUrl = `${target.baseUrl}/p1`;
  console.log(`[LET] 检查 ${target.label}...`);

  const firstHtml = await fetchViaFlaresolverr(firstPageUrl);
  if (!firstHtml) {
    console.warn(`[LET] ❌ 无法获取 ${target.label} 第一页`);
    return;
  }

  const totalPages = extractTotalPages(firstHtml);
  console.log(`[LET] ${target.label} 共 ${totalPages} 页`);

  // 第二步：获取最后一页（新发言在这里）
  const lastPageUrl = `${target.baseUrl}/p${totalPages}`;
  let lastHtml;
  if (totalPages === 1) {
    lastHtml = firstHtml; // 只有一页，复用
  } else {
    lastHtml = await fetchViaFlaresolverr(lastPageUrl);
    if (!lastHtml) {
      console.warn(`[LET] ❌ 无法获取 ${target.label} 第 ${totalPages} 页`);
      return;
    }
  }

  // 第三步：提取目标用户的评论
  const comments = extractUserComments(lastHtml, target.targetUser);
  console.log(`[LET] 最后一页找到 ${comments.length} 条 ${target.targetUser} 的发言`);

  // 第四步：过滤出新评论并检测闪购
  let newDealCount = 0;
  for (const comment of comments) {
    // 跳过已处理的评论
    if (seenCommentIds.has(comment.commentId)) continue;

    // 标记为已读
    seenCommentIds.add(comment.commentId);

    // 检测是否包含闪购信息
    const dealInfo = extractDealInfo(comment);
    if (dealInfo) {
      newDealCount++;
      console.log(`[LET] 🔥 发现新闪购! Comment#${comment.commentId}`);
      onNewDeal({
        target,
        comment,
        dealInfo,
      });
    } else {
      console.log(`[LET] 📝 新发言但非闪购: Comment#${comment.commentId} (${comment.content.substring(0, 50)}...)`);
    }
  }

  if (newDealCount === 0 && comments.length > 0) {
    console.log(`[LET] ✅ 无新闪购`);
  }

  // 持久化已读 ID
  saveSeenIds();
}

// ============================================================
// Telegram 推送
// ============================================================

/**
 * 构造 TG 闪购通知消息
 */
function buildTgMessage(data) {
  const { target, comment, dealInfo } = data;

  let msg = `🔥 <b>${target.label} 新闪购!</b>\n\n`;
  msg += `👤 发布者: <b>${comment.author}</b>\n`;
  if (comment.timestamp) msg += `🕐 时间: ${comment.timestamp}\n`;
  msg += `\n`;

  // 价格信息
  if (dealInfo.prices.length > 0) {
    msg += `💰 价格: ${dealInfo.prices.join(' / ')}\n`;
  }

  // 优惠码
  if (dealInfo.promoCodes.length > 0) {
    msg += `🎫 优惠码: ${dealInfo.promoCodes.map(c => `<code>${c}</code>`).join(', ')}\n`;
  }

  // 限时标记
  if (dealInfo.isFlashSale) {
    msg += `⚡ <b>限时闪购，手慢无!</b>\n`;
  }

  msg += `\n`;

  // 正文摘要（截取前 500 字符）
  const summary = comment.content.substring(0, 500);
  msg += `📄 内容:\n${summary}${comment.content.length > 500 ? '...' : ''}\n\n`;

  // 购买链接
  if (dealInfo.purchaseLinks.length > 0) {
    msg += `🛒 购买链接:\n`;
    dealInfo.purchaseLinks.forEach(l => {
      msg += `  → <a href="${l.href}">${l.text || '直达购买'}</a>\n`;
    });
  }

  // 原帖链接
  msg += `\n📎 <a href="${target.baseUrl}#Comment_${comment.commentId}">查看原帖</a>`;

  return msg;
}

// ============================================================
// 导出：启动监控引擎
// ============================================================

/**
 * 启动 LET 闪购监控
 * @param {Object} bot - Telegram Bot 实例
 * @param {string} channelId - 推送频道 ID
 */
export function startLetMonitor(bot, channelId) {
  // 加载已读 ID
  loadSeenIds();

  const adminChatId = process.env.TG_ADMIN_ID || null;

  // 新闪购回调：推送到 TG
  const onNewDeal = (data) => {
    const msg = buildTgMessage(data);

    // 推送到频道
    if (bot && channelId) {
      bot.sendMessage(channelId, msg, {
        parse_mode: 'HTML',
        disable_web_page_preview: false,
      }).catch(e => console.error('[LET] TG 频道推送失败:', e.message));
    }

    // 同时推送到管理员
    if (bot && adminChatId) {
      bot.sendMessage(adminChatId, msg, {
        parse_mode: 'HTML',
        disable_web_page_preview: false,
      }).catch(e => console.error('[LET] TG 管理员推送失败:', e.message));
    }
  };

  // 防重叠保护：FlareSolverr 单次请求需 10-30 秒，避免请求堆积
  let isChecking = false;

  const runCheck = async () => {
    if (isChecking) return; // 上一轮还没跑完，跳过
    isChecking = true;
    try {
      for (const target of CONFIG.targets) {
        await checkTarget(target, onNewDeal);
      }
    } finally {
      isChecking = false;
    }
  };

  // 首次检查（延迟 10 秒，等 FlareSolverr 启动）
  setTimeout(runCheck, 10 * 1000);

  // 定时循环
  setInterval(runCheck, CONFIG.checkInterval);
}

/**
 * 手动触发一次检查（供 TG Bot /let 命令调用）
 */
export async function manualLetCheck(bot, chatId) {
  loadSeenIds();

  let foundDeals = 0;
  for (const target of CONFIG.targets) {
    await checkTarget(target, (data) => {
      foundDeals++;
      const msg = buildTgMessage(data);
      bot.sendMessage(chatId, msg, {
        parse_mode: 'HTML',
        disable_web_page_preview: false,
      }).catch(e => console.error('[LET] TG 推送失败:', e.message));
    });
  }

  if (foundDeals === 0) {
    bot.sendMessage(chatId, '✅ LET 监控检查完毕，暂无新闪购。')
      .catch(e => console.error('[LET] TG 推送失败:', e.message));
  }
}
