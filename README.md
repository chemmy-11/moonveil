# 🌙 月见 Moonveil — DeepSeek 角色扮演与情感陪伴实验场

> **一个用真实对话优化 DeepSeek 角色扮演与情感陪伴能力的实验项目** — 纯前端 + Capacitor Android 打包

三位性格截然不同的 AI 女友是三个长期测试角色：借由她们与玩家的真实对话，反复打磨 System Prompt 体系，验证模型在情感陪伴场景下的表现，并系统性地挖掘、记录、修复 Badcase。

## 🎯 项目目标

1. **优化 DeepSeek 模型在角色扮演与情感陪伴场景下的能力**，提升互动体验的真实感与沉浸度——通过分层人格（Layer 0-5）、结构化共同记忆、消息节奏控制、记忆沉淀机制等手段，让对话"像真人"而不是"像 AI"。
2. **深入挖掘角色扮演与情感陪伴场景中的 Badcase**——人设漂移、记忆错误、语气失真、节奏崩坏、AI 腔、越界内容等，逐条记录到各角色的 Correction 层并驱动 prompt 迭代，形成可复用的修复经验。

## 👩 三位测试角色

| 角色 | 类型 | 主题色 | 简介 |
|------|------|--------|------|
| **苏晚晚** | 温柔治愈 | 粉 `#D993B4` | 花店店主，轻声细语，记得你说过的每一件小事 |
| **白凛** | 傲娇毒舌 | 紫 `#A292D9` | 独立游戏开发者，嘴硬心软，关心全藏在嫌弃里 |
| **唐糖** | 元气活泼 | 杏橙 `#E0B06C` | 烘焙学徒，话痨 + emoji 轰炸，直球表达喜欢 |

人设与开场白在 `js/data.js`，记忆与人格源文件在 `personas/`。

## ✨ 功能

- **三个独立会话** — 每位角色独立的聊天历史（localStorage 持久化，重开不丢）
- **AI 实时对话** — DeepSeek API 直连，每人独立 System Prompt（人设 + 记忆 + 说话风格）
- **微信式气泡 UI** — 雾面毛玻璃 + 壁纸背景，三主题（珍珠潮汐 / 海港 / 星河）
- **消息节奏控制** — 流式输出 + 智能拆条 + 气泡延迟队列（微信连发感），可打断
- **记忆自动沉淀** — 「她的喜好」随对话自然提取；「我们的回忆」低频严格盘点，只记重要时刻
- **打字指示器 + 发送音效** — 真实聊天感
- **移动端适配** — 底部导航三 tab 切换角色，键盘顶起完美适配（原生 insets）
- **双端运行** — 浏览器直接玩 / Android APK

## 🚀 快速开始

### Web 端

```bash
cd AI-GF
python -m http.server 8080    # 或任意静态服务器
```

浏览器打开 `http://localhost:8080`，首次启动输入 DeepSeek API Key 即可开始。

> ⚠️ 直接双击 `index.html` 可能因浏览器 CORS 限制无法调用 API，推荐本地服务器方式。

### Android APK

```bash
bash scripts/build.sh    # 一键构建（同步 www → cap copy → gradle → md5 验证）
```

产物：`AI-GF.apk`

## 📁 项目结构

```
AI-GF/
├── index.html              # 主入口 — 聊天 UI
├── css/
│   ├── style.css           # 桌面端：毛玻璃三主题 + 三角色主题色
│   └── mobile.css          # 移动端：底部导航 + 键盘 insets 适配
├── js/
│   ├── data.js             # 三角色 System Prompt + LLM 配置（与 personas/ 同步）
│   ├── app.js              # 聊天引擎：对话/持久化/记忆提取/主题/音效/更新
│   └── version.js          # 版本号
├── personas/               # 三角色的记忆与人格源文件（共同记忆 + 分层人格）
│   ├── su-wanwan.md        #   苏晚晚（温柔治愈）
│   ├── bai-linlin.md       #   白凛（傲娇毒舌）
│   └── tang-tangtang.md    #   唐糖（元气活泼）
├── assets/                 # 素材（壁纸/头像/音效/图标）
├── android/                # Capacitor Android 工程（含键盘 insets 原生注入）
├── scripts/
│   ├── build.sh            # 一键构建 APK（含 md5 校验 + 版本一致性校验）
│   └── generate-starry.py  # 「星河」主题星空壁纸生成器（固定种子可复现）
└── capacitor.config.json
```

## 🧠 人设体系（角色扮演的核心资产）

每位角色的记忆与人格源文件在 `personas/` 目录（三份 md）：

- **PART A 共同记忆**：关系概览、重要时刻、日常与仪式、偏好、情感模式、亲密与陪伴、记忆使用说明
- **PART B 人物性格**：Layer 0 核心性格（最高优先级）→ Layer 5 边界雷区，逐层定义；Layer 0 永远优先，任何情况下不得违背
- **Correction 记录**：Badcase 沉淀层——把角色犯过的错记在这里，防止重犯

修改 `personas/` 后需同步更新 `js/data.js` 中对应角色的 `prompt` 字段（那是实际发给 LLM 的 System Prompt）。

## 🔍 Badcase 挖掘与沉淀

Badcase 挖掘是本项目的核心工作之一。工作流：

1. **真实对话中发现** — 在日常聊天中留意：人设漂移（说了不像她的话）、记忆错误（张冠李戴）、语气失真（突然变 AI 腔/总结腔）、节奏崩坏（一口气说完所有话）、越界内容
2. **记录到 Correction 层** — 把具体表现 + 期望行为写进对应角色 `personas/*.md` 的 `## Correction 记录`，并同步到 `js/data.js`
3. **驱动 prompt 迭代** — 反复出现的同类问题，升级为 Layer 规则（如「严禁 AI 腔」已写入 Layer 2）；单点问题留在 Correction 层
4. **回归验证** — 用同类话题重测，确认修复生效后保留记录作为回归基线

已知的经验性规则（沉淀在 prompt 中）：严禁 AI 腔与总结句式、消息必须推进不复述、短句节奏、绝不输出露骨成人内容（公开版本硬约束）、思考模型辅助调用需走流式（非流式 content 可能为空）等。

## 🛠 自定义

### 换人设
见「人设体系」一节。换头像：每位角色的 `avatar` 字段指向图片路径。换模型：`js/data.js` 底部 `LLM_CONFIG`（支持任何 OpenAI 兼容 API）。

## 🧠 技术架构

```
玩家输入 → 聊天引擎（app.js）
              │
              ├─ 组装 System Prompt（角色人设 + 最近 10 轮对话历史）
              ├─ 调用 DeepSeek API（localStorage 读取用户 API Key）
              ├─ 流式回复 → 智能拆条 → 气泡延迟队列上屏
              ├─ 历史持久化（localStorage）
              └─ 记忆沉淀：喜好提取（每轮）/ 回忆盘点（低频严格）
```

- **前端**：原生 HTML/CSS/JS，零依赖、零构建（本地服务器即可运行）
- **AI 引擎**：DeepSeek Chat API，OpenAI 兼容协议，SSE 流式
- **记忆提取**：辅助调用与主回复同走 SSE 流式（思考模型的非流式响应 content 可能为空）
- **Android**：Capacitor 打包，原生 insets 键盘适配（物理像素 ÷ density 注入 CSS 变量）
- **架构参考**：[HELIOS](https://github.com/chemmy-11/helios)（AI 叙事推理游戏）的对话引擎与移动端适配方案

## 📄 许可证

MIT
