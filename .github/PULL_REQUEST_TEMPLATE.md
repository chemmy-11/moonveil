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
- [ ] 发版时：`js/version.js` 已升号（唯一源头），跑过 `bash scripts/build.sh`（自动注入 index.html `?v=`），`build.gradle` versionName/versionCode 已手动同步（**OTA 依赖 versionCode 递增**）
- [ ] 新增了 css/js 静态文件 → `scripts/build.sh` 的 md5 校验清单已补录（历史教训：tokens.css 漏过一次）
- [ ] `bash scripts/build.sh` 全绿（md5 逐字节校验 + 版本一致性）
- [ ] Web + Android 双端验证过；动了主题/配色 → 三主题回归（珍珠潮汐 / 海港 / 月见）+ 自定义主题（若有自定义壁纸在用）
- [ ] 代码与正文无 token/密钥；私人版内容未外泄到任何公开渠道（见规范第四节）
- [ ] 关联 issue 已引用；合并后在 issue 留结论 comment（根因 + 提交哈希 + 验证方式）再关闭

## 合并方式

- 优先 **Squash and merge**（main 历史保持「一条提交 = 一个完整改动」），squash 标题遵循提交信息格式
- 合并后删除功能分支；含发版的 PR 走 OTA 流程（APK 推 `moonveil-updates` + latest.json）
