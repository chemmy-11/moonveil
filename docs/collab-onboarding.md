# 月见 · 新成员协作入门

> 写给即将加入开发组的新成员 · 2026-09-28（定位与进度口径对齐现行）
> 读完后你应该能：把项目跑起来 → 看懂当前进度 → 用 GitHub + agent 工具走完一次完整的「领任务 → 提 PR」。

---

## 一、项目是什么

**月见（Moonveil）** 是一个运行在自己设备上的 AI 陪伴聊天应用（DeepSeek 驱动）：六位内置 AI 角色（苏晚晚 / 唐苓 / 季萤 / 欧阳越 / 江野 / 林乐，可在「角色库」启停）+ 自建角色，微信式聊天 UI，带人格系统、记忆体系、消息节奏控制。纯前端（原生 HTML/CSS/JS，无框架）+ Capacitor 打包 Android APK。

**三条设计原则**（做任何功能前先读一遍）：

1. **真实感优先** —— 每个功能都在为「像真人」服务：人格分层、记忆沉淀、消息连发节奏、字迹感
2. **问题驱动迭代** —— 日常对话暴露问题（人设漂移、记忆错乱）→ 记录 → 修复 → 回归，形成闭环
3. **记忆是核心资产** —— 回忆卡/喜好卡/相处习惯 = 角色的灵魂，动记忆相关代码要格外小心（向后兼容 localStorage 旧数据）

详细方向与里程碑：`docs/roadmap.md`（单一事实源）。

### 当前进度速览

- **已走完的主线与里程碑**：以 `docs/roadmap.md` 第一节里程碑表为单一事实源（本文件不再维护清单，避免过时）
- **进行中**：以 [GitHub Issues 页](https://github.com/chemmy-11/moonveil/issues) 为准（open 状态的卡就是当前待办）
- **规划中**：游戏内容方向 G1-G4（关系阶段系统 / 随机生活事件 / 记忆驱动剧情回调 / 成就收集），见 roadmap 第三节

## 二、开始之前（owner 侧准备 + 你的账号）

**Owner（仓库主）要做**：GitHub 仓库页 → Settings → Collaborators → 邀请对方的 GitHub 账号；对方接受邮件邀请。

**你要准备**：

1. 一个 GitHub 账号（注册免费），把用户名发给 owner 等邀请
2. 本机装好：**Git**（git-scm.com）+ **Node.js ≥ 18**（nodejs.org），会命令行最好，不会也可以走 agent / 网页路线
3. 一个 **DeepSeek API Key**（platform.deepseek.com 注册充值；先用 owner 分享的测试 key 也可以，别把它提交进仓库）

> ⚠️ **隐私红线（务必记住）**：不要把用户对话数据、API Key 或私人信息提交进仓库、贴公开渠道或写进分享材料。用 AI 工具读写仓库内容是正常的，但用户隐私数据永远不进 git 历史。

## 三、把项目跑起来（第一晚目标）

```bash
# 1. 克隆（小白推荐 HTTPS 方式，浏览器登录 GitHub 后页面绿色 Code 按钮可复制地址）
git clone https://github.com/chemmy-11/moonveil.git
cd moonveil

# 2. 装依赖（dev server 需要）
npm install

# 3. 启动开发服务器（8080）
npm run dev
```

浏览器打开 `http://localhost:8080`，首次进入在侧栏「设置 API Key」里填入 key 即可开聊。

- **Android APK 不用本地搭环境**：CI 会在每次 push 后自动构建，GitHub 仓库页 → Actions → 最新一次运行 → Artifacts 下载 `moonveil-debug-apk` 直接安装
- 第一晚建议只跑 Web 端，把 App 完整玩一遍，对照 issues 找感觉

## 四、仓库地图 + 必须知道的硬约定

```
index.html          主入口（聊天 UI + 各弹窗）
css/tokens.css      设计 token 单一来源（主题/字号/字体都在这覆盖）
css/style.css       桌面端样式    css/mobile.css 移动端样式
js/data.js          角色人设 prompt + LLM 配置（与 personas/ 必须同步！）
js/app.js           聊天引擎（对话/记忆/主题/音效/更新，最大文件）
js/version.js       版本号唯一源头（build.sh 自动注入 index.html）
personas/           角色记忆与人格源文件（md）
scripts/build.sh    一键构建 APK（md5 校验 + 版本一致性）
scripts/bump-version.sh    发版 bump：三处版本同步一条命令（issue #25）
.github/            issue/PR 模板 + CI 工作流
docs/               roadmap、协作规范、本文档
```

**四条硬约定（CI 会拦截违规）**：

1. 改 `personas/*.md` 必须**同步 `js/data.js`** 里的 prompt（反之亦然）
2. 发版跑 `bash scripts/bump-version.sh [版本号]`（一条命令同步 `js/version.js`、`android/app/build.gradle` 的 versionName/versionCode、index.html 缓存号，并内置 versionCode 递增校验）
3. 新增 css/js 静态文件要补进 `scripts/build.sh` 的 md5 校验清单（历史教训：tokens.css 漏过一次）
4. 代码里不许出现 API key / token（CI 密钥扫描会拦）

**协作规范文档**（提 issue / PR 前必读）：`docs/issue-pr-conventions.md` —— 标题格式、模板、自查清单都在里面。

## 五、GitHub 共创流程（小白版）

一次协作的完整生命周期：

```
领 issue → 建功能分支 → 改代码 + 提交 → push 分支 → 开 PR → CI 变绿 → owner squash 合并 → issue 自动关闭
```

**概念速查**（每个一句话）：

| 概念 | 一句话 |
|---|---|
| issue | 一张任务卡：报 bug / 提需求，讨论都在卡片下进行 |
| 分支（branch） | 你的私人工作副本，随便改不影响主线 `main` |
| commit | 一次存档，信息格式 `<动词>: <改了什么>`（如 `feat: xxx` / `fix: xxx`） |
| PR | 「请把我的分支合进 main」的申请，附带改动对比和自查清单 |
| CI | push 后自动跑的机器检查（语法 / 数据完整性 / 版本同步 / APK 构建），**绿了才许合并** |
| squash merge | 把你分支上所有提交压成一条干净的记录进主线 |

### 具体步骤（命令行路径，五条命令打天下）

```bash
git switch -c feat/我的功能名     # 1. 从最新 main 建功能分支
# ... 改代码 ...
git add -A                        # 2. 暂存改动
git commit -m "feat: 一句话说明"  # 3. 提交
git push -u origin feat/我的功能名 # 4. 推到 GitHub（第一次带 -u）
# 5. 打开 GitHub 仓库页 → 黄色提示条 → 「Create pull request」
```

开 PR 时**模板会自动带出**（背景 / 改动点 / 验证 / 自查清单），照着填；正文写 `Refs #卡号` 关联任务卡。合并统一用 **Squash and merge**，由 owner 或有经验的成员操作；**新人不直推 `main`**，功能分支随便推。

### CI 红了怎么办（三个最常见）

| CI 报错 | 处置 |
|---|---|
| 版本未同步（index.html `?v=` 漂移） | 跑一次 `bash scripts/build.sh`，把生成的 index.html 改动一并提交 |
| md5 清单缺文件 | 把新文件路径补进 `scripts/build.sh` 的校验清单 |
| 密钥扫描命中 | 删掉 key；已泄露的 key 立即作废 |

## 六、用 agent 工具干活（你刚开始上手）

Agent（ZCode / Claude Code / Codex 等）可以代劳：读代码、按 issue 实现、跑构建验证、提交、开 PR、写 issue。**上手姿势**：

1. **在仓库目录里启动 agent**（它会自动读到本文件和仓库上下文）
2. **第一句话先让它读规范**，确认它和你在同一频道：
   > 读 docs/collab-onboarding.md、docs/issue-pr-conventions.md 和 docs/roadmap.md，总结项目的协作规范和当前进行中的任务。
3. **派活用模板**：
   > 按仓库规范认领 issue #12，在功能分支上实现，Web 端验证通过后提交并开 PR 引用该 issue。不要直推 main。
4. **验收责任在你**：agent 写完 ≠ 完成——你要看一眼 diff、跑起来点一遍、确认 CI 绿了，再请 owner 合并。agent 会犯错，你是质量闸门。

**新手常见坑**：

- agent 有时图省事直推 main / 跳过 PR —— 派活时明确「走分支 + PR」
- 多个 agent 会话并行时会互相看不到改动 —— 派活前让 agent 先 `git status` + `git log` 看最新状态
- agent 改了 `personas/` 忘了同步 `js/data.js` —— 验收时对照硬约定第 1 条

## 七、第一周建议路线

- **Day 1**：环境跑通 + 完整玩一遍 App + 读 roadmap 和 open issues
- **Day 2-3**：从 Issues 页挑一张带 `ui` label 的小卡（或问 owner 哪张适合练手）走完整流程——改动面清晰、CI 能兜底的优先
- **之后**：认领一个方向（记忆 / 多模态 / 主题 / 游戏内容 G1-G4），和 owner 开个短会对齐方案再动手

## 八、速查卡

```bash
npm run dev                      # 起开发服务器（8080）
git switch main && git pull      # 回主线并拉最新
git switch -c feat/xxx           # 建功能分支
git add -A && git commit -m "feat: xxx" && git push   # 提交三连
bash scripts/build.sh            # 本地构建 APK（Windows 需 JDK 17）
bash scripts/bump-version.sh 0.x.y    # 发版三处版本同步（不带参数则 patch +1）
```

- 卡住先看：CI 日志 → issue 讨论 → 问 agent「这个报错什么意思、怎么修」
- 找谁问：任务归属和合并找 owner；规范问题看 `docs/issue-pr-conventions.md`
- 记住：**改 personas 同步 data.js；不发版不动版本号；main 只进不直接推**
