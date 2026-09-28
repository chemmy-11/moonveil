// ═══════════════════════════════════════════════════════════
// 自动检查更新验收脚本（issue #26）
// 打桩 fetch + 最小 DOM 桩，断言：启动触发/24h 节流/会话一次/判定矩阵
// （新版提示·同版静默·回退静默·失败静默）/toast 点击进弹窗/手动入口不回归。
//
// 用法：node scripts/verify-auto-update.mjs
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
globalThis.document = { addEventListener: () => {}, getElementById: () => ({ disabled: false, style: {} }) };

let fetchCount = 0;
let latestVer = '0.4.2';
let fetchFail = false;
globalThis.fetch = async (url) => {
  fetchCount++;
  if (fetchFail) throw new TypeError('network down');
  return { ok: true, json: async () => ({ version: latestVer, notes: 'v' + latestVer + '\n- 测试内容', apk_url: 'https://x/AI-GF-' + latestVer + '.apk' }) };
};

(0, eval)(
  readFileSync(join(root, 'js/data.js'), 'utf8') + '\n' +
  readFileSync(join(root, 'js/version.js'), 'utf8') + '\n' +
  readFileSync(join(root, 'js/app.js'), 'utf8') + '\n;globalThis.__APP = App;'
);
const App = globalThis.__APP;

// DOM 桩：toast + 更新弹窗元素
const mkEl = () => ({
  textContent: '', hidden: true, onclick: null,
  dataset: {},
  classList: { _s: new Set(), add(c) { this._s.add(c); }, remove(c) { this._s.delete(c); }, toggle(c, f) { f ? this._s.add(c) : this._s.delete(c); }, contains(c) { return this._s.has(c); } },
});
App.el.toast = mkEl();
App.el.updateDesc = mkEl();
App.el.updateDownloadBtn = mkEl();
App.el.updateProgress = mkEl();
App.el.updateOverlay = mkEl();
App.el.updateModal = mkEl();
const toastVisible = () => !App.el.toast.classList.contains('hidden');

// ── 1) 判定矩阵：新版提示 / 同版静默 / 回退静默 / 失败静默 ──
// 当前 APP_VERSION 来自 js/version.js（v0.4.2）
latestVer = '0.4.3'; fetchCount = 0;
await App.autoCheckUpdate(true);
assert.ok(fetchCount === 1 && toastVisible(), '有新版：应拉一次并出轻提示');
assert.ok(App.el.toast.textContent.includes('0.4.3') && App.el.toast.onclick, '提示应含版本号且可点击');
assert.strictEqual(App.state.autoUpdateNotified, true, '会话内应记录已提示');

// 会话一次：再触发（含启动路径）不再拉取
fetchCount = 0;
await App.autoCheckUpdate(true);
assert.strictEqual(fetchCount, 0, '同会话第二次不再拉取/提示');

// toast 点击 → 更新弹窗打开（先捕获 handler 再复位 toast 可见态）
const clickHandler = App.el.toast.onclick;
assert.strictEqual(typeof clickHandler, 'function', '提示应已挂点击回调');
App.el.toast.classList.add('hidden');
clickHandler();
assert.ok(!App.el.updateOverlay.classList.contains('hidden'), '点提示应打开更新弹窗');
assert.ok(App.el.updateDesc.textContent.includes('0.4.3'), '弹窗应含新版本号与说明');
assert.ok(App.el.updateDownloadBtn.dataset.url.includes('0.4.3'), '下载键应带新版 apk_url');
App.el.toast.classList.add('hidden');   // 复位可见态（clickHandler 内部 this.toast() 会短暂重现）

// 同版：静默
App.state.autoUpdateNotified = false; localStorage.removeItem('aigf_last_update_check');
latestVer = App.__curVer || '0.4.2'; fetchCount = 0;
await App.autoCheckUpdate(true);
assert.ok(fetchCount === 1 && !toastVisible(), '同版：拉取一次但零提示');

// 回退（远端版本更旧）：静默
App.state.autoUpdateNotified = false; localStorage.removeItem('aigf_last_update_check');
latestVer = '0.4.1'; fetchCount = 0;
await App.autoCheckUpdate(true);
assert.ok(fetchCount === 1 && !toastVisible(), '版本回退：零提示');

// 失败：静默不抛
App.state.autoUpdateNotified = false; localStorage.removeItem('aigf_last_update_check');
fetchFail = true; fetchCount = 0;
await App.autoCheckUpdate(true);
assert.ok(fetchCount >= 1 && !toastVisible(), '网络失败：零提示零异常（API 源失败会回退 raw 源再试一次，属双源设计）');
fetchFail = false;
console.log('✓ 判定矩阵：新版提示(可点击) / 会话一次 / 同版·回退·失败全静默');

// ── 2) 24h 节流：非启动路径距上次检查 <24h 不拉取；≥24h 拉取 ──
App.state.autoUpdateNotified = false;
localStorage.setItem('aigf_last_update_check', String(Date.now() - 3600e3));   // 1h 前
fetchCount = 0;
await App.autoCheckUpdate(false);
assert.strictEqual(fetchCount, 0, '1h 前查过：非启动路径应节流跳过');

localStorage.setItem('aigf_last_update_check', String(Date.now() - 25 * 3600e3));   // 25h 前
latestVer = '0.4.3';
await App.autoCheckUpdate(false);
assert.strictEqual(fetchCount, 1, '25h 前查过：应真查');
console.log('✓ 24h 节流：<24h 跳过、≥24h 真查');

// ── 3) 手动入口不回归：仍是最新版时 toast「已是最新」 ──
App.state.autoUpdateNotified = false;
latestVer = '0.4.2';   // 同版
await App.checkUpdate();
await new Promise(r => setTimeout(r, 50));   // checkUpdate 是 fire-and-forget 链，等一拍再断言
assert.ok(App.el.toast.textContent.includes('已是最新'), '手动入口同版应提示已是最新');
console.log('✓ 手动入口回归：同版「已是最新」、新版走弹窗（共用 showUpdateModal）');

console.log('\n全部断言通过 —— issue #26 验收（脚本可复跑：node scripts/verify-auto-update.mjs）');
