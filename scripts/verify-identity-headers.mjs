// ═══════════════════════════════════════════════════════════
// LLM 上下文隐藏身份头验收脚本（issue #25）
// 打桩 fetch 捕获请求体，断言：主对话历史双侧【】头 + 防模仿句 +
// 当前消息不加头（主动消息/搜索块兼容）+ hist 零污染 + 提取路径同格式。
//
// 用法：node scripts/verify-identity-headers.mjs
// ═══════════════════════════════════════════════════════════
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

// ── 浏览器全局最小打桩 ──
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};
globalThis.window = globalThis;
globalThis.document = { addEventListener: () => {} };
localStorage.setItem('deepseek_api_key', 'sk-test-only');

// SSE 响应桩：返回单段 content 后 [DONE]
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
globalThis.fetch = async (url, opts) => {
  calls.push(JSON.parse(opts.body));
  return sseResp(stubReply);
};

// 同一次 eval 加载两份源（顶层 const 互相可见），尾部挂出 App
(0, eval)(
  readFileSync(join(root, 'js/data.js'), 'utf8') + '\n' +
  readFileSync(join(root, 'js/app.js'), 'utf8') + '\n;globalThis.__APP = App;globalThis.__GFS = GIRLFRIENDS;'
);
const App = globalThis.__APP;
const GIRLFRIENDS = globalThis.__GFS;

// ── 1) callLLM 主对话组装 ──
App.state.histories.wanwan = [
  { role: 'player', text: '我喜欢吃辣' },
  { role: 'gf', text: '真的吗？我不太能吃辣诶' },
  { role: 'player', text: '今天路过那家店', quote: '【引用记忆 · 旧书店】\n你们爱逛旧书店' },
  { role: 'gf', text: '嗯嗯，改天再去' },
  { role: 'player', text: '你看这张图', img: 'data:image/png;base64,AAAA' },
  { role: 'gf', text: '好看～' },
  { role: 'player', text: '当前这条是新消息' },   // 当前消息（组装时剔除后末尾显式追加）
];
stubReply = '收到';
calls.length = 0;
const reply = await App.callLLM(GIRLFRIENDS.wanwan.prompt, 'wanwan', '当前这条是新消息', null);
assert.strictEqual(reply, '收到');

const main = calls.find(c => c.messages.length > 3);   // 主对话（含 system+历史+运行时+当前），提取调用只有 2 条 messages
assert.ok(main, '应捕获主对话请求');
const sysMsgs = main.messages.filter(m => m.role === 'system');
const userMsgs = main.messages.filter(m => m.role === 'user');
const asstMsgs = main.messages.filter(m => m.role === 'assistant');

// 历史用户消息：全部以【用户】开头（含引用块与降级图占位形态）
const histUsers = userMsgs.filter(m => m !== userMsgs[userMsgs.length - 1]);
assert.strictEqual(histUsers.length, 3, '历史 user 消息应为 3 条');
for (const m of histUsers) {
  const t = typeof m.content === 'string' ? m.content : m.content[0].text;
  assert.ok(t.startsWith('【用户】'), `历史用户消息应带【用户】头：${t.slice(0, 24)}`);
}
// 引用块消息：头在最前，引用块随后
const quoteMsg = histUsers.find(m => (typeof m.content === 'string' ? m.content : m.content[0].text).includes('引用记忆'));
assert.ok(quoteMsg && (typeof quoteMsg.content === 'string' ? quoteMsg.content : quoteMsg.content[0].text).startsWith('【用户】【引用记忆'), '引用块消息头序应为【用户】【引用记忆…');
// 带图消息：多模态数组 text 部分带头
const imgMsg = histUsers.find(m => Array.isArray(m.content));
assert.ok(imgMsg && imgMsg.content[0].text.startsWith('【用户】') && imgMsg.content[1].type === 'image_url', '多模态历史 text 部分应带头');

// 历史角色消息：以【苏晚晚】开头
assert.strictEqual(asstMsgs.length, 3);
for (const m of asstMsgs) assert.ok(m.content.startsWith('【苏晚晚】'), `角色消息应带【苏晚晚】头：${m.content.slice(0, 20)}`);

// 当前消息：不加头（主动消息节律指令/搜索块已有自己的标记体系，避免语义冲突）
assert.strictEqual(userMsgs[userMsgs.length - 1].content, '当前这条是新消息', '当前消息不应加头');

// 运行时 system：防模仿句 + 双侧标记名
const runtime = sysMsgs.find(m => m.content.includes('运行时上下文'));
assert.ok(runtime, '应有运行时上下文 system');
assert.ok(runtime.content.includes('仅供你分辨说话人'), '防模仿句（分辨说话人）缺失');
assert.ok(runtime.content.includes('绝不把用户说的话当成自己说的'), '归因指令缺失');
assert.ok(runtime.content.includes('【用户】/【苏晚晚】'), '标记名说明缺失');
assert.ok(runtime.content.includes('绝不在你的回复中复现'), '禁止复现指令缺失');

// hist 零污染：组装后历史原文不含标记（标记只存在于请求体）
const polluted = App.state.histories.wanwan.filter(m => m.text.includes('【用户】') || m.text.includes('【苏晚晚】'));
assert.strictEqual(polluted.length, 0, 'hist 存储不得被写入标记');
console.log('✓ callLLM：历史双侧【】头 + 引用/多模态形态 + 防模仿句 + 当前消息零加头 + hist 零污染');

// ── 2) 提取路径同格式（extractFavs 的 recent 组装）──
calls.length = 0;
stubReply = '[]';
App.state.favs.wanwan = [];
await App.extractFavs('wanwan');
const favCall = calls.find(c => c.messages.some(m => typeof m.content === 'string' && m.content.includes('偏好记录员')));
assert.ok(favCall, '应捕获喜好提取调用');
const favUser = favCall.messages.find(m => m.role === 'user').content;
assert.ok(favUser.includes('【用户】我喜欢吃辣'), '提取材料应带【用户】头');
assert.ok(favUser.includes('【苏晚晚】真的吗'), '提取材料应带【角色名】头');
console.log('✓ extractFavs：提取材料身份头与主对话同格式');

// ── 3) 自建角色名入头 ──
App.state.customGfs = { custom_x: { id: 'custom_x', name: '阿澈', prompt: '你是阿澈。' } };
App.state.histories.custom_x = [
  { role: 'player', text: '在忙吗' },
  { role: 'gf', text: '刚下班' },
  { role: 'player', text: '晚上吃啥' },
];
calls.length = 0;
stubReply = '嗯';
await App.callLLM('你是阿澈。', 'custom_x', '晚上吃啥', null);
const customCall = calls.find(c => c.messages.some(m => m.role === 'assistant' && typeof m.content === 'string' && m.content.startsWith('【阿澈】')));
assert.ok(customCall, '自建角色历史应带【角色名】头');
const customRuntime = customCall.messages.find(m => typeof m.content === 'string' && m.content.includes('【用户】/【阿澈】'));
assert.ok(customRuntime, '自建角色防模仿句应含其名');
console.log('✓ 自建角色：名字正确入头（含防模仿句）');

console.log('\n全部断言通过 —— issue #25 验收（脚本可复跑：node scripts/verify-identity-headers.mjs）');
