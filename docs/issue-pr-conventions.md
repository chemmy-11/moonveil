# 月见 Issue / PR 提报规范

> 最后更新：2026-09-02（同日增补：.github 模板固化 + CI 流程，见 §五）· 适用主仓库 `chemmy-11/moonveil`
>
> 定位：月见是小团队协作项目（owner + 开发组成员 + 多个 AI agent 会话），本文规范「人 / AI agent」两类提交者的 Issue 与 PR 行为，与 `docs/roadmap.md`（里程碑与方向）、`docs/collab-onboarding.md`（新成员入门）、README（项目定位）互补：**roadmap 记方向，issue 记可执行事项，PR 记落地过程**。

## 一、仓库与分支基线

| 仓库 / 分支 | 可见性 | 角色 | 规则 |
|---|---|---|---|
| `moonveil` · `main` | 公开 | 开发主线（公开版人设） | 所有提交、issue、PR 都在这里 |
| `moonveil-updates` · `master` | 公开 | OTA 发布仓（latest.json + APK） | 仅发版脚本写入 |
| `moonveil` | 公开 | 已迁移的公开展示仓 | 冻结在 d12339b，除非用户明确说明，不推送 |
| `moonveil-updates` | 公开 | OTA 发布仓（APK + latest.json） | 仅随发版流程更新 |

- **推送时机**：本地提交是常态，`git push`、合并到远程前需用户明确指令。
- 默认分支为 `main`；一切 PR 的 base 都是 `main`。

## 二、Issue 规范

### 2.1 何时开 issue（与 Badcase、Correction 的分工）

| 问题类型 | 去处 |
|---|---|
| 对话质量问题：人设漂移、语气失真、记忆错乱等「改 prompt 能修」的 | personas 的 Correction 层 + 复盘沉淀，**不开 issue** |
| 工程缺陷：UI 异常、功能 bug、构建/发布链路问题 | **开 issue** |
| 功能诉求 / roadmap 编号项（C1、B4、G1…）拆出的具体任务 | **开 issue**（body 里注明 roadmap 编号） |
| 想法、未对齐方向 | 可开 issue 标 `idea`，或先留 roadmap，对齐后再拆 |

> **粒度约定**（2026-09-02 确认）：**同一主题的多阶段改造合成一个 issue**——分阶段小节 + 各自验收 checkbox，不按层/子任务拆成多个 issue（单人项目，一张卡读完全貌优先于细粒度关闭语义）。跨多个 PR 的 issue：过程中 PR 正文引用 `#N`，最后一发用 `Closes #N` 收口。

### 2.2 标题格式

与提交信息同风格：`类型: 一句话描述`。类型取以下之一（可对应 GitHub label）：

| 类型 | 用途 | 示例 |
|---|---|---|
| `bug` | 缺陷 | `bug: 移动端点开存档没反应（弹窗渲染在视口外）` |
| `feat` | 新功能 | `feat: 女友随机生活事件（G2）` |
| `ui` | 界面打磨 | `ui: 主题切换交叉淡化（A5）` |
| `persona` | 人设/内容调整 | `persona: 苏晚晚记忆源文件扩充花店日常线` |
| `infra` | 工程债/构建/发布 | `infra: package.json 的 npm run build 引用失效` |
| `idea` | 想法、未对齐方向 | `idea: 女友之间互相聊起玩家` |

> 六个 label 已在远端建好（配色见 `scripts/setup-labels.py`，可幂等重放）；`bug` 表单自动打标，任务类表单选类型后请补打对应 label。

### 2.3 正文模板

> GitHub 上开 issue 会自动套用 `.github/ISSUE_TEMPLATE/` 表单（缺陷 = bug_report，任务/需求 = task_request，字段与本节模板一致）；本节保留作为字段说明与线下/agent 提报参考。

**缺陷（bug）：**

```markdown
**现象**：
**复现**：步骤（注明端：Web / APK、主题、版本号）
**期望**：
**证据**：截图 / Console 报错 / 消息原文（本仓私有，可贴私人内容，但注意勿外传）
**根因与修法**（可后补）：
```

**需求 / 任务（feat / ui / persona / infra）：**

```markdown
**背景**：roadmap 编号（如 C2）或对话中暴露的痛点
**方案要点**：
**验收标准**：
**影响面**：预计改动的文件/机制（如 js/app.js 记忆模块 + personas）
```

### 2.4 生命周期

1. 打开 issue，动手前先在 issue 里补齐根因分析或方案（防止上下文散在会话里丢失）。
2. 修复/实现后，在 issue 下留 **结论 comment**（根因 + 修复提交哈希 + 验证方式），然后 close。
3. 决定不做的 close 时注明原因（`not planned`），保留结论供后来查阅。

## 三、PR 规范

### 3.1 直推还是走 PR

| 情形 | 做法 |
|---|---|
| 小改动（≤3 文件、低风险、方案无疑义） | `main` 直推——**仅限 owner 本人及其 AI 会话**（沿用现状，保持简洁） |
| 机制改动 / 多文件 / 方案存疑想留评审痕迹 / 需要用户过目 | 分支 + PR |
| **协作组成员（非 owner）的一切改动** | **一律分支 + PR**，不直推 `main`（见 `docs/collab-onboarding.md` 第五节） |

### 3.2 分支与提交

- 分支命名：`feat/<简述>`、`fix/<简述>`、`docs/<简述>`；有对应 issue 则带编号（如 `fix/12-存档弹窗`）。
- 提交信息沿用既有约定：`<动词>: <改了什么>`，动词常用 `feat / fix / docs / chore`（必要时 `refactor / perf`）；**发版提交标题尾部带版本号**（如 `feat: xxx v1.7.2`）。
- **一次提交一个主类型，禁止 `fix+feat:` 复合前缀**——混合改动归类其主要性质（通常是 `feat:`），次要内容在正文分条说明。（2026-09-03 审查新增：#17 曾用 `fix+feat:`，动词表不认。）
- 描述写清「为什么」，尤其 fix 类把根因写进标题或正文（如 `fix: 存档/更新弹窗平级结构致渲染在视口外`）。

### 3.3 PR 正文模板

> 已固化为 `.github/PULL_REQUEST_TEMPLATE.md`（含 §3.4 自查清单），开 PR 自动带出；本节保留说明。

```markdown
**背景**：为什么做（关联 issue #N / roadmap 项）
**改动点**：分条列出
**验证**：怎么验的（端 / 主题 / 操作路径）
**关联**：Closes #N
```

### 3.4 合并前自查清单（项目特有，AI agent 逐项核对）

- [ ] 提交信息符合 `<动词>: <改了什么>`；改 personas → `js/data.js` 已同步（或反之）
- [ ] 发版时：跑过 `bash scripts/bump-version.sh [版本号]`（一条命令同步 `js/version.js` 唯一源头 + `build.gradle` versionName/versionCode + index.html `?v=`，内置 versionCode 递增校验——**OTA 依赖 versionCode 递增**）
- [ ] 新增了 css/js 静态文件 → `scripts/build.sh` 的 md5 校验清单已补录（历史教训：tokens.css 漏过一次）
- [ ] Web + Android 双端验证过；动了主题/配色 → 三主题回归（珍珠潮汐 / 海港 / 月见）+ 自定义主题（若有自定义壁纸在用）
- [ ] `bash scripts/build.sh` 全绿（md5 逐字节校验 + 版本一致性）
- [ ] 代码与正文无 token/密钥；不含用户私人数据
- [ ] 关联 issue 已引用，合并后在 issue 留结论 comment 再关闭

### 3.5 合并与收尾

- 合并方式：优先 **squash**，让 `main` 历史保持「一条提交 = 一个完整改动」的粒度（与既有直推历史一致）；squash 标题即最终提交信息，仍遵循第 3.2 节格式。
- **PR 纪律（2026-09-03 审查新增）**：
  - 一旦开了 PR，该改动的后续提交（验收反馈、回归修复）一律推同分支、走 GitHub 合并——**禁止「开 PR 走形式 + 实际直推 `main` + 手动关闭 PR」**（审查发现 #3/#7/#10/#13/#14/#16/#17 均为此状态：PR 显示未合并、改动却以手写 `(#N)` 后缀的直推进了主线，PR 上的 CI 结论与实际进 `main` 的内容脱节）。
  - 合并通过 GitHub 的合并操作完成（界面按钮或 API `merge_pull_request`），使 PR 状态与 `main` 历史一致。
  - PR 关闭语义：关闭 = 放弃该方案（正文注明原因）；「改用直推」不是关闭理由。
- 合并后删除功能分支。
- 合并后回归发现缺陷：小缺陷可直推修复（提交信息注明 `（issue #N 回归）`，既有实践）；成规模的回退则在原 issue 下留 comment 记录现象与根因，不新开卡（同主题一张卡）。
- 含发版的 PR 合并后，走 OTA 流程：APK 推 `moonveil-updates` + 更新 latest.json（见 roadmap「发布规范」）。

## 四、隐私与红线（本仓私有化后新增）

1. 本仓为公开展示仓：人设内置「绝不输出露骨成人内容」硬约束，所有角色文本保持全年龄向。
2. 涉及人设文本的改动必须与公开定位一致，走**独立的 PR** 专门处理，不与功能改动混提。
3. token / 密钥等敏感配置不写入代码与文档。
4. 素材版权可商用（`成品-1.png` 等版权不明素材已被 .gitignore，不入库）。

## 五、CI 流程（`.github/workflows/ci.yml`）

> 触发：push 到 `main`、PR 到 `main`、手动（workflow_dispatch）；同分支新推送自动取消旧构建。
> 定位：把 §3.4 自查清单里**可自动化的项变成硬拦截**，其余仍靠人工/agent 核对。

### 5.1 Job 结构

| Job | 内容 | 对应清单项 |
|---|---|---|
| `check` | ① `node --check` 三个 js | 语法底线 |
| | ② 角色数据完整性：3 位角色、字段齐全（含 profile）、prompt 含 PART A/B/Layer 0 | 人设双向同步的兜底 |
| | ③ personas 文件存在：从 data.js「记忆文件」注释动态提取核对（防改名失联） | 同上 |
| | ④ 版本同步：`index.html ?v=` ↔ `js/version.js` 不一致即拦截 | 发版必须跑 build.sh |
| | ⑤ md5 清单核对：index.html 引用的本地 css/js 必须在 build.sh 校验清单里 | tokens.css 漏录教训 |
| | ⑥ 密钥泄露扫描：`sk-` 形态 token 出现在 tracked 文件即拦截 | 隐私红线 §4.3 |
| `android-build` | `npm ci` → `bash scripts/build.sh`（完整复刻本地：www 同步含版本注入 → cap sync → assembleDebug → md5 校验）→ 上传 `moonveil-debug-apk` 产物（保留 14 天） | build.sh 全绿 |

- 依赖顺序：`android-build` 在 `check` 之后（检查不过不浪费构建时间）。
- CI 与本地构建**同源**（同一个 build.sh），本地全绿 CI 基本必绿；APK 产物在 Actions 页 Artifacts 下载可直接安装。
- runner（ubuntu-latest）自带 Android SDK + JDK 17；`local.properties` 不入库。

### 5.2 常见失败处置

| CI 报错 | 处置 |
|---|---|
| ④ 版本未同步 | 跑一次 `bash scripts/build.sh`（自动注入 `?v=`），随本 PR 一起提交 |
| ⑤ md5 清单缺文件 | 把缺失路径补进 build.sh 第 5/6 步的校验清单 |
| ⑥ 密钥扫描命中 | 移除 key 并视情况作废该 key（已推送历史需另行处理） |
| android-build 失败 | 看日志定位；本地复跑 `bash scripts/build.sh` 复现 |

### 5.3 明确不放进 CI 的

- 四主题回归、双端真机验证：需要真人/agent 视觉判断，保留在 PR 清单人工核对（可借 gui-test-screenshots 留证）。
- 人设语义质量：归 Correction 层，不进 CI。
- OTA 发布（推 `moonveil-updates` + latest.json）：仅发版手动触发，不挂 CI。
