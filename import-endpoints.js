import db from './db.js';

// 定义需要全量写入的测速节点数据
const endpointsData = {
  bandwagonhost: [
    { type: 'speedtest', url: '162.244.241.102', location: 'Los Angeles DC6 (CN2 GIA-E)' },
    { type: 'lg', url: 'https://dc6.bwg.net/', location: 'Los Angeles DC6 (CN2 GIA-E)' },
    { type: 'speedtest', url: '65.49.131.102', location: 'Los Angeles DC9 (CN2 GIA)' },
    { type: 'lg', url: 'https://dc9.bwg.net/', location: 'Los Angeles DC9 (CN2 GIA)' },
    { type: 'speedtest', url: '93.179.124.235', location: 'Hong Kong HK8 (CN2 GIA / 纯IP对标)' },
    { type: 'speedtest', url: '45.78.18.149', location: 'Hong Kong HK3 (CMI / 纯IP对标)' }
  ],
  dmit: [
    { type: 'speedtest', url: '154.17.0.142', location: 'LAX Premium/Pro (CN2 GIA)' },
    { type: 'lg', url: 'https://lg.dmit.sh/', location: 'DMIT 官方综合 Looking Glass' },
    { type: 'speedtest', url: '174.136.204.135', location: 'LAX Tier 1 (CMIN2/直连)' },
    { type: 'speedtest', url: '154.12.190.32', location: 'TYO Pro (CN2 GIA)' },
    { type: 'speedtest', url: '154.12.176.28', location: 'HKG Tier 1' }
  ],
  racknerd: [
    { type: 'speedtest', url: '204.13.154.3', location: 'Los Angeles DC-02' },
    { type: 'lg', url: 'http://lg-lax02.racknerd.com/', location: 'Los Angeles DC-02' },
    { type: 'speedtest', url: '192.210.207.88', location: 'San Jose' },
    { type: 'lg', url: 'http://lg-sj.racknerd.com/', location: 'San Jose' },
    { type: 'speedtest', url: '192.3.253.2', location: 'Seattle' },
    { type: 'lg', url: 'http://lg-sea.racknerd.com/', location: 'Seattle' }
  ],
  zgo: [
    { type: 'speedtest', url: '207.60.50.4', location: 'Los Angeles (9929/CMIN2)' },
    { type: 'lg', url: 'https://lg.la.us.zgovps.com', location: 'Los Angeles (9929/CMIN2)' },
    { type: 'speedtest', url: '195.245.229.134', location: 'Osaka, Japan (IIJ/软银)' },
    { type: 'lg', url: 'https://lg.osaka.ryzen.jp.zgovps.com', location: 'Osaka, Japan (IIJ/软银)' }
  ],
  cloudcone: [
    { type: 'speedtest', url: '173.254.215.111', location: 'Los Angeles (MultaCom)' },
    { type: 'lg', url: 'http://la.lg.cloudc.one/', location: 'Los Angeles (MultaCom)' }
  ],
  colocrossing: [
    { type: 'speedtest', url: '107.175.180.6', location: 'Los Angeles (低价特供)' },
    { type: 'lg', url: 'http://lg.la.colocrossing.com', location: 'Los Angeles (低价特供)' },
    { type: 'speedtest', url: '192.3.180.103', location: 'Buffalo / New York (美东)' },
    { type: 'lg', url: 'http://lg.buf.colocrossing.com', location: 'Buffalo / New York (美东)' }
  ]
};

async function run() {
  console.log(`[Import] 开始批量更新所有产品的 testEndpoints...`);
  const products = db.getAllProducts();
  let updatedCount = 0;

  for (const product of products) {
    const provider = product.provider.toLowerCase();
    
    // 如果匹配到了我们配置中的商家
    if (endpointsData[provider]) {
      // 无论产品里原本有没有 testEndpoints，我们这里都全量覆盖
      db.updateProduct(product.id, {
        testEndpoints: endpointsData[provider]
      });
      updatedCount++;
    }
  }

  console.log(`[Import] ✅ 成功更新了 ${updatedCount} 款产品的测速节点！`);
  console.log(`[Import] 数据已直接写入 SQLite，即刻生效。`);
}

run().catch(console.error);
