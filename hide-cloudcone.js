import db from './db.js';

const count = db.updateProductsByProvider('cloudcone', { isHidden: true });
console.log(`[Hide CloudCone] 已隐藏 ${count} 个 CloudCone 产品`);
