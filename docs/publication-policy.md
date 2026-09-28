# 公开版内容规范（内容边界 · 发版与更新源 · 应用身份）

> 最后更新：2026-09-28 · 2026-09-27 仓库策略反转后，本仓（`chemmy-11/moonveil`）即主开发仓，日常开发、issue、PR 都在这里；原「从主线整树同步快照」流程废止。本文档改写为现行流程：内容边界 + 发版与更新源 + 应用身份。所有参与发布的人（含 AI 协作者）必须遵守。

## 一、仓库定位（现行）

| 仓库 | 可见性 | 角色 |
|---|---|---|
| `chemmy-11/moonveil`（本仓） | 公开 | 主开发仓：全部开发、issue、PR、发版都在此（公开版人设） |
| `chemmy-11/moonveil-updates-public` | 公开 | 本仓的 OTA 更新源（latest.json + APK），应用内「检查更新」拉取 |

- 本仓历史即真实开发历史（默认不重写、不 force push）；不存在「从其它主线同步」的流程。
- persona 文件以本仓为唯一事实源，不与任何其它仓库的人设文件互相复制。

## 二、内容边界（硬性）

1. **角色**：公开版当前内置六位——苏晚晚、唐苓、季萤、欧阳越、江野、林乐（三位男性角色默认入库不启用，见「内置角色库」机制）+ 用户自建角色。新增/移除内置角色时同步更新：README 角色表、`js/data.js`、`personas/`、`.github/workflows/ci.yml` 角色断言、`scripts/build.sh` md5 清单（涉头像）、`js/app.js` 的 `DEFAULT_ENABLED_IDS`（新角色不进默认启用集）与本文档计数。
2. **全年龄**：所有角色文本保持全年龄向。人设内置硬约束「绝不输出任何成人/性相关内容」（Layer 0 与边界层双写），亲密表达止步于拥抱、牵手、靠肩、晚安吻（脸颊）；涉及亲密的段落使用「亲密与陪伴」框架。
3. **隐私**：不出现用户/owner 的可指认私人信息——身体数据、私人经历、真实身份线索、内部工具链细节。
4. **密钥**：任何形态的 token/key 不得入库（CI ⑥ `sk-` 扫描兜底）。
5. **基础设施**：不出现内部服务地址与私有仓引用；仓库表、clone 地址、issue 链接一律指向公开仓。已移除后端的工程历史注释（事实性描述）可保留。
6. **计数措辞**：README/docs/UI 注释中的角色计数与实际一致（当前「六位」；「三位/三份」类派生计数与「三角色/三份/三位」一起 grep 排查）。

## 三、发版与更新源（现行流程）

- **版本同步**：一条命令 `bash scripts/bump-version.sh [版本号]`（`js/version.js` 唯一源头 → build.sh 注入 index.html `?v=` → `build.gradle` versionName/versionCode；versionCode 规则 v2 = `(major+1)×10000 + minor×100 + patch`，严格递增——OTA 依赖）。
- **发版权限**：由 owner 触发/授权；AI 协作者日常开发不主动发版（版本字段、Release、OTA 均不擅动），适合打包的内容列入「待 owner 事项」。
- **发版动作**（owner 授权后执行）：tag `vX.Y.Z` + GitHub Release（标题就是 `vX.Y.Z`，不带「公开发布」等后缀；APK 附件与 OTA 同一构建）→ 推 `moonveil-updates-public`（APK 文件名带版本 `AI-GF-<版本>.apk` + latest.json 的 `apk_url` 指向该文件名 + 删旧包，更新仓只留当前版 + latest.json）。
- **发版自查**：解包 APK 复查第二节内容边界；latest.json notes 控制在 6 行内（App 弹窗只截前 6 行）；raw CDN 有缓存延迟，验证以 api.github.com 主源为准。
- 本仓 `js/app.js` 的更新源 URL 恒为 `moonveil-updates-public`（`RAW_URL` / `API_URL`）——任何触碰更新源相关代码的 PR 核对这一点。

## 四、应用身份与签名（公开版独立）

- **包名**：`com.aigf.app.public`——与其它包名的构建并存互不覆盖。
- **应用名**：`月见Moonveil`（桌面图标 / 系统设置 / 关于页显示名）。
- **签名**：`android/app/moonveil-public.jks` 随仓发布（storePassword/keyPassword/alias 均为 `moonveil-public`），debug 与 release 统一使用（gradle `signingConfigs.pubEdition`）——换来 CI 构建间签名一致，OTA 覆盖安装不依赖构建机临时 key。
- **改动必查**：任何触碰 `build.gradle` / `strings.xml` / `capacitor.config.json` / keystore 的 PR，核对身份四件套（applicationId、显示名、签名配置、keystore 存在性）不回归。
