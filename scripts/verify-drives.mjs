// ═══════════════════════════════════════════════════════════
// 「她的状态」状态机验收脚本（issue #33）
// 加载真实 js/data.js + js/app.js（浏览器全局最小打桩），直接驱动
// App 状态机做事件序列走位断言，防止参数重校后各档不可达/回归。
//
// 用法：node scripts/verify-drives.mjs
// ═══════════════════════════════════════════════════════════
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

// ── 浏览器全局最小打桩：app.js 顶层只挂 DOMContentLoaded，方法内才用 localStorage ──
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};
globalThis.window = globalThis;
globalThis.document = { addEventListener: () => {} };

// eval 的顶层 const 声明不进全局词法环境，但同一次 eval 内互相可见——
// 把 data.js 与 app.js 拼进同一次 eval，尾部把引用挂回 globalThis 供本脚本使用。
const dataSrc = readFileSync(join(root, 'js/data.js'), 'utf8');
const appSrc = readFileSync(join(root, 'js/app.js'), 'utf8') + '\n;globalThis.__APP = App;globalThis.__GFS = GIRLFRIENDS;';
(0, eval)(dataSrc + '\n' + appSrc);
const GIRLFRIENDS = globalThis.__GFS;
const App = globalThis.__APP;

const IDS = Object.keys(GIRLFRIENDS);
assert.deepStrictEqual(IDS.sort(), ['jiangye', 'jiying', 'linle', 'ouyangyue', 'tangtang', 'wanwan'], '内置角色应为六位');

const T = (gfId) => App.drivesText(gfId).cls;
const reset = (gfId) => { localStorage.removeItem('aigf_drives_' + gfId); if (App.driveLabelCache) delete App.driveLabelCache[gfId]; };
const poke = (gfId, text) => { App.updateDrives(gfId, text); };   // 中性文本：仅作缓存失效 + 回稳锚点刷新
const setDrives = (gfId, d) => localStorage.setItem('aigf_drives_' + gfId, JSON.stringify({ lastTs: Date.now(), ...d }));

// ── 1) 五档全部真实可达：同类事件连续两轮即入档（issue #33 核心验收）──
// 事件序列 → 档位（各关键词族代表一个档）
const seqCases = [
  ['wanwan', ['今天好想你呀', '好爱你'], 'warm'],
  ['tangtang', ['最近好累啊', '压力好大，烦死了'], 'anxious'],
  ['jiying', ['这周要考试', '项目好多，忙翻了'], 'busy'],
  ['ouyangyue', ['我生气了', '不想理你了'], 'low'],
];
for (const [id, seq, want] of seqCases) {
  reset(id);
  for (const msg of seq) poke(id, msg);
  assert.strictEqual(T(id), want, `${id} 事件序列 [${seq}] 应入 ${want} 档`);
}
console.log('✓ 五档可达：想你×2→warm、难过×2→anxious、忙碌×2→busy、生气×2→low');

// 六角色全员 warm 可达（防个别角色数据破坏引擎）
for (const id of IDS) {
  reset(id);
  poke(id, '想你'); poke(id, '爱你');
  assert.strictEqual(T(id), 'warm', `${id} 想你×2 应入 warm 档`);
}
console.log('✓ 六角色全员事件走位一致');

// ── 2) 跨天回稳：48h 线性回稳——30h 后 warm 已出档但未全归基线 ──
reset('wanwan');
poke('wanwan', '想你'); poke('wanwan', '爱你');           // conn 71 → warm
setDrives('wanwan', { connection: 71, lastTs: Date.now() - 30 * 3600e3 });
if (App.driveLabelCache) delete App.driveLabelCache.wanwan;
assert.strictEqual(T('wanwan'), 'calm', '30h 后应回稳出 warm 档');
const conn = JSON.parse(localStorage.getItem('aigf_drives_wanwan')).connection;
assert.ok(conn > 55 && conn < 68, `30h 回稳应介于基线与阈值之间（实际 ${conn}）`);
console.log(`✓ 跨天回稳：30h 后 connection=${conn}（基线 55，阈值 68 之下）→ calm`);

// ── 3) 同会话稳定：缓存命中，连续两次合成不闪变 ──
reset('jiying');
const a1 = App.drivesText('jiying');
const a2 = App.drivesText('jiying');
assert.strictEqual(a1.label, a2.label, '同会话内两次合成应返回同一文案');
console.log(`✓ 会话内稳定：连续合成同为「${a1.label}」`);

// ── 4) 随机性：档内多轮合成（每轮以中性事件失效缓存）出现不同文案 ──
reset('jiangye');
const seen = new Set();
for (let i = 0; i < 30; i++) {
  poke('jiangye', '嗯');   // 中性：不改变档位，仅失效缓存
  seen.add(App.drivesText('jiangye').label);
}
assert.ok(seen.size >= 2, `同档 30 次合成应出现多种文案（实际 ${seen.size} 种）`);
console.log(`✓ 档内随机：30 次合成出现 ${seen.size} 种文案`);

// ── 5) 时间桶边界 + 档内时段过滤（打桩 Math.random 取「最后一条可选」验证）──
assert.strictEqual(App.statusTimeBucket(new Date(2026, 8, 28, 23, 30)), 'night');
assert.strictEqual(App.statusTimeBucket(new Date(2026, 8, 28, 4, 59)), 'night');
assert.strictEqual(App.statusTimeBucket(new Date(2026, 8, 28, 5, 0)), 'morning');
assert.strictEqual(App.statusTimeBucket(new Date(2026, 8, 28, 9, 0)), 'day');
assert.strictEqual(App.statusTimeBucket(new Date(2026, 8, 28, 18, 0)), 'evening');
console.log('✓ 时间桶边界：23-5 夜 / 5-9 晨 / 9-18 昼 / 18-23 晚');

const realRandom = Math.random;
const realBucket = App.statusTimeBucket;
Math.random = () => 0.999999;   // 恒取「最后一条可选文案」
reset('wanwan');
setDrives('wanwan', { connection: 55, mood: 70, anxiety: 50, busy: 35 });   // anxious 档（四轴须齐全，缺轴会被 loadDrives 拒收）
poke('wanwan', '嗯');
// wanwan.anxious = ['有点担心你', '你那边下雨了吗', { t: 'night', s: '这么晚了，你怎么还不睡' }]
App.statusTimeBucket = () => 'day';
assert.strictEqual(App.drivesText('wanwan').label, '你那边下雨了吗', '白天应滤掉 night 专属文案');
App.statusTimeBucket = () => 'night';
if (App.driveLabelCache) delete App.driveLabelCache.wanwan;
assert.strictEqual(App.drivesText('wanwan').label, '这么晚了，你怎么还不睡', '深夜应可选 night 专属文案');
App.statusTimeBucket = realBucket;
Math.random = realRandom;
console.log('✓ 时段过滤：day 桶排除 night 专属文案，night 桶可选 night 专属文案');

// ── 6) 六角色池完整性 + 个性差异；自建角色回落默认池 ──
const BUCKETS = ['night', 'morning', 'day', 'evening'];
for (const id of IDS) {
  const pool = GIRLFRIENDS[id].profile.statusPool;
  assert.ok(pool, `${id} 缺 statusPool`);
  for (const tier of ['calm', 'warm', 'low', 'anxious', 'busy']) {
    const entries = pool[tier];
    assert.ok(Array.isArray(entries) && entries.length >= 3, `${id}.${tier} 文案应 ≥3 条`);
    for (const e of entries) {
      if (typeof e === 'string') continue;
      assert.ok(BUCKETS.includes(e.t) && typeof e.s === 'string' && e.s, `${id}.${tier} 时段条目非法`);
    }
  }
  assert.notStrictEqual(JSON.stringify(pool), JSON.stringify(App.STATUS_POOL_DEFAULT), `${id} 文案池应与默认池有个性差异`);
}
console.log('✓ 六角色：五档池齐全、条目合法、与默认池有个性差异');

App.state.customGfs = Object.assign({}, App.state.customGfs, {
  custom_test: { id: 'custom_test', name: '测试角色', prompt: 'x' },
});
const cpool = new Set();
for (let i = 0; i < 10; i++) {
  poke('custom_test', '嗯');
  cpool.add(App.drivesText('custom_test').label);
}
assert.ok([...cpool].every(l => Object.values(App.STATUS_POOL_DEFAULT).flat().some(e => (typeof e === 'string' ? e : e.s) === l)), '自建角色应回落默认池');
console.log('✓ 自建角色：无池回落默认池可用');

console.log('\n全部断言通过 —— issue #33 验收（脚本可复跑：node scripts/verify-drives.mjs）');
