// ═══════════════════════════════════════════════════════════
// 供应商多槽验收脚本（issue #50）
// 断言：旧单槽迁移无损、双槽列表渲染与命名、点击切换生效
// （callLLM 走 active 槽的 endpoint/key/model）、删生效槽回落、
// 侧栏状态行显示供应商名。
//
// 用法：node scripts/verify-provider-slots.mjs
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
globalThis.document = { addEventListener: () => {}, getElementById: () => null };
localStorage.setItem('deepseek_api_key', 'sk-official');

const calls = [];
const sseResp = () => {
  const enc = new TextEncoder();
  const chunks = [
    enc.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: '好' } }] })}\n\n`),
    enc.encode('data: [DONE]\n\n'),
  ];
  let i = 0;
  return { ok: true, body: { getReader: () => ({ read: async () => (i < chunks.length ? { done: false, value: chunks[i++] } : { done: true, value: undefined }) }) } };
};
globalThis.fetch = async (url, opts) => { calls.push({ url, body: opts ? JSON.parse(opts.body) : null, headers: opts ? opts.headers : null }); return sseResp(); };

(0, eval)(
  readFileSync(join(root, 'js/data.js'), 'utf8') + '\n' +
  readFileSync(join(root, 'js/version.js'), 'utf8') + '\n' +
  readFileSync(join(root, 'js/app.js'), 'utf8') + '\n;globalThis.__APP = App;'
);
const App = globalThis.__APP;

// DOM 桩（renderProviders 写 innerHTML；表单字段值可读写）
const mkField = () => ({ value: '', focus() {}, scrollIntoView() {} });
const hiddenSet = new Set();
App.el.providerList = { _html: '', set innerHTML(v) { this._html = v; }, get innerHTML() { return this._html; } };
App.el.providerAdd = mkField();
App.el.providerDel = { classList: { add: (c) => hiddenSet.add(c), remove: (c) => hiddenSet.delete(c), toggle: (c, f) => { f ? hiddenSet.add(c) : hiddenSet.delete(c); } } };
App.el.providerFormTitle = { textContent: '' };
App.el.customLlmForm = { classList: { add: (c) => hiddenSet.add(c), remove: (c) => hiddenSet.delete(c), toggle: (c, f) => { f ? hiddenSet.add(c) : hiddenSet.delete(c); } } };
App.el.customLlmName = mkField();
App.el.customLlmBase = mkField();
App.el.customLlmKey = mkField();
App.el.customLlmModel = mkField();
App.el.toast = { textContent: '', classList: { add() {}, remove() {}, toggle() {} } };
App.el.apiPanel = { classList: { add() {}, remove() {}, toggle() {} } };
App.el.apiStatusText = { textContent: '' };
App.el.thinkPill = { title: '', setAttribute() {}, classList: { add() {}, remove() {}, toggle() {} } };

// ── 1) 旧单槽迁移：数据无损进第一槽，active 跟随旧开关，旧键清除 ──
localStorage.setItem('aigf_custom_llm', JSON.stringify({ name: '', baseUrl: 'https://old.example.com', apiKey: 'old-key', model: 'old-model' }));
localStorage.setItem('aigf_use_custom_llm', '1');
const arr1 = App.loadCustomLlms();
assert.strictEqual(arr1.length, 1, '旧数据应迁为一个槽');
assert.strictEqual(arr1[0].baseUrl, 'https://old.example.com', 'baseUrl 无损迁移');
assert.strictEqual(arr1[0].apiKey, 'old-key', 'apiKey 无损迁移');
assert.strictEqual(arr1[0].model, 'old-model', 'model 无损迁移');
assert.strictEqual(App.customActiveId(), arr1[0].id, '旧开关=1 → active 指向第一槽');
assert.ok(!localStorage.getItem('aigf_custom_llm') && !localStorage.getItem('aigf_use_custom_llm'), '旧键应清除');
assert.ok(App.useCustomLlm(), 'useCustomLlm 语义：active 槽存在');
console.log('✓ 迁移：旧单槽数据无损入第一槽，active 跟随，旧键清除');

// ── 2) 双槽列表：备注名 + 缺省名，DeepSeek 内置行 ──
App.saveCustomLlms([
  { id: 's1', seq: 1, name: '公司网关', baseUrl: 'https://gw.corp.com', apiKey: 'k1', model: 'qwen-plus' },
  { id: 's2', seq: 2, name: '', baseUrl: 'https://open.example.com', apiKey: 'k2', model: 'gpt-4o-mini' },
]);
localStorage.setItem('aigf_custom_llm_active', '');
App.refreshCustomLlmUi();
const html = App.el.providerList.innerHTML;
for (const frag of ['DeepSeek', '公司网关', 'qwen-plus', '自定义供应商 2', 'gpt-4o-mini']) {
  assert.ok(html.includes(frag), `列表应含「${frag}」`);
}
console.log('✓ 列表：DeepSeek / 公司网关（备注名）/ 自定义供应商 2（缺省名）+ model 副标');

// ── 3) 切换生效：callLLM 走 active 槽的 endpoint/key/model；切回官方零残留 ──
App.state.histories.wanwan = [{ role: 'player', text: '在吗' }];
App.setProviderActive('s2');
assert.ok(App.useCustomLlm(), '选中 s2 后为自定义通道');
calls.length = 0;
await App.callLLM('p', 'wanwan', '在吗', null);
assert.strictEqual(calls[0].url, 'https://open.example.com/v1/chat/completions', 'endpoint 应取自 s2 槽');
assert.strictEqual(calls[0].headers.Authorization, 'Bearer k2', 'key 应取自 s2 槽');
assert.strictEqual(calls[0].body.model, 'gpt-4o-mini', 'model 应取自 s2 槽');

App.setProviderActive('');
assert.ok(!App.useCustomLlm(), '切回官方');
calls.length = 0;
await App.callLLM('p', 'wanwan', '在吗', null);
assert.ok(calls[0].url.includes('deepseek.com'), '官方通道 endpoint 零残留');
assert.strictEqual(calls[0].body.model, 'deepseek-flash', '官方通道 model 正常');
console.log('✓ 切换：s2 全链走槽配置（endpoint/key/model），切回 DeepSeek 零残留');

// ── 4) 删除生效槽：回落 DeepSeek + 状态行 + toast ──
App.setProviderActive('s1');
assert.ok(App.useCustomLlm());
App.deleteProvider('s1');
assert.ok(!App.useCustomLlm(), '删除生效槽应回落官方');
assert.strictEqual(App.loadCustomLlms().length, 1, '槽列表少一个');
App.updateApiStatus();
assert.ok(App.el.apiStatusText.textContent.includes('API Key 已配置'), '回落后状态行显示官方配置');

// 选中槽时状态行显示槽名
App.setProviderActive('s2');
App.updateApiStatus();
assert.ok(App.el.apiStatusText.textContent.includes('自定义供应商 2'), '状态行应显示生效槽名（缺省名）');
console.log('✓ 删除：生效槽删除回落 DeepSeek；状态行显示槽名/官方配置');

// ── 5) 编辑态表单：新增槽入列表、编辑既有槽更新 ──
App.state.editingProvider = 'new';
App.el.customLlmBase.value = 'https://third.example.com';
App.el.customLlmKey.value = 'k3';
App.el.customLlmModel.value = 'glm-4.7';
App.el.customLlmName.value = '';
App.el.apiKeyInput = { value: '' };
App.el.dashscopeKeyInput = { value: '' };
App.el.stepKeyInput = { value: '' };
App.handleApiKeySave();
const arr2 = App.loadCustomLlms();
assert.strictEqual(arr2.length, 2, '保存应新增一个槽');
const added = arr2.find(s => s.baseUrl === 'https://third.example.com');
assert.ok(added && added.apiKey === 'k3' && added.model === 'glm-4.7', '新槽字段完整');
assert.strictEqual(App.state.editingProvider, null, '保存后编辑态收起');
console.log('✓ 编辑表单：新增槽随「保存」入列表，编辑态收起');

console.log('\n全部断言通过 —— issue #50 验收（脚本可复跑：node scripts/verify-provider-slots.mjs）');
