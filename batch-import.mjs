// 批量补录竞品监控的热门 PID - 基于 stock.bwh91.com 和 stock.dmitea.com 的完整监控列表
import fs from 'fs';

const catalog = JSON.parse(fs.readFileSync('catalog.json', 'utf8'));
const existingIds = new Set(catalog.map(p => p.id));

function addIfMissing(product) {
  if (existingIds.has(product.id)) {
    console.log(`  跳过(已存在): ${product.id}`);
    return;
  }
  catalog.push(product);
  existingIds.add(product.id);
  console.log(`  ✅ 新增: ${product.id} - ${product.name}`);
}

// ============================================================
// 搬瓦工 (BandwagonHost) — 竞品额外监控的 16 个 PID
// ============================================================
console.log('\n== 补录搬瓦工 ==');

const bwhBase = {
  provider: 'bandwagonhost',
  providerName: '搬瓦工',
  outOfStockKeywords: ['Out of Stock', 'out of stock', 'Out of stock'],
  isSpecialOffer: true
};

// DC99 Box 系列（极度抢手的限量款）
addIfMissing({
  ...bwhBase,
  id: 'bwh-dc99-biggerbox',
  name: 'BIGGERBOX DC99',
  price: '$65.00/年',
  specs: { cpu: '2 vCPU', ram: '1 GB', disk: '20 GB SSD', bandwidth: '1 TB/mo', port: '2.5 Gbps' },
  datacenters: ['DC99 (CN2 GIA-E)'],
  networkRoutes: ['CN2 GIA'],
  checkUrl: 'https://bandwagonhost.com/cart.php?a=add&pid=152',
  affUrl: 'https://bandwagonhost.com/aff.php?aff=81381&pid=152'
});

addIfMissing({
  ...bwhBase,
  id: 'bwh-dc99-powerbox',
  name: 'POWERBOX DC99',
  price: '$119.99/年',
  specs: { cpu: '3 vCPU', ram: '2 GB', disk: '40 GB SSD', bandwidth: '2 TB/mo', port: '2.5 Gbps' },
  datacenters: ['DC99 (CN2 GIA-E)'],
  networkRoutes: ['CN2 GIA'],
  checkUrl: 'https://bandwagonhost.com/cart.php?a=add&pid=153',
  affUrl: 'https://bandwagonhost.com/aff.php?aff=81381&pid=153'
});

// DC1 Box-Pro 系列
addIfMissing({
  ...bwhBase,
  id: 'bwh-dc1-biggerbox-pro',
  name: 'BIGGERBOX-PRO DC1',
  price: '$89.99/年',
  specs: { cpu: '2 vCPU', ram: '1 GB', disk: '20 GB SSD', bandwidth: '1 TB/mo', port: '2.5 Gbps' },
  datacenters: ['DC1 (QNET)'],
  networkRoutes: ['CN2 GIA'],
  checkUrl: 'https://bandwagonhost.com/cart.php?a=add&pid=156',
  affUrl: 'https://bandwagonhost.com/aff.php?aff=81381&pid=156'
});

addIfMissing({
  ...bwhBase,
  id: 'bwh-dc1-megabox-pro',
  name: 'MEGABOX-PRO DC1',
  price: '$299.99/年',
  specs: { cpu: '4 vCPU', ram: '4 GB', disk: '80 GB SSD', bandwidth: '4 TB/mo', port: '2.5 Gbps' },
  datacenters: ['DC1 (QNET)'],
  networkRoutes: ['CN2 GIA'],
  checkUrl: 'https://bandwagonhost.com/cart.php?a=add&pid=157',
  affUrl: 'https://bandwagonhost.com/aff.php?aff=81381&pid=157'
});

// THE PLAN 系列（性价比之王）
addIfMissing({
  ...bwhBase,
  id: 'bwh-the-dc9-plan',
  name: 'THE DC9 PLAN',
  price: '$89.99/年',
  specs: { cpu: '2 vCPU', ram: '1 GB', disk: '20 GB SSD', bandwidth: '1 TB/mo', port: '2.5 Gbps' },
  datacenters: ['DC9 (CN2 GIA-E)'],
  networkRoutes: ['CN2 GIA'],
  checkUrl: 'https://bandwagonhost.com/cart.php?a=add&pid=145',
  affUrl: 'https://bandwagonhost.com/aff.php?aff=81381&pid=145'
});

addIfMissing({
  ...bwhBase,
  id: 'bwh-the-dc6-plan',
  name: 'THE DC6 PLAN',
  price: '$89.99/年',
  specs: { cpu: '2 vCPU', ram: '1 GB', disk: '20 GB SSD', bandwidth: '1 TB/mo', port: '2.5 Gbps' },
  datacenters: ['DC6 (ZNET CN2 GIA-E)'],
  networkRoutes: ['CN2 GIA'],
  checkUrl: 'https://bandwagonhost.com/cart.php?a=add&pid=149',
  affUrl: 'https://bandwagonhost.com/aff.php?aff=81381&pid=149'
});

// 特色机房限量款
addIfMissing({
  ...bwhBase,
  id: 'bwh-amsterdam-plan',
  name: 'The Amsterdam Plan',
  price: '$49.99/年',
  specs: { cpu: '1 vCPU', ram: '0.5 GB', disk: '10 GB SSD', bandwidth: '0.5 TB/mo', port: '2.5 Gbps' },
  datacenters: ['EU NL (荷兰阿姆斯特丹)'],
  networkRoutes: ['联通9929 / AS9929'],
  checkUrl: 'https://bandwagonhost.com/cart.php?a=add&pid=159',
  affUrl: 'https://bandwagonhost.com/aff.php?aff=81381&pid=159'
});

addIfMissing({
  ...bwhBase,
  id: 'bwh-minichicken',
  name: 'MiniChicken',
  price: '$29.99/年',
  specs: { cpu: '1 vCPU', ram: '0.5 GB', disk: '10 GB SSD', bandwidth: '0.5 TB/mo', port: '1 Gbps' },
  datacenters: ['多机房可选'],
  networkRoutes: ['普通线路'],
  checkUrl: 'https://bandwagonhost.com/cart.php?a=add&pid=158',
  affUrl: 'https://bandwagonhost.com/aff.php?aff=81381&pid=158'
});

addIfMissing({
  ...bwhBase,
  id: 'bwh-tokyo-plan-v2',
  name: 'The Tokyo Plan v2',
  price: '$89.99/年',
  specs: { cpu: '2 vCPU', ram: '1 GB', disk: '20 GB SSD', bandwidth: '0.5 TB/mo', port: '1.2 Gbps' },
  datacenters: ['JP 东京 (软银)'],
  networkRoutes: ['软银'],
  checkUrl: 'https://bandwagonhost.com/cart.php?a=add&pid=163',
  affUrl: 'https://bandwagonhost.com/aff.php?aff=81381&pid=163'
});

// 日本 JPOS 系列
addIfMissing({
  ...bwhBase,
  id: 'bwh-jp-jpos1-40g',
  name: 'JPOS1 SPECIAL 40G (大阪)',
  price: '$29.99/年',
  specs: { cpu: '1 vCPU', ram: '0.5 GB', disk: '10 GB SSD', bandwidth: '0.5 TB/mo', port: '1 Gbps' },
  datacenters: ['JP 大阪 (软银)'],
  networkRoutes: ['软银'],
  checkUrl: 'https://bandwagonhost.com/cart.php?a=add&pid=146',
  affUrl: 'https://bandwagonhost.com/aff.php?aff=81381&pid=146'
});

addIfMissing({
  ...bwhBase,
  id: 'bwh-jp-jpos6-40g',
  name: 'JPOS6 SPECIAL 40G (大阪软银)',
  price: '$49.99/年',
  specs: { cpu: '2 vCPU', ram: '0.5 GB', disk: '40 GB SSD', bandwidth: '0.5 TB/mo', port: '2.5 Gbps' },
  datacenters: ['JP 大阪 (软银 JPOS6)'],
  networkRoutes: ['软银'],
  checkUrl: 'https://bandwagonhost.com/cart.php?a=add&pid=134',
  affUrl: 'https://bandwagonhost.com/aff.php?aff=81381&pid=134'
});

// 东京 CN2 / 新加坡
addIfMissing({
  ...bwhBase,
  id: 'bwh-tyo-cn2-40g',
  name: 'Tokyo CN2 GIA SPECIAL 40G',
  price: '$89.99/年',
  specs: { cpu: '2 vCPU', ram: '1 GB', disk: '40 GB SSD', bandwidth: '0.5 TB/mo', port: '1.2 Gbps' },
  datacenters: ['JP 东京 (CN2 GIA)'],
  networkRoutes: ['CN2 GIA'],
  checkUrl: 'https://bandwagonhost.com/cart.php?a=add&pid=108',
  affUrl: 'https://bandwagonhost.com/aff.php?aff=81381&pid=108'
});

addIfMissing({
  ...bwhBase,
  id: 'bwh-sg-bug',
  name: 'Singapore SPECIAL 20G (新加坡)',
  price: '$89.99/年',
  specs: { cpu: '2 vCPU', ram: '1 GB', disk: '20 GB SSD', bandwidth: '0.5 TB/mo', port: '1 Gbps' },
  datacenters: ['SG 新加坡'],
  networkRoutes: ['CN2 GIA'],
  checkUrl: 'https://bandwagonhost.com/cart.php?a=add&pid=94',
  affUrl: 'https://bandwagonhost.com/aff.php?aff=81381&pid=94'
});

addIfMissing({
  ...bwhBase,
  id: 'bwh-basic-20g-44',
  name: 'Basic 20G KVM (经典款)',
  price: '$49.99/年',
  specs: { cpu: '2 vCPU', ram: '1 GB', disk: '20 GB SSD', bandwidth: '1 TB/mo', port: '1 Gbps' },
  datacenters: ['多机房可选'],
  networkRoutes: ['普通线路'],
  checkUrl: 'https://bandwagonhost.com/cart.php?a=add&pid=44',
  affUrl: 'https://bandwagonhost.com/aff.php?aff=81381&pid=44'
});

addIfMissing({
  ...bwhBase,
  id: 'bwh-ecommerce-sla-20g',
  name: 'ECOMMERCE SLA 20G (高可用)',
  price: '$169.99/年',
  specs: { cpu: '2 vCPU', ram: '2 GB', disk: '40 GB SSD', bandwidth: '2 TB/mo', port: '2.5 Gbps' },
  datacenters: ['DC5 (ZNET SLA)'],
  networkRoutes: ['CN2 GIA', '高可用SLA'],
  checkUrl: 'https://bandwagonhost.com/cart.php?a=add&pid=164',
  affUrl: 'https://bandwagonhost.com/aff.php?aff=81381&pid=164'
});

addIfMissing({
  ...bwhBase,
  id: 'bwh-jp-jpos1-147',
  name: 'JPOS1 SPECIAL 高配 (大阪)',
  price: '$79.99/年',
  specs: { cpu: '2 vCPU', ram: '1 GB', disk: '40 GB SSD', bandwidth: '2 TB/mo', port: '1 Gbps' },
  datacenters: ['JP 大阪 (软银)'],
  networkRoutes: ['软银'],
  checkUrl: 'https://bandwagonhost.com/cart.php?a=add&pid=147',
  affUrl: 'https://bandwagonhost.com/aff.php?aff=81381&pid=147'
});


// ============================================================
// DMIT — 竞品额外监控的 19 个 PID
// ============================================================
console.log('\n== 补录 DMIT ==');

const dmitBase = {
  provider: 'dmit',
  providerName: 'DMIT',
  outOfStockKeywords: ['Out of Stock', 'out of stock', 'Out of stock'],
  isSpecialOffer: false
};

// LAX Pro 系列（洛杉矶 CN2 GIA 高端系列 - 极度热门）
addIfMissing({
  ...dmitBase,
  id: 'dmit-la-pro-wee',
  name: 'PVM.LAX.Pro.WEE',
  price: '$28.88/季',
  specs: { cpu: '1 vCPU', ram: '1 GB', disk: '10 GB SSD', bandwidth: '0.8 TB/mo', port: '1 Gbps' },
  datacenters: ['Los Angeles'],
  networkRoutes: ['CN2 GIA', 'CMIN2'],
  checkUrl: 'https://www.dmit.io/cart.php?a=add&pid=183',
  affUrl: 'https://www.dmit.io/aff.php?aff=16687&pid=183'
});

addIfMissing({
  ...dmitBase,
  id: 'dmit-la-pro-malibu',
  name: 'PVM.LAX.Pro.MALIBU',
  price: '$14.90/月',
  specs: { cpu: '1 vCPU', ram: '1 GB', disk: '20 GB SSD', bandwidth: '1 TB/mo', port: '1 Gbps' },
  datacenters: ['Los Angeles'],
  networkRoutes: ['CN2 GIA', 'CMIN2'],
  checkUrl: 'https://www.dmit.io/cart.php?a=add&pid=186',
  affUrl: 'https://www.dmit.io/aff.php?aff=16687&pid=186'
});

addIfMissing({
  ...dmitBase,
  id: 'dmit-la-pro-palmspring',
  name: 'PVM.LAX.Pro.PalmSpring',
  price: '$32.90/月',
  specs: { cpu: '2 vCPU', ram: '2 GB', disk: '40 GB SSD', bandwidth: '2 TB/mo', port: '2 Gbps' },
  datacenters: ['Los Angeles'],
  networkRoutes: ['CN2 GIA', 'CMIN2'],
  checkUrl: 'https://www.dmit.io/cart.php?a=add&pid=182',
  affUrl: 'https://www.dmit.io/aff.php?aff=16687&pid=182'
});

addIfMissing({
  ...dmitBase,
  id: 'dmit-la-pro-irvine',
  name: 'PVM.LAX.Pro.Irvine',
  price: '$59.90/月',
  specs: { cpu: '2 vCPU', ram: '4 GB', disk: '60 GB SSD', bandwidth: '4 TB/mo', port: '4 Gbps' },
  datacenters: ['Los Angeles'],
  networkRoutes: ['CN2 GIA', 'CMIN2'],
  checkUrl: 'https://www.dmit.io/cart.php?a=add&pid=181',
  affUrl: 'https://www.dmit.io/aff.php?aff=16687&pid=181'
});

// HKG Pro 系列（香港 CN2 GIA 极度热门）
addIfMissing({
  ...dmitBase,
  id: 'dmit-hk-pro-mongkok',
  name: 'PVM.HKG.Pro.MongKoK',
  price: '$39.90/月',
  specs: { cpu: '2 vCPU', ram: '2 GB', disk: '40 GB SSD', bandwidth: '1.2 TB/mo', port: '1 Gbps' },
  datacenters: ['Hong Kong'],
  networkRoutes: ['CN2 GIA'],
  checkUrl: 'https://www.dmit.io/cart.php?a=add&pid=217',
  affUrl: 'https://www.dmit.io/aff.php?aff=16687&pid=217'
});

addIfMissing({
  ...dmitBase,
  id: 'dmit-hk-pro-tsuenwan',
  name: 'PVM.HKG.Pro.TsuenWan',
  price: '$54.90/月',
  specs: { cpu: '2 vCPU', ram: '2 GB', disk: '60 GB SSD', bandwidth: '2 TB/mo', port: '2 Gbps' },
  datacenters: ['Hong Kong'],
  networkRoutes: ['CN2 GIA'],
  checkUrl: 'https://www.dmit.io/cart.php?a=add&pid=233',
  affUrl: 'https://www.dmit.io/aff.php?aff=16687&pid=233'
});

addIfMissing({
  ...dmitBase,
  id: 'dmit-hk-pro-victoria',
  name: 'PVM.HKG.Pro.VICTORIA',
  price: '$79.90/月',
  specs: { cpu: '4 vCPU', ram: '4 GB', disk: '80 GB SSD', bandwidth: '4 TB/mo', port: '4 Gbps' },
  datacenters: ['Hong Kong'],
  networkRoutes: ['CN2 GIA'],
  checkUrl: 'https://www.dmit.io/cart.php?a=add&pid=178',
  affUrl: 'https://www.dmit.io/aff.php?aff=16687&pid=178'
});

addIfMissing({
  ...dmitBase,
  id: 'dmit-hk-pro-lokmachau',
  name: 'PVM.HKG.Pro.LOKMACHAU',
  price: '$159.90/月',
  specs: { cpu: '4 vCPU', ram: '8 GB', disk: '100 GB SSD', bandwidth: '6 TB/mo', port: '10 Gbps' },
  datacenters: ['Hong Kong'],
  networkRoutes: ['CN2 GIA'],
  checkUrl: 'https://www.dmit.io/cart.php?a=add&pid=187',
  affUrl: 'https://www.dmit.io/aff.php?aff=16687&pid=187'
});

addIfMissing({
  ...dmitBase,
  id: 'dmit-hk-pro-tiny-old',
  name: 'PVM.HKG.Pro.TINY (旧版)',
  price: '$6.90/月',
  specs: { cpu: '1 vCPU', ram: '0.75 GB', disk: '10 GB SSD', bandwidth: '0.4 TB/mo', port: '1 Gbps' },
  datacenters: ['Hong Kong'],
  networkRoutes: ['CN2 GIA'],
  checkUrl: 'https://www.dmit.io/cart.php?a=add&pid=123',
  affUrl: 'https://www.dmit.io/aff.php?aff=16687&pid=123'
});

// LAX Eyeball (EB) 系列 - 最新回国优化低延迟
addIfMissing({
  ...dmitBase,
  id: 'dmit-la-eb-intro',
  name: 'PVM.LAX.EB.INTRO',
  price: '$6.90/月',
  specs: { cpu: '1 vCPU', ram: '1 GB', disk: '10 GB SSD', bandwidth: '2 TB/mo', port: '2 Gbps' },
  datacenters: ['Los Angeles'],
  networkRoutes: ['回国优化'],
  checkUrl: 'https://www.dmit.io/cart.php?a=add&pid=231',
  affUrl: 'https://www.dmit.io/aff.php?aff=16687&pid=231'
});

addIfMissing({
  ...dmitBase,
  id: 'dmit-la-eb-corona',
  name: 'PVM.LAX.EB.CORONA',
  price: '$16.90/月',
  specs: { cpu: '2 vCPU', ram: '2 GB', disk: '40 GB SSD', bandwidth: '6 TB/mo', port: '4 Gbps' },
  datacenters: ['Los Angeles'],
  networkRoutes: ['回国优化'],
  checkUrl: 'https://www.dmit.io/cart.php?a=add&pid=218',
  affUrl: 'https://www.dmit.io/aff.php?aff=16687&pid=218'
});

addIfMissing({
  ...dmitBase,
  id: 'dmit-la-eb-fontana',
  name: 'PVM.LAX.EB.FONTANA',
  price: '$32.90/月',
  specs: { cpu: '2 vCPU', ram: '4 GB', disk: '60 GB SSD', bandwidth: '10 TB/mo', port: '4 Gbps' },
  datacenters: ['Los Angeles'],
  networkRoutes: ['回国优化'],
  checkUrl: 'https://www.dmit.io/cart.php?a=add&pid=219',
  affUrl: 'https://www.dmit.io/aff.php?aff=16687&pid=219'
});

// TYO Pro 系列 新版（日本东京 CN2 GIA 新一代 - 你截图 pid=140 的系列）
addIfMissing({
  ...dmitBase,
  id: 'dmit-tyo-pro-tiny-new',
  name: 'PVM.TYO.Pro.TINY (新版)',
  price: '$6.90/月',
  specs: { cpu: '1 vCPU', ram: '0.75 GB', disk: '10 GB SSD', bandwidth: '0.4 TB/mo', port: '1 Gbps' },
  datacenters: ['Tokyo'],
  networkRoutes: ['CN2 GIA'],
  checkUrl: 'https://www.dmit.io/cart.php?a=add&pid=138',
  affUrl: 'https://www.dmit.io/aff.php?aff=16687&pid=138'
});

addIfMissing({
  ...dmitBase,
  id: 'dmit-tyo-pro-starter',
  name: 'PVM.TYO.Pro.STARTER',
  price: '$21.90/月',
  specs: { cpu: '1 vCPU', ram: '1 GB', disk: '20 GB SSD', bandwidth: '0.5 TB/mo', port: '1 Gbps' },
  datacenters: ['Tokyo'],
  networkRoutes: ['CN2 GIA'],
  checkUrl: 'https://www.dmit.io/cart.php?a=add&pid=139',
  affUrl: 'https://www.dmit.io/aff.php?aff=16687&pid=139'
});

addIfMissing({
  ...dmitBase,
  id: 'dmit-tyo-pro-mini',
  name: 'PVM.TYO.Pro.MINI',
  price: '$39.90/月',
  specs: { cpu: '2 vCPU', ram: '2 GB', disk: '60 GB SSD', bandwidth: '1 TB/mo', port: '1 Gbps' },
  datacenters: ['Tokyo'],
  networkRoutes: ['CN2 GIA'],
  checkUrl: 'https://www.dmit.io/cart.php?a=add&pid=140',
  affUrl: 'https://www.dmit.io/aff.php?aff=16687&pid=140'
});

addIfMissing({
  ...dmitBase,
  id: 'dmit-tyo-pro-micro',
  name: 'PVM.TYO.Pro.MICRO',
  price: '$79.90/月',
  specs: { cpu: '2 vCPU', ram: '4 GB', disk: '80 GB SSD', bandwidth: '2 TB/mo', port: '1 Gbps' },
  datacenters: ['Tokyo'],
  networkRoutes: ['CN2 GIA'],
  checkUrl: 'https://www.dmit.io/cart.php?a=add&pid=141',
  affUrl: 'https://www.dmit.io/aff.php?aff=16687&pid=141'
});

// T1 国际线路入门系列
addIfMissing({
  ...dmitBase,
  id: 'dmit-la-t1-wee',
  name: 'PVM.LAX.T1.WEE',
  price: '$36.90/年',
  specs: { cpu: '1 vCPU', ram: '1 GB', disk: '20 GB SSD', bandwidth: '1000 GB/mo', port: '4 Gbps' },
  datacenters: ['Los Angeles'],
  networkRoutes: ['国际线路'],
  checkUrl: 'https://www.dmit.io/cart.php?a=add&pid=71',
  affUrl: 'https://www.dmit.io/aff.php?aff=16687&pid=71'
});

addIfMissing({
  ...dmitBase,
  id: 'dmit-hk-t1-wee',
  name: 'PVM.HKG.T1.WEE',
  price: '$39.90/年',
  specs: { cpu: '1 vCPU', ram: '0.75 GB', disk: '10 GB SSD', bandwidth: '0.4 TB/mo', port: '1 Gbps' },
  datacenters: ['Hong Kong'],
  networkRoutes: ['国际线路'],
  checkUrl: 'https://www.dmit.io/cart.php?a=add&pid=197',
  affUrl: 'https://www.dmit.io/aff.php?aff=16687&pid=197'
});

addIfMissing({
  ...dmitBase,
  id: 'dmit-tyo-t1-wee',
  name: 'PVM.TYO.T1.WEE',
  price: '$39.90/年',
  specs: { cpu: '1 vCPU', ram: '0.75 GB', disk: '10 GB SSD', bandwidth: '0.4 TB/mo', port: '1 Gbps' },
  datacenters: ['Tokyo'],
  networkRoutes: ['国际线路'],
  checkUrl: 'https://www.dmit.io/cart.php?a=add&pid=228',
  affUrl: 'https://www.dmit.io/aff.php?aff=16687&pid=228'
});

// DMIT 新品(pid=237, 245)
addIfMissing({
  ...dmitBase,
  id: 'dmit-new-237',
  name: 'DMIT 新品 (pid=237)',
  price: '待确认',
  specs: { cpu: '待确认', ram: '待确认', disk: '待确认', bandwidth: '待确认' },
  datacenters: ['待确认'],
  networkRoutes: ['待确认'],
  checkUrl: 'https://www.dmit.io/cart.php?a=add&pid=237',
  affUrl: 'https://www.dmit.io/aff.php?aff=16687&pid=237'
});

addIfMissing({
  ...dmitBase,
  id: 'dmit-new-245',
  name: 'DMIT 新品 (pid=245)',
  price: '待确认',
  specs: { cpu: '待确认', ram: '待确认', disk: '待确认', bandwidth: '待确认' },
  datacenters: ['待确认'],
  networkRoutes: ['待确认'],
  checkUrl: 'https://www.dmit.io/cart.php?a=add&pid=245',
  affUrl: 'https://www.dmit.io/aff.php?aff=16687&pid=245'
});

addIfMissing({
  ...dmitBase,
  id: 'dmit-la-spro-fixed',
  name: 'PVM.LAX.sPro.FIXED',
  price: '$179.90/月',
  specs: { cpu: '4 vCPU', ram: '4 GB', disk: '80 GB SSD', bandwidth: '6 TB/mo', port: '4 Gbps' },
  datacenters: ['Los Angeles'],
  networkRoutes: ['CN2 GIA', 'CMIN2'],
  checkUrl: 'https://www.dmit.io/cart.php?a=add&pid=179',
  affUrl: 'https://www.dmit.io/aff.php?aff=16687&pid=179'
});


// ============================================================
// 保存
// ============================================================
fs.writeFileSync('catalog.json', JSON.stringify(catalog, null, 2));
console.log(`\n✅ 完成！当前 catalog 总计 ${catalog.length} 款产品。`);
