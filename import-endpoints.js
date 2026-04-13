import db from './db.js';

// testEndpoints 格式与前端一致：{ label, datacenter, route, type('ip'|'url'|'lg'), value, official, note }
const endpointsData = {
  bandwagonhost: [
    { label: '洛杉矶 DC6 / CN2 GIA-E', datacenter: 'Los Angeles DC6', route: 'CN2 GIA-E', type: 'ip', value: '162.244.241.102', official: false, note: '第三方对标节点' },
    { label: '洛杉矶 DC6 / LG', datacenter: 'Los Angeles DC6', route: 'CN2 GIA-E', type: 'lg', value: 'https://dc6.bwg.net/', official: false, note: '第三方对标节点' },
    { label: '洛杉矶 DC9 / CN2 GIA', datacenter: 'Los Angeles DC9', route: 'CN2 GIA', type: 'ip', value: '65.49.131.102', official: false, note: '第三方对标节点' },
    { label: '洛杉矶 DC9 / LG', datacenter: 'Los Angeles DC9', route: 'CN2 GIA', type: 'lg', value: 'https://dc9.bwg.net/', official: false, note: '第三方对标节点' },
    { label: '香港 HK8 / CN2 GIA', datacenter: 'Hong Kong HK8', route: 'CN2 GIA', type: 'ip', value: '93.179.124.235', official: false, note: '第三方对标节点' },
    { label: '香港 HK3 / CMI', datacenter: 'Hong Kong HK3', route: 'CMI', type: 'ip', value: '45.78.18.149', official: false, note: '第三方对标节点' }
  ],
  dmit: [
    { label: '洛杉矶 LAX / CN2 GIA (Pro)', datacenter: 'Los Angeles LAX', route: 'CN2 GIA', type: 'ip', value: '154.17.0.142', official: false, note: '第三方对标节点' },
    { label: 'DMIT 官方 Looking Glass', datacenter: 'Multi-DC', route: '全线路', type: 'lg', value: 'https://lg.dmit.sh/', official: true, note: '官方 LG' },
    { label: '洛杉矶 LAX / CMIN2 (T1/EB)', datacenter: 'Los Angeles LAX', route: 'CMIN2', type: 'ip', value: '174.136.204.135', official: false, note: '第三方对标节点' },
    { label: '东京 TYO / CN2 GIA (Pro)', datacenter: 'Tokyo TYO', route: 'CN2 GIA', type: 'ip', value: '154.12.190.32', official: false, note: '第三方对标节点' },
    { label: '香港 HKG / T1', datacenter: 'Hong Kong HKG', route: 'T1 国际', type: 'ip', value: '154.12.176.28', official: false, note: '第三方对标节点' }
  ],
  racknerd: [
    { label: '洛杉矶 DC02 / 测试 IP', datacenter: 'Los Angeles DC02', route: '默认线路', type: 'ip', value: '204.13.154.3', official: true, note: '官方测试 IP' },
    { label: '洛杉矶 DC02 / LG', datacenter: 'Los Angeles DC02', route: '默认线路', type: 'lg', value: 'http://lg-lax02.racknerd.com/', official: true, note: '官方 LG' },
    { label: '圣何塞 SJ / 测试 IP', datacenter: 'San Jose', route: '默认线路', type: 'ip', value: '192.210.207.88', official: true, note: '官方测试 IP' },
    { label: '圣何塞 SJ / LG', datacenter: 'San Jose', route: '默认线路', type: 'lg', value: 'http://lg-sj.racknerd.com/', official: true, note: '官方 LG' },
    { label: '西雅图 SEA / 测试 IP', datacenter: 'Seattle', route: '默认线路', type: 'ip', value: '192.3.253.2', official: true, note: '官方测试 IP' },
    { label: '西雅图 SEA / LG', datacenter: 'Seattle', route: '默认线路', type: 'lg', value: 'http://lg-sea.racknerd.com/', official: true, note: '官方 LG' }
  ],
  zgocloud: [
    { label: '洛杉矶 / 9929 CMIN2 测试 IP', datacenter: 'Los Angeles', route: '9929 / CMIN2', type: 'ip', value: '207.60.50.4', official: true, note: '官方测试 IP' },
    { label: '洛杉矶 / LG', datacenter: 'Los Angeles', route: '9929 / CMIN2', type: 'lg', value: 'https://lg.la.us.zgovps.com', official: true, note: '官方 LG' },
    { label: '大阪 / IIJ 软银 测试 IP', datacenter: 'Osaka', route: 'IIJ / 软银', type: 'ip', value: '195.245.229.134', official: true, note: '官方测试 IP' },
    { label: '大阪 / LG', datacenter: 'Osaka', route: 'IIJ / 软银', type: 'lg', value: 'https://lg.osaka.ryzen.jp.zgovps.com', official: true, note: '官方 LG' }
  ],
  greencloud: [
    { label: '新加坡 DC1 / 测试 IP', datacenter: 'Singapore DC1', route: 'KVM / 国际线路', type: 'ip', value: 'pending-confirmation', official: false, note: '官网公开商品文案可确认机房为 Singapore DC1，真实测试 IP 待补录' },
    { label: '新加坡 DC1 / LG', datacenter: 'Singapore DC1', route: 'KVM / 国际线路', type: 'lg', value: 'https://greencloudvps.com/billing/cart.php?gid=5', official: true, note: '当前仅确认到官方 Singapore 产品入口，暂未发现独立 LG' },
    { label: '新加坡 DC2 / 测试 IP', datacenter: 'Singapore DC2', route: 'KVM / 国际线路', type: 'ip', value: 'pending-confirmation', official: false, note: '官网公开商品文案可确认机房为 Singapore DC2，真实测试 IP 待补录' },
    { label: '新加坡 DC2 / LG', datacenter: 'Singapore DC2', route: 'KVM / 国际线路', type: 'lg', value: 'https://greencloudvps.com/billing/store/ryzen-kvm-vps', official: true, note: 'Ryzen KVM 列表已出现 Singapore DC2 文案，暂以该官方页面作入口占位' },
    { label: '东京 JP IIJ / 测试 IP', datacenter: 'Tokyo JP IIJ', route: 'IIJ / 国际线路', type: 'ip', value: 'pending-confirmation', official: false, note: '官网公开商品文案可确认 Tokyo, JP IIJ Line Location，真实测试 IP 待补录' },
    { label: '东京 JP IIJ / LG', datacenter: 'Tokyo JP IIJ', route: 'IIJ / 国际线路', type: 'lg', value: 'https://greencloudvps.com/billing/store/ryzen-kvm-vps', official: true, note: 'Ryzen KVM 列表已出现 Tokyo, JP IIJ Line Location，暂以该官方页面作入口占位' },
    { label: '东京 JP Softbank / 测试 IP', datacenter: 'Tokyo JP Softbank', route: 'Softbank / 国际线路', type: 'ip', value: 'pending-confirmation', official: false, note: '官网公开商品文案可确认 Tokyo, JP Softbank Line Location，真实测试 IP 待补录' },
    { label: '东京 JP Softbank / LG', datacenter: 'Tokyo JP Softbank', route: 'Softbank / 国际线路', type: 'lg', value: 'https://greencloudvps.com/billing/cart.php?gid=5', official: true, note: '预算 KVM 商品页已出现 Tokyo, JP Softbank Line Location，暂以官方产品入口页作占位' },
    { label: '特价 / 周年庆', datacenter: 'Special Offers', route: 'Promo / Anniversary', type: 'url', value: 'https://greencloudvps.com/billing/promotions.php', official: true, note: '官方促销聚合页；当前访问可能返回 404，保留作活动入口占位' }
  ],
  colocrossing: [
    { label: '洛杉矶 / 测试 IP', datacenter: 'Los Angeles', route: '默认线路', type: 'ip', value: '107.175.180.6', official: true, note: '官方测试 IP' },
    { label: '洛杉矶 / LG', datacenter: 'Los Angeles', route: '默认线路', type: 'lg', value: 'http://lg.la.colocrossing.com', official: true, note: '官方 LG' },
    { label: '布法罗 BUF / 测试 IP', datacenter: 'Buffalo NY', route: '美东线路', type: 'ip', value: '192.3.180.103', official: true, note: '官方测试 IP' },
    { label: '布法罗 BUF / LG', datacenter: 'Buffalo NY', route: '美东线路', type: 'lg', value: 'http://lg.buf.colocrossing.com', official: true, note: '官方 LG' }
  ]
};

function run() {
  console.log('[Import] 开始批量更新所有产品的 testEndpoints...');
  const products = db.getAllProducts();
  let updatedCount = 0;

  for (const product of products) {
    const provider = (product.provider || '').toLowerCase();
    if (endpointsData[provider]) {
      db.updateProduct(product.id, { testEndpoints: endpointsData[provider] });
      updatedCount++;
      console.log(`  ✓ ${product.id} (${product.providerName || provider})`);
    }
  }

  console.log(`[Import] ✅ 成功更新 ${updatedCount} 款产品的测速节点，数据已写入 SQLite。`);
}

run();
