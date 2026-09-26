# 主题设计规格 · 山月（Shan Yue）

> 状态：已归档 —— v1.5.9 已落地，v0.1.3 随 issue #12 下线（星河/山月让位「月见」暗色主题）；v0.2.10 随 issue #48「月见」亦下线，主题收敛为纯白/纯黑/自定义三选；本文仅作历史设计参考
> 定位：第四个主题，夜晚暗色系，画风极简、低对比，适合做聊天背景
> 关联：`css/style.css`、`js/app.js`（`THEMES`/`THEME_ORDER`）、`scripts/generate-starry.py`（参考范式，已随星河主题移除）

---

## 一、主题定位

| 项 | 值 |
|---|---|
| 内部 key | `shanyue`（`html[data-theme="shanyue"]`） |
| 显示名 | **山月** |
| 基调 | 月光下的远山夜景，冷靛蓝、安静、有地气 |
| 画风 | 平涂色块 + 一轮明月 + 远山剪影，无星云/无密集星海 |
| 情绪 | 「人间的夜」——与「星河」的「宇宙的夜」形成对照 |

### 与现有「星河(moon)」的差异
- 星河：宇宙感，银河 + 星云 + 聚散星子，带星子闪烁动效，偏冷蓝紫。
- 山月：地表感，单一明月 + 2~3 层远山剪影，画面更"实"更"静"，无闪烁动效（或仅极弱月光呼吸）。
- 二者同为暗色，但**色相与内容强区分**，循环切换时辨识度高。

---

## 二、色彩系统（完整 CSS 变量）

新增 `html[data-theme="shanyue"]` 块，置于 `css/style.css` 星河主题块之后。命名与既有变量一一对应，便于复用。

```css
/* ═══ 山月主题（夜晚 · 月光远山）═══
   壁纸由 scripts/generate-shanyue.py 程序生成（靛蓝天带 + 明月 + 远山剪影） */
html[data-theme="shanyue"] {
  --bg: #0C1226;                       /* 深靛蓝夜空 */
  --bg-soft: rgba(30, 40, 74, .5);
  --card-bg: rgba(28, 38, 70, .6);     /* 毛玻璃面板底 */
  --card-border: rgba(150, 168, 224, .14);
  --text-main: #E6EBF6;
  --text-dim: #A9B5D4;
  --ok-color: #9BD8B4;
  --bubble-gf: rgba(104, 124, 180, .82);
  --bubble-gf-border: rgba(160, 180, 238, .22);
  --input-bg: rgba(30, 40, 74, .72);
  --shadow-soft: 0 8px 30px rgba(3, 6, 18, .5);
  --shadow-tiny: 0 2px 10px rgba(3, 6, 18, .45);
  /* 壁纸：程序生成的月光远山（靛蓝天带 + 明月 + 远山） */
  --wall: url('../assets/chat-shanyue.webp');
  /* 遮罩比星河略深一档：山月画面本身更亮（明月），需压住防气泡被晃 */
  --scrim: linear-gradient(rgba(12, 18, 38, .26), rgba(12, 18, 38, .42) 55%, rgba(12, 18, 38, .62));
  --scroll-thumb: rgba(255, 255, 255, .15);
  --danger: #D89A9A;
}
```

### 三女友主题色在深底上的提亮（复用星河的提亮思路）

```css
/* 山月：女友主题色提亮（深底上更通透），与星河同策略 */
html[data-theme="shanyue"] body[data-gf="wanwan"] {
  --gf-color: #DDA7C2;
  --gf-color-soft: rgba(221, 167, 194, .22);
  --gf-grad: linear-gradient(135deg, #EBBFD6, #DFABC6);
}
html[data-theme="shanyue"] body[data-gf="tangtang"] {
  --gf-color: #EFC48A;
  --gf-color-soft: rgba(239, 196, 138, .24);
  --gf-grad: linear-gradient(135deg, #F7D5A5, #EFC48A);
}
```

### 可选：极弱氛围动效（克制，不抢气泡）
山月**默认不加星子闪烁**。如需一点"活气"，仅在 `.app::before` 放一层**极淡的月光呼吸**（单色大柔光、透明度 0.08↔0.14、周期 12s），远低于星河星子的可见度。是否启用由实现时按手感定。

```css
/* 可选 · 月光呼吸（默认关闭，需时再开） */
html[data-theme="shanyue"] .app::before {
  content: '';
  position: absolute; inset: 0; z-index: -1; pointer-events: none;
  background: radial-gradient(420px 420px at 82% 14%, rgba(246, 237, 207, .12), transparent 60%);
  animation: moon-breath 12s ease-in-out infinite alternate;
}
@keyframes moon-breath { from { opacity: .55; } to { opacity: 1; } }
```

### 菜单横幅映射

```css
/* 山月：直接取壁纸上半部做横幅（与星河同源裁剪思路） */
html[data-theme="shanyue"] .menu-art {
  background-image: url('../assets/menu-shanyue.webp');   /* 由 chat-shanyue.webp 顶部裁切生成 */
  background-position: 82% 10%;
  background-size: cover;
}
```

---

## 三、壁纸生成方案（程序化，可复现）

沿用 `generate-starry.py` 的范式：纯程序生成、固定随机种子、输出 `webp`、同时产聊天壁纸与菜单横幅两张。

**文件**：`scripts/generate-shanyue.py`
**依赖**：`Pillow`（项目已具备）；`numpy` 可选（不强制）。
**尺寸**：聊天壁纸 `1080×1920`（竖屏聊天背景，cover 裁切无变形）；菜单横幅 `420×84` 由同图顶部裁切。

### 画面构成（从底到顶绘制顺序）
1. **夜空**：竖直方向柔和渐变 —— 顶部 `#16224A` → 中部 `#0D1530` → 底部 `#070B1C`（深靛蓝压下，给气泡留暗底）。
2. **明月**：右上偏上位置（约 `x=82% y=14%`），大半径柔光圆 —— 先画低透明度光晕（径向 `#F1E7CF` @ ~0.18 扩散），再画实心月面 `#F1E7CF`，可加 1~2 道极淡环形阴影模拟月海（可选，保持简单可省略）。
3. **疏星**：随机撒 20~40 颗小星（`#FFFFFF`，半径 0.6~1.4px，透明度 0.4~0.8），集中在天空上半部，密度远低于星河。
4. **远山剪影**：2~3 层多边形，由远及近逐层加深 —— 远层 `#0E1736`、中层 `#0A1024`、近层 `#060A1A`，山脊用平缓折线，避免尖刺（柔和的"山月"感）。
5. **输出**：`assets/chat-shanyue.webp`（质量 88~92）；再裁顶部生成 `assets/menu-shanyue.webp`。

### 关键参数（实现时填入）
- 种子：固定（如 `SEED = 20260817`），保证每次生成一致、可纳入版本控制复现。
- 明月位置/半径：建议半径占短边 9%~12%，光晕 2.2×。
- 山脊：用正弦扰动叠加随机小幅起伏生成折线点，幅度克制。

> 注：星河用 `radial-gradient` 点阵画星子；山月改用 PIL 直接画圆 + 多边形，色块更少、文件更小，契合"简单"。

---

## 四、主题切换注册（`js/app.js`）

改动 `THEMES` 与 `THEME_ORDER`（现有第 146~151 行附近）：

```js
// 四主题循环：珍珠潮汐(light) → 海港(harbor) → 星河(moon) → 山月(shanyue)
THEMES: {
  light:  '珍珠潮汐',
  harbor: '海港',
  moon:   '星河',
  shanyue:'山月',
},
THEME_ORDER: ['light', 'harbor', 'moon', 'shanyue'],
```

无需改 `applyTheme()` / `toggleTheme()` —— 它们已基于 `THEMES`/`THEME_ORDER` 通用循环，新增 key 自动生效。`localStorage` 键 `aigf_theme` 容错逻辑已能兜底未知值。

---

## 五、版本与发布

按 `docs/roadmap.md` 第五节规范：
1. `js/version.js`：`APP_VERSION = '1.5.9'`（唯一源头）。
2. `scripts/build.sh`：构建时自动注入 `index.html` 的 `?v=` 与 `<script>` 版本号（现有机制，无需手改 index.html）。
3. `android/app/build.gradle`：`versionCode` / `versionName` 手动同步到 `1.5.9`。
4. 发版后更新 `chemmy-11/moonveil-updates` 的 `latest.json` + 上传新 APK。
5. 提交信息遵循 `<动词>: <改了什么>`，如 `feat: 新增山月夜晚主题`。

---

## 六、验收标准

- [ ] 顶栏主题按钮循环可切到「山月」，localStorage 持久化生效。
- [ ] 深底下三女友气泡文字清晰：gf 气泡浅蓝底 + 浅色字；player 气泡渐变底 + 深字（`--on-gf`）。
- [ ] 壁纸明月不刺眼、远山压暗，气泡浮于其上对比达标（WCAG AA：正文文字与底 ≥ 4.5:1）。
- [ ] 菜单横幅显示山月壁纸顶部裁切，不拉伸。
- [ ] 三主题之外的既有浅色主题（珍珠潮汐/海港）与星河不受影响。
- [ ] 尊重 `prefers-reduced-motion`：若启用月光呼吸动效，需在该媒体查询下关闭（现有 `style.css` 末段已全局处理动画，新增 keyframes 自动被覆盖）。

---

## 七、落地步骤清单（实现时照做）

1. 写 `scripts/generate-shanyue.py`，生成 `assets/chat-shanyue.webp` + `assets/menu-shanyue.webp`。
2. 在 `css/style.css` 星河块后追加山月变量块 + 女友色提亮 + 菜单横幅映射（可选月光呼吸）。
3. `js/app.js` 的 `THEMES` 加 `shanyue:'山月'`，`THEME_ORDER` 末尾加 `'shanyue'`。
4. `js/version.js` → `1.5.9`；`build.gradle` 同步。
5. `python -m http.server` 起服务，实机/浏览器验证四项验收。
6. 截图归入 `gui-test-screenshots/`（建议 `shanyue-*.png`）。
