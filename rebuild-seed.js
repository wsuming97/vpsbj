/**
 * rebuild-seed.js — 根据 bwgstock.com / dmitstock.com 产品列表重建 seed 数据
 *
 * 数据来源：2026-04-14 实时抓取 bwgstock.com + dmitstock.com
 * 规则：
 *   1. 产品完全对齐竞品站（他们有什么我们就有什么）
 *   2. Affiliate 链接用我们自己的 AFF ID
 *   3. 其他商家（RackNerd/ZGO/ColoCrossing/GreenCloud）保留不动
 *
 * 用法：node rebuild-seed.js
 */
import fs from 'fs';
import db from './db.js';

const BWH_AFF = 81381;
const DMIT_AFF = 16687;

// ═══════════════════════════════════════════════════
// BWH — 来自 bwgstock.com（8 款，全部年付）
// 优惠码 BWHCGLUKKB 可用但不影响原价显示
// ═══════════════════════════════════════════════════
const bwhProducts = [
  {
    id: 'bwh-osaka',
    name: '搬瓦工-OSAKA',
    specs: { cpu: '1C', ram: '2G', disk: '40G SSD', bandwidth: '2000G/月', port: '2.5Gbps' },
    price: '$79.99/年',
    pid: 134,
    datacenters: ['Osaka JPOS_1'],
    networkRoutes: ['日本软银 SoftBank'],
    priority: 'high',
    promoCode: 'BWHCGLUKKB',
  },
  {
    id: 'bwh-powerbox-dc99',
    name: '搬瓦工-POWERBOX-DC99',
    specs: { cpu: '1C', ram: '1.5G', disk: '30G SSD', bandwidth: '1500G/月', port: '1Gbps' },
    price: '$45.00/年',
    pid: 153,
    datacenters: ['Los Angeles DC99'],
    networkRoutes: ['回程三网 CN2 GIA'],
    priority: 'high',
    promoCode: 'BWHCGLUKKB',
  },
  {
    id: 'bwh-the-dc6-plan',
    name: '搬瓦工-The DC6 Plan',
    specs: { cpu: '1C', ram: '1G', disk: '20G SSD', bandwidth: '1000G/月', port: '2.5Gbps' },
    price: '$53.00/年',
    pid: 146,
    datacenters: ['Los Angeles DC6'],
    networkRoutes: ['CN2 GIA / CMIN2'],
    priority: 'high',
    promoCode: 'BWHCGLUKKB',
  },
  {
    id: 'bwh-the-dc9-plan',
    name: '搬瓦工-The DC9 Plan',
    specs: { cpu: '1C', ram: '768M', disk: '15G SSD', bandwidth: '1500G/月', port: '1.5Gbps' },
    price: '$38.00/年',
    pid: 145,
    datacenters: ['Los Angeles DC9'],
    networkRoutes: ['三网回程 CN2 GIA'],
    priority: 'high',
    promoCode: 'BWHCGLUKKB',
  },
  {
    id: 'bwh-the-plan-v1',
    name: '搬瓦工-The Plan V1',
    specs: { cpu: '2C', ram: '2G', disk: '40G SSD', bandwidth: '1000G/月', port: '2.5Gbps' },
    price: '$99.00/年',
    pid: 159,
    datacenters: ['17 个数据中心可切换'],
    networkRoutes: ['CN2 GIA-E / Premium'],
    priority: 'normal',
    promoCode: 'BWHCGLUKKB',
  },
  {
    id: 'bwh-the-special-plan',
    name: '搬瓦工-The Special Plan',
    specs: { cpu: '1C', ram: '512M', disk: '10G SSD', bandwidth: '500G/月', port: '1Gbps' },
    price: '$49.99/年',
    pid: 144,
    datacenters: ['14 个数据中心可切换'],
    networkRoutes: ['CN2 GIA'],
    priority: 'normal',
    promoCode: 'BWHCGLUKKB',
  },
  {
    id: 'bwh-tokyo1-dc39',
    name: '搬瓦工-Tokyo 1-DC39',
    specs: { cpu: '1C', ram: '1G', disk: '20G SSD', bandwidth: '500G/月', port: '2.5Gbps' },
    price: '$79.00/年',
    pid: 157,
    datacenters: ['Tokyo DC39'],
    networkRoutes: ['回程 CMI 直连'],
    priority: 'normal',
    promoCode: 'BWHCGLUKKB',
  },
  {
    id: 'bwh-tokyo2-dc39',
    name: '搬瓦工-Tokyo 2-DC39',
    specs: { cpu: '2C', ram: '2G', disk: '40G SSD', bandwidth: '1000G/月', port: '5Gbps' },
    price: '$99.00/年',
    pid: 158,
    datacenters: ['Tokyo DC39'],
    networkRoutes: ['回程 CMI 直连'],
    priority: 'normal',
    promoCode: 'BWHCGLUKKB',
  },
];

// ═══════════════════════════════════════════════════
// DMIT — 来自 dmitstock.com（9 款，全部年付）
// ═══════════════════════════════════════════════════
const dmitProducts = [
  {
    id: 'dmit-lax-eb-fontana',
    name: 'DMIT-LAX.EB.FONTANA',
    specs: { cpu: '2C', ram: '2G', disk: '40G SSD', bandwidth: '4000G/月', port: '4Gbps' },
    price: '$100.00/年',
    pid: 219,
    datacenters: ['Los Angeles'],
    networkRoutes: ['Eyeball CMIN2'],
  },
  {
    id: 'dmit-lax-eb-intro',
    name: 'DMIT-LAX.EB.Intro',
    specs: { cpu: '1C', ram: '1G', disk: '10G SSD', bandwidth: '500G/月', port: '1Gbps' },
    price: '$29.90/年',
    pid: 231,
    datacenters: ['Los Angeles'],
    networkRoutes: ['Eyeball CMIN2'],
  },
  {
    id: 'dmit-lax-eb-wee',
    name: 'DMIT-LAX.EB.Wee',
    specs: { cpu: '1C', ram: '1G', disk: '20G SSD', bandwidth: '1000G/月', port: '1Gbps' },
    price: '$39.90/年',
    pid: 218,
    datacenters: ['Los Angeles'],
    networkRoutes: ['Eyeball CMIN2'],
  },
  {
    id: 'dmit-lax-pro-irvine',
    name: 'DMIT-LAX.Pro.Irvine',
    specs: { cpu: '2C', ram: '2G', disk: '40G SSD', bandwidth: '3000G/月', port: '5Gbps' },
    price: '$159.00/年',
    pid: 181,
    datacenters: ['Los Angeles'],
    networkRoutes: ['CN2 GIA Premium'],
  },
  {
    id: 'dmit-lax-pro-malibu',
    name: 'DMIT-LAX.Pro.MALIBU',
    specs: { cpu: '1C', ram: '1G', disk: '20G SSD', bandwidth: '1000G/月', port: '1Gbps' },
    price: '$49.90/年',
    pid: 186,
    datacenters: ['Los Angeles'],
    networkRoutes: ['CN2 GIA Premium'],
  },
  {
    id: 'dmit-lax-pro-palmspring',
    name: 'DMIT-LAX.Pro.PalmSpring',
    specs: { cpu: '2C', ram: '2G', disk: '40G SSD', bandwidth: '2000G/月', port: '2Gbps' },
    price: '$100.00/年',
    pid: 182,
    datacenters: ['Los Angeles'],
    networkRoutes: ['CN2 GIA Premium'],
  },
  {
    id: 'dmit-lax-pro-wee',
    name: 'DMIT-LAX.Pro.Wee',
    specs: { cpu: '1C', ram: '1G', disk: '20G SSD', bandwidth: '500G/月', port: '500Mbps' },
    price: '$39.90/年',
    pid: 183,
    datacenters: ['Los Angeles'],
    networkRoutes: ['CN2 GIA Premium'],
  },
  {
    id: 'dmit-tyo-pro-shinagawa',
    name: 'DMIT-TYO.Pro.Shinagawa',
    specs: { cpu: '1C', ram: '2G', disk: '60G SSD', bandwidth: '800G/月', port: '500Mbps' },
    price: '$239.90/年',
    pid: 175,
    datacenters: ['Tokyo'],
    networkRoutes: ['CN2 GIA Premium'],
  },
  {
    id: 'dmit-tyo-t1-wee',
    name: 'DMIT-TYO.T1.Wee',
    specs: { cpu: '1C', ram: '1G', disk: '20G SSD', bandwidth: '1000G/月', port: '4Gbps' },
    price: '$36.90/年',
    pid: 228,
    datacenters: ['Tokyo'],
    networkRoutes: ['Tier 1 BGP'],
  },
];

// ═══════════════════════════════════════════════════
// 组装产品数据
// ═══════════════════════════════════════════════════
function buildProduct(p, provider, providerName, affDomain, aff) {
  return {
    id: p.id,
    provider,
    providerName,
    name: p.name,
    specs: p.specs,
    price: p.price,
    billingCycles: {},
    checkUrl: `https://${affDomain}/cart.php?a=add&pid=${p.pid}`,
    affUrl: `https://${affDomain}/aff.php?aff=${aff}&pid=${p.pid}`,
    datacenters: p.datacenters || [],
    networkRoutes: p.networkRoutes || [],
    outOfStockKeywords: ['Out of Stock', 'out of stock'],
    testEndpoints: [],
    speedtestUrl: null,
    promoCode: p.promoCode || null,
    priority: p.priority || 'normal',
    isSpecialOffer: true,
    isHidden: false,
    source: 'manual',
    locked: false,
  };
}

// 保留其他商家的现有产品（RackNerd/ZGO/ColoCrossing/GreenCloud）
const existingProducts = db.getAllProducts().filter(p =>
  !['bandwagonhost', 'dmit', 'cloudcone'].includes(p.provider)
);

const newBwh = bwhProducts.map(p => buildProduct(p, 'bandwagonhost', '搬瓦工', 'bandwagonhost.com', BWH_AFF));
const newDmit = dmitProducts.map(p => buildProduct(p, 'dmit', 'DMIT', 'www.dmit.io', DMIT_AFF));
const allProducts = [...newBwh, ...newDmit, ...existingProducts];

fs.writeFileSync('seed-products.json', JSON.stringify(allProducts), 'utf8');

console.log(`\n✅ seed-products.json 已重建`);
console.log(`   搬瓦工: ${newBwh.length} 个（对齐 bwgstock.com）`);
console.log(`   DMIT: ${newDmit.length} 个（对齐 dmitstock.com）`);
console.log(`   其他商家: ${existingProducts.length} 个（保留不动）`);
console.log(`   总计: ${allProducts.length} 个\n`);

console.log('搬瓦工:');
newBwh.forEach(p => console.log(`  ${p.name} | ${p.price} | pid=${p.checkUrl.match(/pid=(\d+)/)[1]}`));
console.log('\nDMIT:');
newDmit.forEach(p => console.log(`  ${p.name} | ${p.price} | pid=${p.checkUrl.match(/pid=(\d+)/)[1]}`));
console.log('\n其他:');
existingProducts.forEach(p => console.log(`  ${p.name} | ${p.price}`));
