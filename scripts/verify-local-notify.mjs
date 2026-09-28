// ═══════════════════════════════════════════════════════════
// 本地通知验收脚本（issue #41 期二）
// 打桩 Capacitor LocalNotifications 插件，断言：即时通知三条件门控
// （后台/开关/权限）、前台零打扰、预排占位窗口计算与覆盖重排、开关联动取消、
// 点通知深链（温启 + 冷启 pending 兜底）、权限拒绝降级零异常。
// 真机 Android 13+ 通知呈现留 owner（卡内既定分工）。
//
// 用法：node scripts/verify-local-notify.mjs
// ═══════════════════════════════════════════════════════════
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};
globalThis.window = globalThis;
globalThis.document = { addEventListener: () => {}, hidden: false };

// Capacitor + 插件桩
const lnCalls = { schedule: [], cancel: [], channels: [], listeners: [] };
let permission = 'granted';
globalThis.Capacitor = {
  isNativePlatform: () => true,
  Plugins: {
    LocalNotifications: {
      async requestPermissions() { return { display: permission }; },
      async checkPermissions() { return { display: permission }; },
      async schedule(o) { lnCalls.schedule.push(...o.notifications); },
      async cancel(o) { lnCalls.cancel.push(...o.notifications); },
      async createChannel(c) { lnCalls.channels.push(c); },
      async addListener(ev, fn) { lnCalls.listeners.push({ ev, fn }); },
    },
  },
};

(0, eval)(
  readFileSync(join(root, 'js/data.js'), 'utf8') + '\n' +
  readFileSync(join(root, 'js/version.js'), 'utf8') + '\n' +
  readFileSync(join(root, 'js/app.js'), 'utf8') + '\n;globalThis.__APP = App;'
);
const App = globalThis.__APP;
const elStub = () => ({ textContent: '', onclick: null, classList: { add() {}, remove() {}, toggle() {}, contains: () => true } });
App.el.toast = elStub(); App.el.sbNotifyMode = elStub();
App.state.customGfs = {};
App.state.enabledGfs = new Set(['wanwan']);
App.state.currentGf = 'wanwan';
App.switchGf = (id) => { App.state.currentGf = id; App._switched = (App._switched || []).concat(id); };

// ── 1) 即时通知门控：后台+开+权限三过才发；前台零打扰；关/无权限静默 ──
App.state.histories.wanwan = [
  { role: 'player', text: '早' },
  { role: 'gf', text: '早呀，花房刚开门，今天来了白色洋桔梗～' },
];
lnCalls.schedule.length = 0;
document.hidden = true;
await App.maybeNotifyProactive('wanwan');
assert.strictEqual(lnCalls.schedule.length, 1, '后台+开+有权限应发即时通知');
assert.strictEqual(lnCalls.schedule[0].title, '苏晚晚', '通知标题应为角色名');
assert.ok(lnCalls.schedule[0].body.includes('洋桔梗'), '通知内容应取首条气泡');
assert.strictEqual(lnCalls.schedule[0].extra.gfId, 'wanwan', '通知应带深链 gfId');
assert.strictEqual(lnCalls.schedule[0].channelId, 'proactive', '通知应走 proactive 渠道');

document.hidden = false; lnCalls.schedule.length = 0;
await App.maybeNotifyProactive('wanwan');
assert.strictEqual(lnCalls.schedule.length, 0, '前台聊天应零系统通知');

localStorage.setItem('aigf_notify_enabled', '0'); document.hidden = true;
await App.maybeNotifyProactive('wanwan');
assert.strictEqual(lnCalls.schedule.length, 0, '通知关：静默');

localStorage.setItem('aigf_notify_enabled', '1'); permission = 'denied';
await App.maybeNotifyProactive('wanwan');
assert.strictEqual(lnCalls.schedule.length, 0, '权限拒绝：降级静默零异常');
permission = 'granted';
console.log('✓ 即时通知：三条件门控 + 前台零打扰 + 关/拒绝降级');

// ── 2) 预排占位：下一窗口计算 + 固定 id 覆盖重排 + 开关联动取消 ──
localStorage.setItem('aigf_proactive', JSON.stringify({ enabled: true, gfs: {} }));
lnCalls.schedule.length = 0; lnCalls.cancel.length = 0;
await App.scheduleNextPlaceholder();
assert.strictEqual(lnCalls.schedule.length, 1, '应排一个占位通知');
const ph = lnCalls.schedule[0];
assert.strictEqual(ph.id, 41, '占位通知固定 id');
assert.strictEqual(ph.body, '想你了，来聊聊', '占位为无内容人设化提醒');
assert.ok(ph.schedule.at > new Date(Date.now() + 29 * 60e3), '占位时间应在 ≥30 分钟后');
assert.ok(ph.schedule.at < new Date(Date.now() + 26 * 3600e3), '占位时间应在下一窗口内（<26h）');
assert.strictEqual(ph.extra.gfId, 'wanwan', '占位应带当前角色深链');

// 未启用角色不排
App.state.currentGf = 'tangtang'; App.state.enabledGfs = new Set(['wanwan']);
lnCalls.schedule.length = 0;
await App.scheduleNextPlaceholder();
assert.strictEqual(lnCalls.schedule.length, 0, '未启用/不存在角色不排占位');
App.state.currentGf = 'wanwan'; App.state.enabledGfs = new Set(['wanwan', 'tangtang']);

// 主动消息总开关关闭 → toggleProactive 联动取消
lnCalls.cancel.length = 0;
App.toggleProactive();   // 开 → 关
assert.ok(lnCalls.cancel.some(n => n.id === 41), '关主动消息应取消占位');
assert.strictEqual(App.proactiveOn(), false);
console.log('✓ 预排占位：窗口计算 + 固定 id + 启用守卫 + 开关联动取消');

// ── 3) 深链：温启监听切换 + 冷启 pending 兜底 ──
localStorage.setItem('aigf_proactive', JSON.stringify({ enabled: true, gfs: {} }));
await App.initNotify();
assert.ok(lnCalls.channels.some(c => c.id === 'proactive' && c.visibility === 'private'), '应建 private 渠道');
assert.ok(lnCalls.listeners.some(l => l.ev === 'localNotificationActionPerformed'), '应挂点通知监听');

// 温启：ready 状态下点通知直接切会话
App.state.ready = true; App._switched = [];
const tap = lnCalls.listeners.find(l => l.ev === 'localNotificationActionPerformed').fn;
await tap({ notification: { extra: { gfId: 'tangtang' } } });
assert.deepStrictEqual(App._switched, ['tangtang'], '温启点通知应切到对应会话');
assert.strictEqual(localStorage.getItem(App.NOTIFY_PENDING_KEY), null, '温启消费后 pending 清空');

// 冷启兜底：pending 标记 → initNotify 消费切会话
localStorage.setItem(App.NOTIFY_PENDING_KEY, 'tangtang');
App.state.currentGf = 'wanwan';
await App.initNotify();
assert.strictEqual(App.state.currentGf, 'tangtang', '冷启 pending 应兜底切会话');
assert.strictEqual(localStorage.getItem(App.NOTIFY_PENDING_KEY), null, '消费后标记清除');
console.log('✓ 深链：温启监听直切 + 冷启 pending 兜底');

// ── 4) 开关 UI 与 Web 降级 ──
globalThis.Capacitor = undefined;   // Web 端无插件
App.state.ready = true;
await App.initNotify();   // 不应抛
localStorage.setItem('aigf_notify_enabled', '0');
await App.toggleNotify();
assert.strictEqual(localStorage.getItem('aigf_notify_enabled'), '1', 'Web 端开关仍可切换');
console.log('✓ Web 端：无插件零异常，开关可切换（不出系统通知）');

console.log('\n全部断言通过 —— issue #41 验收（脚本可复跑：node scripts/verify-local-notify.mjs）');
