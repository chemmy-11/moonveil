> 提交前先看 [docs/issue-pr-conventions.md](docs/issue-pr-conventions.md) §3。
> 小改动（≤3 文件、低风险、方案无疑义）可直接 `main` 直推，无需 PR。

## 背景

<!-- 为什么做：关联 issue #N / roadmap 项 -->

Closes #

## 改动点

<!-- 分条列出，让人不看 diff 也能明白 -->

-

## 验证

<!-- 怎么验的：端（Web/APK）/ 主题 / 操作路径 -->

## 合并前自查清单（AI agent 逐项核对）

- [ ] 提交信息符合 `<动词>: <改了什么>`；发版提交标题尾部带版本号
- [ ] 改 personas → `js/data.js` 已同步（或反之），双向一致
- [ ] 发版时：跑过 `bash scripts/bump-version.sh [版本号]`（一条命令同步 `js/version.js` 唯一源头 + `build.gradle` versionName/versionCode + index.html `?v=`，内置 versionCode 递增校验——**OTA 依赖 versionCode 递增**）
- [ ] 新增了 css/js 静态文件 → `scripts/build.sh` 的 md5 校验清单已补录（历史教训：tokens.css 漏过一次）
- [ ] `bash scripts/build.sh` 全绿（md5 逐字节校验 + 版本一致性）
- [ ] Web + Android 双端验证过；动了主题/配色 → 四主题回归（纯白 / 纯黑 / 自定义 / 角色专属）
- [ ] 代码与正文无 token/密钥；不含用户私人数据（见规范第四节）
- [ ] 关联 issue 已引用；合并后在 issue 留结论 comment（根因 + 提交哈希 + 验证方式）再关闭

## 合并方式

- 优先 **Squash and merge**（main 历史保持「一条提交 = 一个完整改动」），squash 标题遵循提交信息格式
- 合并后删除功能分支；发版由 05:00「收敛发版与文档」自动化执行——回归全绿后自动 bump + OTA + Release（owner 2026-09-29 授权）；其余协作者不改版本字段、不发版
