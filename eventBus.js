/**
 * 事件总线 (Event Bus)
 * 用于解耦 scraper.js 和 tgBot.js 之间的循环依赖。
 *
 * 之前的循环依赖链：
 *   scraper.js → import { notifyStockChange } from './tgBot.js'
 *   tgBot.js   → import { catalog, stockState } from './scraper.js'
 *
 * 解决方案：
 *   scraper.js 发出事件 → eventBus
 *   tgBot.js 订阅事件 ← eventBus
 *   两者都只依赖 eventBus，不互相依赖。
 */

import { EventEmitter } from 'events';

const eventBus = new EventEmitter();
// 防止大量监控产品触发 MaxListenersExceededWarning
eventBus.setMaxListeners(50);

export default eventBus;
