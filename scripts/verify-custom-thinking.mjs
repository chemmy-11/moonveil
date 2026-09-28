// ═══════════════════════════════════════════════════════════
// 自定义供应商深度思考 + 独白协议验收脚本（issue #49）
// 打桩 fetch 捕获请求体，断言四态矩阵：
// 官方/自定义 × 思考开/关 —— thinking 字段组装、独白协议注入、
// pill 可切换（无 locked）、title 双态。
//
// 用法：node scripts/verify-custom-thinking.mjs
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
globalThis.document = { addEventListener: () => {} };
localStorage.setItem('deepseek_api_key', 'sk-test-only');

const sseResp = (text) => {
  const enc = new TextEncoder();
  const chunks = [
    enc.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`),
    enc.encode('data: [DONE]\n\n'),
  ];
  let i = 0;
  return {
    ok: true,
    body: { getReader: () => ({ read: async () => (i < chunks.length ? { done: false, value: chunks[i++] } : { done: true, value: undefined }) }) },
  };
};
const calls = [];
globalThis.fetch = async (url, opts) => { calls.push({ url, body: JSON.parse(opts.body) }); return sseResp('好'); };

(0, eval)(
  readFileSync(join(root, 'js/data.js'), 'utf8') + '\n' +
  readFileSync(join(root, 'js/version.js'), 'utf8') + '\n' +
  readFileSync(join(root, 'js/app.js'), 'utf8') + '\n;globalThis.__APP = App;globalThis.__CFG = LLM_CONFIG;'
);
const App = globalThis.__APP;
const LLM_CONFIG = globalThis.__CFG;

// pill DOM 桩
const pillClasses = new Set();
App.el.thinkPill = {
  title: '', setAttribute() {},
  classList: { add: (c) => pillClasses.add(c), remove: (c) => pillClasses.delete(c), toggle: (c, f) => { f ? pillClasses.add(c) : pillClasses.delete(c); }, contains: (c) => pillClasses.has(c) },
};
App.el.toast = { textContent: '', classList: { add() {}, remove() {}, toggle() {} } };

// 多槽存储模型（issue #50 落地后）：active 槽 id 控制通道
const setCustom = (on) => {
  localStorage.setItem('aigf_custom_llms', JSON.stringify([{ id: 't1', seq: 1, name: '测试网关', baseUrl: 'https://gw.example.com/v1', apiKey: 'gw-key', model: 'some-model' }]));
  localStorage.setItem('aigf_custom_llm_active', on ? 't1' : '');
};
const setThinking = (on) => localStorage.setItem('aigf_deep_thinking', on ? '1' : '0');
const runCall = async () => {
  App.state.histories.wanwan = [{ role: 'player', text: '在吗' }];
  calls.length = 0;
  await App.callLLM('prompt', 'wanwan', '在吗', null);
  return calls[calls.length - 1].body;
};
const hasInnerProto = (body) => body.messages.some(m => typeof m.content === 'string' && m.content.includes('【内心独白】'));

// ── 1) 自定义通道 × 思考开：enabled + effort high + 独白协议注入 ──
setCustom(true); setThinking(true);
let body = await runCall();
assert.deepStrictEqual(body.thinking, { type: 'enabled' }, '自定义开态应发 thinking enabled');
assert.strictEqual(body.reasoning_effort, 'high', '自定义开态 effort 固定 high');
assert.strictEqual(body.model, 'some-model', '自定义通道走自定义 model');
assert.ok(body.messages.every(m => typeof m.content !== 'string' || !m.content.includes('思考深度')), '占位防误断言');
assert.ok(hasInnerProto(body), '自定义通道开态应注入独白协议（issue #49 核心修复）');

// ── 2) 自定义通道 × 思考关：不发任何 thinking 字段 + 无独白协议 ──
setThinking(false);
body = await runCall();
assert.ok(!('thinking' in body), '自定义关态应完全不发 thinking 字段');
assert.ok(!('reasoning_effort' in body), '自定义关态应完全不发 reasoning_effort');
assert.ok(!hasInnerProto(body), '思考关闭时无独白协议（与官方通道语义一致）');

// ── 3) 官方通道 × 思考开：与现状逐字段一致 + 独白协议在 ──
setCustom(false); setThinking(true);
body = await runCall();
assert.deepStrictEqual(body.thinking, LLM_CONFIG.thinking, '官方开态 thinking 与 LLM_CONFIG 一致');
assert.strictEqual(body.reasoning_effort, LLM_CONFIG.reasoning_effort, '官方开态 effort 与 LLM_CONFIG 一致');
assert.ok(hasInnerProto(body), '官方开态独白协议不回归');

// ── 4) 官方通道 × 思考关：显式 disabled ──
setThinking(false);
body = await runCall();
assert.deepStrictEqual(body.thinking, { type: 'disabled' }, '官方关态显式 disabled（现状保持）');
assert.ok(!('reasoning_effort' in body), '官方关态不发 effort');
console.log('✓ 四态矩阵：自定义开(enabled+high+独白) / 自定义关(不发+无独白) / 官方开(现状) / 官方关(disabled)');

// ── 5) pill 行为：自定义模式下可切换、无 locked、title 双态 ──
setCustom(true); setThinking(true);
App.toggleThinking();   // 自定义下关
assert.strictEqual(localStorage.getItem('aigf_deep_thinking'), '0', '自定义模式下开关应可切换（守卫已删）');
App.refreshThinkUi();
assert.ok(!pillClasses.has('locked'), 'pill 不应再有 locked 态');
assert.ok(App.el.thinkPill.title.includes('自定义供应商'), '自定义模式下 pill title 应说明两态语义');
setCustom(false);
App.refreshThinkUi();
assert.ok(!App.el.thinkPill.title.includes('自定义供应商'), '官方通道 title 应为常规文案');
console.log('✓ pill：自定义下可切换、无置灰、title 双态说明');

console.log('\n全部断言通过 —— issue #49 验收（脚本可复跑：node scripts/verify-custom-thinking.mjs）');
