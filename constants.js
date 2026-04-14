/**
 * constants.js — 全局共享常量与工具函数
 *
 * 唯一 Truth Source，统一维护以下数据：
 *   1. 垃圾名称正则 JUNK_NAME_RE / JUNK_PATTERNS — 所有检查点引用此处
 *   2. 商家域名映射 PROVIDER_MAP — tgBot.js / discovery.js 共享
 *   3. Affiliate ID — discovery.js / tgBot.js 共享
 *   4. 工具函数（escapeHtml 等）
 */

// ============================================================
// 垃圾名称正则（server.js / discovery.js / purge-junk.js 统一引用）
// ============================================================

/**
 * 正则版本 — 用于 .test() 场景
 * 匹配非 VPS 产品（共享主机、SSL、域名注册等）和错误页面标题
 */
export const JUNK_NAME_RE = /Shopping Cart|Shared Hosting|404|Oops|there.*problem|Cloud Virtual Private|Web Hosting|Error|Page Not Found|cPanel|Reseller|Domain Reg|just a moment|checking your browser|cloudflare|stack error|encountered a problem|SSL Certificate|Addon|Extra IP|Dedicated Server|Domain Registration|Virtual Web Hosting|非VPS产品自动拦截|^Categories$|Configuration Summary|^Bandwagon Host$|^RackNerd$|^DMIT$|^GreenCloud$|^ColoCrossing$|^ZGO Cloud$|Order Summary|Review & Checkout|Product Details/i;

/**
 * 数组版本 — 用于 .some() 场景（server.js isJunkProduct）
 * 与 JUNK_NAME_RE 保持同步
 */
export const JUNK_PATTERNS = [
  /oops/i, /there's a problem/i, /invalid/i, /404/i, /not found/i,
  /shopping cart/i, /error/i, /stack error/i, /encountered a problem/i,
  /just a moment/i, /checking your browser/i, /cloudflare/i,
  /shared hosting/i, /cpanel/i, /reseller/i, /dedicated server/i,
  /virtual web hosting/i, /ssl certificate/i, /addon/i, /extra ip/i,
  /domain reg/i, /cloud virtual private/i, /web hosting/i,
  /非VPS产品自动拦截/i,
  /^categories$/i, /configuration summary/i,
  /^bandwagon host$/i, /^racknerd$/i, /^dmit$/i, /^greencloud$/i,
  /^colocrossing$/i, /^zgo cloud$/i,
  /order summary/i, /review & checkout/i, /product details/i,
];

// ============================================================
// Affiliate ID（discovery.js / tgBot.js 共享）
// ============================================================
export const AFF = {
  bwh: 81381,
  dmit: 16687,
  rn: 19252,
  colo: 1633,
  zgo: 912,
  greencloud: 9379,
};

// ============================================================
// 商家域名映射（tgBot.js /add 命令 + discovery.js 竞品站提取 共享）
// ============================================================
export const PROVIDER_MAP = {
  'bandwagonhost.com': { provider: 'bandwagonhost', providerName: '搬瓦工', domain: 'bandwagonhost.com', affBase: `https://bandwagonhost.com/aff.php?aff=${AFF.bwh}&pid=` },
  'bwh81.net':         { provider: 'bandwagonhost', providerName: '搬瓦工', domain: 'bandwagonhost.com', affBase: `https://bandwagonhost.com/aff.php?aff=${AFF.bwh}&pid=` },
  'bwh91.com':         { provider: 'bandwagonhost', providerName: '搬瓦工', domain: 'bandwagonhost.com', affBase: `https://bandwagonhost.com/aff.php?aff=${AFF.bwh}&pid=` },
  'bwh1.net':          { provider: 'bandwagonhost', providerName: '搬瓦工', domain: 'bandwagonhost.com', affBase: `https://bandwagonhost.com/aff.php?aff=${AFF.bwh}&pid=` },
  'dmit.io':           { provider: 'dmit', providerName: 'DMIT', domain: 'www.dmit.io', affBase: `https://www.dmit.io/aff.php?aff=${AFF.dmit}&pid=` },
  'dmitea.com':        { provider: 'dmit', providerName: 'DMIT', domain: 'www.dmit.io', affBase: `https://www.dmit.io/aff.php?aff=${AFF.dmit}&pid=` },
  'racknerd.com':      { provider: 'racknerd', providerName: 'RackNerd', domain: 'my.racknerd.com', affBase: `https://my.racknerd.com/aff.php?aff=${AFF.rn}&pid=` },
  'my.racknerd.com':   { provider: 'racknerd', providerName: 'RackNerd', domain: 'my.racknerd.com', affBase: `https://my.racknerd.com/aff.php?aff=${AFF.rn}&pid=` },
  'zgovps.com':        { provider: 'zgocloud', providerName: 'ZGO Cloud', domain: 'clients.zgovps.com', affBase: `https://clients.zgovps.com/aff.php?aff=${AFF.zgo}&pid=` },
  'greencloudvps.com':           { provider: 'greencloud', providerName: 'GreenCloud', domain: 'greencloudvps.com', affBase: `https://greencloudvps.com/billing/cart.php?a=add&pid=` },
  'billing.greencloudvps.com':   { provider: 'greencloud', providerName: 'GreenCloud', domain: 'greencloudvps.com', affBase: `https://greencloudvps.com/billing/cart.php?a=add&pid=` },
  'colocrossing.com':            { provider: 'colocrossing', providerName: 'ColoCrossing', domain: 'cloud.colocrossing.com', affBase: `https://cloud.colocrossing.com/aff.php?aff=${AFF.colo}&pid=` },
  'cloud.colocrossing.com':      { provider: 'colocrossing', providerName: 'ColoCrossing', domain: 'cloud.colocrossing.com', affBase: `https://cloud.colocrossing.com/aff.php?aff=${AFF.colo}&pid=` },
};

/**
 * 根据 URL 域名查找匹配的商家信息
 * @param {string} urlOrDomain — 完整 URL 或域名
 * @returns {{ provider, providerName, domain, affBase } | null}
 */
export function matchProvider(urlOrDomain) {
  let domain = urlOrDomain;
  try {
    domain = new URL(urlOrDomain).hostname.replace('www.', '');
  } catch {
    // 如果传入的不是合法 URL，当作域名处理
    domain = urlOrDomain.replace('www.', '');
  }
  for (const [key, val] of Object.entries(PROVIDER_MAP)) {
    if (domain.includes(key.replace('www.', ''))) {
      return val;
    }
  }
  return null;
}

// ============================================================
// 工具函数
// ============================================================

/**
 * HTML 实体转义 — 防 XSS（用于 admin.html 等 innerHTML 场景）
 * @param {string} str — 待转义字符串
 * @returns {string} 转义后的安全字符串
 */
export function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}
