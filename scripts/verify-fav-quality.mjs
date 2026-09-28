// ═══════════════════════════════════════════════════════════
// 喜好提取质量验收脚本（issue #32）
// 三层断言：① favSimilar 近重判定单元用例 ② 提取 prompt 排除规则/归因/evidence
// 进入请求 ③ 代码层守卫（用户原话拒收 + 近重不重复入库）在三条入库路径生效。
// LLM 语义层的坏例集批量抽检（假设句/第三人句由模型判定）留 owner 真机。
//
// 用法：node scripts/verify-fav-quality.mjs
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
let stubReply = '[]';
globalThis.fetch = async (url, opts) => { calls.push(JSON.parse(opts.body)); return sseResp(stubReply); };

(0, eval)(
  readFileSync(join(root, 'js/data.js'), 'utf8') + '\n' +
  readFileSync(join(root, 'js/app.js'), 'utf8') + '\n;globalThis.__APP = App;'
);
const App = globalThis.__APP;

// ── 1) favSimilar 近重判定单元用例 ──
assert.ok(App.favSimilar('喜欢旧书店', '爱逛旧书店'), '「喜欢旧书店」/「爱逛旧书店」应判近重（3/5）');
assert.ok(App.favSimilar('喜欢旧书店', '喜欢旧书'), '「喜欢旧书店」/「喜欢旧书」应判近重（3/3）');
assert.ok(!App.favSimilar('猫咪', '猫粮'), '「猫咪」/「猫粮」不应判重（1/2）');
assert.ok(!App.favSimilar('草莓蛋糕', '跑步'), '无关条目不应判重');
assert.ok(App.favSimilar('辣', '吃辣'), '短串包含应判重');
assert.ok(App.favSimilar('爵士乐', '爵士乐'), '全等判重');
console.log('✓ favSimilar：近重六例全符合预期（≥60% 字符重合）');

// ── 2) 提取 prompt：排除规则 + 归因 + evidence 进入请求 ──
App.state.histories.wanwan = [
  { role: 'player', text: '我喜欢吃辣' },
  { role: 'gf', text: '新到的洋桔梗很好看' },
  { role: 'player', text: '嗯嗯' },
  { role: 'gf', text: '喜欢' },
];
App.state.favs.wanwan = [];
calls.length = 0; stubReply = '[]';
await App.extractFavs('wanwan');
const favSys = calls[0].messages.find(m => typeof m.content === 'string' && m.content.includes('偏好记录员')).content;
assert.ok(favSys.includes('【归因判定'), '归因判定段缺失');
assert.ok(favSys.includes('【用户】开头是对方'), '归因标记说明缺失');
assert.ok(favSys.includes('绝不是她的'), '用户喜好排除指令缺失');
for (const rule of ['假设/条件句', '转述第三人', '单次行为', '问候客套']) {
  assert.ok(favSys.includes(rule), `排除规则「${rule}」缺失`);
}
assert.ok(favSys.includes('evidence'), 'evidence 依据要求缺失');
console.log('✓ 提取 prompt：归因判定 + 五类排除 + evidence 要求全部入 prompt');

// ── 3) 结构化 add：守卫三连（近重拒 / 用户原话拒 / 合法放行 + evidence 落条目）──
App.state.favs.wanwan = [{ id: 'f0', ts: 1, text: '喜欢旧书店', pinned: false, source: 'auto' }];
stubReply = JSON.stringify([
  { op: 'add', text: '爱逛旧书店', evidence: '爱逛旧书店' },        // 近重 → 拒
  { op: 'add', text: '吃辣', evidence: '我说过我喜欢吃辣' },        // 只出现在【用户】行 → 拒
  { op: 'add', text: '洋桔梗', evidence: '新到的洋桔梗很好看' },    // 合法 → 收
]);
await App.extractFavs('wanwan');
const texts = App.state.favs.wanwan.map(f => f.text);
assert.ok(!texts.includes('爱逛旧书店'), '近重复不应入库');
assert.ok(!texts.includes('吃辣'), '用户原话偏好应被归因守卫拒收');
assert.ok(texts.includes('洋桔梗'), '她的合法偏好应入库');
const ev = App.state.favs.wanwan.find(f => f.text === '洋桔梗').evidence;
assert.strictEqual(ev, '新到的洋桔梗很好看', 'evidence 应落条目');
console.log('✓ 结构化 add：近重拒收 + 用户原话拒收 + 合法入库带 evidence');

// ── 4) 旧行解析回退路径：守卫同样生效 ──
App.state.favs.wanwan = [];
stubReply = '- 吃辣\n- 爵士乐';   // 吃辣=用户原话拒；爵士乐=合法
await App.extractFavs('wanwan');
const legacyTexts = App.state.favs.wanwan.map(f => f.text);
assert.ok(!legacyTexts.includes('吃辣'), '旧路径用户原话应拒收');
assert.ok(legacyTexts.includes('爵士乐'), '旧路径合法条目应入库');
console.log('✓ 旧行解析回退：归因守卫生效');

// ── 5) stripFavTags：近重不重复入库 + 用户原话拒收 + 剥离仍干净 ──
App.state.favs.wanwan = [{ id: 'f9', ts: 1, text: '喜欢旧书店', pinned: false, source: 'auto' }];
const before = App.state.favs.wanwan.length;
const clean = App.stripFavTags('wanwan', '今天也是好天气【喜好：她喜欢旧书】对了【喜好：草莓味】晚安');
assert.strictEqual(before, 1, '近重「旧书」+ 用户原话「草莓味」均不应入库');
assert.strictEqual(clean, '今天也是好天气对了晚安', '标记应剥离干净');
console.log('✓ stripFavTags：内嵌标记路径守卫生效 + 剥离干净');

console.log('\n全部断言通过 —— issue #32 验收（脚本可复跑：node scripts/verify-fav-quality.mjs）');
