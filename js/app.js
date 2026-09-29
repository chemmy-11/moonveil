// ═══════════════════════════════════════════════════════════
// AI-GF 聊天引擎 — 对话/持久化/API Key/主题/音效
// 架构参考 HELIOS（DeepSeek 直连 + 近 10 轮上下文 + 15s 超时）
// ═══════════════════════════════════════════════════════════

// Unicode 文字字符判定（拆条用）；旧 WebView 不支持 \p{L} 时降级为 CJK+拉丁
const IS_TEXT_RE = (() => {
  try { return new RegExp('\\p{L}|\\p{N}', 'u'); }
  catch (e) { return /[\u3400-\u9fff\u3040-\u30ffA-Za-z0-9]/; }
})();

const App = {

  // 记忆提取限制
  MAX_FAVS: 30,        // 喜好条目上限（超出淘汰最旧的未置顶条目）
  MAX_MEMS: 50,        // 回忆条目上限（同上；置顶条目不参与淘汰）
  MAX_CORRS: 15,       // Correction 规则上限
  REVIEW_INTERVAL: 12, // 回忆盘点周期：累计玩家消息达此数触发
  REVIEW_COOLDOWN: 6,  // 信号词盘点冷却：距上次盘点最少消息数

  // 聊天图片（issue #8：多模态输入）
  IMG_MAX_LONG: 1024,  // 压缩长边上限（px）
  IMG_TARGET_KB: 150,  // 单图体积目标（KB，JPEG 逐档降质）
  MAX_IMGS: 20,        // 每女友历史保留图片张数（超出最旧图降级 [图片] 占位，文字保留）
  IMG_BUDGET: 2,       // 每次请求携带的历史图片张数上限（token 成本控制）

  // 网络搜索（issue #63：智谱 web-search-pro，国内直连；原 Tavily 海外不可达已移除）
  SEARCH_TIMEOUT: 12000,  // 检索超时：失败静默降级不阻塞发送
  SEARCH_MAX_RESULTS: 4,  // 注入条数
  SEARCH_SNIPPET_LEN: 500, // 单条正文截断长度
  SEARCH_QUERY_LEN: 100,  // 用户消息截断为检索 query 的长度

  // 语音系统（issue #38 v1：DashScope WS 直连，浏览器无 CORS 问题）
  MAX_AUDIOS: 20,        // 每女友历史保留语音条数（超出最旧降级 [语音] 占位，文字保留）
  VOICE_MAX_DUR: 60,     // 单条语音最长秒数
  ASR_MODEL: 'fun-asr-realtime',
  // 阶跃 StepAudio 2.5 TTS（issue #42）：OpenAI 兼容 audio/speech，订阅端点优先
  // 千问 cosyvoice 朗读通道已移除（issue #73）：DashScope Key 仅用于 ASR 语音转文字
  STEP_TTS_MODEL: 'stepaudio-2.5-tts',
  STEP_TTS_BASE: 'https://api.stepfun.com/step_plan/v1',
  // 可选音色（issue #73）：预置 ID 实测自 StepFun；经典女声为默认
  STEP_TTS_VOICE: 'jingdiannvsheng',
  TTS_VOICES: [
    // gender: 'f' 女声池 / 'm' 男声池——音色选择按当前角色性别过滤（issue #57）
    { id: 'jingdiannvsheng', gender: 'f', name: '经典女声', short: '经典', desc: '温柔真诚' },
    { id: 'tianmeinvsheng', gender: 'f', name: '甜美女声', short: '甜美', desc: '软糯甜美' },
    { id: 'ruanmengnvsheng', gender: 'f', name: '软萌女声', short: '软萌', desc: '轻柔娇软' },
    { id: 'wenrounvsheng', gender: 'f', name: '气质温婉', short: '温婉', desc: '温柔知性' },
    { id: 'wenrounansheng', gender: 'm', name: '温柔男声', short: '温男', desc: '沉稳温柔' },
    { id: 'wenrougongzi', gender: 'm', name: '温柔公子', short: '公子', desc: '温润如玉' },
  ],
  TTS_VOICE_DEFAULT: { f: 'jingdiannvsheng', m: 'wenrounansheng' },   // 各池默认（issue #57）

  // 角色库默认启用集（issue #7）：老用户升级 / 新用户首启时的聊天栏初始成员。
  // 后续新增内置角色不进此集——入库待用户从角色库启用（「入库不自动出现」）。
  DEFAULT_ENABLED_IDS: ['wanwan', 'tangtang', 'jiying'],

  state: {
    currentGf: null,
    histories: {},       // { gfId: [{role:'player'|'gf', text}] }
    favs: {},            // { gfId: [{ts, text}] } 喜好（低门槛，随回复提取）
    memories: {},        // { gfId: [{ts, text}] } 回忆（严格，低频盘点）
    review: {},          // { gfId: { since, lastTs } } 盘点计数与冷却
    unread: {},          // { gfId: count }
    typingActive: false,
    isComposing: false,  // 中文输入法组合态
    searchEnabled: false, // 联网搜索开关（issue #9：会话级，默认关，不持久化）
    voiceMode: false,     // 语音输入模式（issue #38：会话级，微信式切换）
    bubbleQueue: [],     // 待上屏的气泡队列（逐条延迟发送，微信连发感）
    queueTimer: null,    // 气泡队列发送定时器
    activeController: null, // 当前 LLM 流的 AbortController（发送新消息时打断）
    interrupted: false,  // 当前流是否被用户打断
    activeStreamGf: null,  // 正在流式回复的女友 id（无则 null；切女友时据此清理队列）
    streamSkips: 0,      // 本次流中被跨女友守卫跳过上屏的气泡数
    extracting: false,   // 喜好提取调用进行中（防并发重复提取）
    customGfs: {},       // { gfId: {…角色定义} } 用户自建角色（localStorage 持久化）
    enabledGfs: null,    // Set<gfId> 已启用角色（issue #7：聊天栏只显示启用的角色；null=未加载）
    corrections: {},     // { gfId: [{ts, text}] } 对话修正规则（Correction 闭环）
    createAvatar: '',    // 创建向导中选中的头像 dataURL（空=生成首字头像）
    createAvatarColor: '',  // 上传头像时提取的主色（作角色主题色）
  },

  el: {},

  // ═══ 初始化（独立 try/catch，防单步失败拖垮整体） ═══
  init() {
    try { localStorage.removeItem('ebbingflow_endpoint'); } catch (e) { /* 忽略 */ }   // EbbingFlow 已移除（issue #33），清理残留配置
    try { this.loadCustomGfs(); } catch (e) { console.error('[init] loadCustomGfs', e); }
    try { this.loadEnabledGfs(); } catch (e) { console.error('[init] loadEnabledGfs', e); }
    try { this.cacheElements(); } catch (e) { console.error('[init] cacheElements', e); }
    this._pinnedToBottom = true;   // 贴底跟踪初始态：对话区默认贴底（issue #4）
    try { this.applyTheme(); } catch (e) { console.error('[init] applyTheme', e); }
    try { this.applyFont(); } catch (e) { console.error('[init] applyFont', e); }
    try {
      // 字体晚于首帧就绪会让行高计量偏小（issue #17）：字体加载完成后再重算一次输入框高度
      if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => this.autoResizeInput());
    } catch (e) { /* 忽略 */ }
    try {
      // 首帧 clamp 流式字号未稳定时写入的高度可能偏小（issue #17）：load 后兜底重算
      window.addEventListener('load', () => this.autoResizeInput(), { once: true });
    } catch (e) { /* 忽略 */ }
    try { this.initWall(); } catch (e) { console.error('[init] initWall', e); }
    try { this.loadAllHistories(); } catch (e) { console.error('[init] loadAllHistories', e); }
    try { this.renderGfList(); } catch (e) { console.error('[init] renderGfList', e); }
    try { this.switchGf(this.firstEnabledGfId(), true); } catch (e) { console.error('[init] switchGf', e); }
    try { this.bindEvents(); } catch (e) { console.error('[init] bindEvents', e); }
    try { this.checkApiKey(); } catch (e) { console.error('[init] checkApiKey', e); }
    try { this.setupKeyboardHook(); } catch (e) { console.error('[init] setupKeyboardHook', e); }
    try { this.setupKeyboardFallback(); } catch (e) { console.error('[init] setupKeyboardFallback', e); }

    // 版本号
    const v = document.getElementById('version-text');
    if (v) v.textContent = APP_VERSION;
    const mv = document.getElementById('menu-version');
    if (mv) mv.textContent = APP_VERSION;
  },

  cacheElements() {
    this.el = {
      body: document.body,
      topAvatar: document.getElementById('top-avatar'),
      topName: document.getElementById('top-name'),
      topStatusText: document.getElementById('top-status-text'),
      gfList: document.getElementById('gf-list'),
      dialogueArea: document.getElementById('dialogue-area'),
      playerInput: document.getElementById('player-input'),
      quoteBar: document.getElementById('quote-bar'),
      quoteText: document.getElementById('quote-text'),
      quoteClose: document.getElementById('quote-close'),
      imgFileInput: document.getElementById('img-file-input'),
      imgPreviewBar: document.getElementById('img-preview-bar'),
      imgPreviewThumb: document.getElementById('img-preview-thumb'),
      imgPreviewRemove: document.getElementById('img-preview-remove'),
      lightboxOverlay: document.getElementById('lightbox-overlay'),
      lightboxImg: document.getElementById('lightbox-img'),
      inputPlusBtn: document.getElementById('input-plus-btn'),
      inputPlusMenu: document.getElementById('input-plus-menu'),
      plusPhoto: document.getElementById('plus-photo'),
      plusAlbum: document.getElementById('plus-album'),
      plusVoice: document.getElementById('plus-voice'),
      voiceMenu: document.getElementById('voice-menu'),
      thinkPill: document.getElementById('think-pill'),
      searchPill: document.getElementById('search-pill'),
      clearInputBtn: document.getElementById('clear-input-btn'),
      dashscopeKeyInput: document.getElementById('dashscope-key-input'),
      stepKeyInput: document.getElementById('step-key-input'),
      voiceModeBtn: document.getElementById('voice-mode-btn'),
      holdTalkBtn: document.getElementById('hold-talk-btn'),
      scrollBottomBtn: document.getElementById('scroll-bottom-btn'),
      sendBtn: document.getElementById('send-btn'),
      msgMenu: document.getElementById('msg-menu'),
      memoryMenu: document.getElementById('memory-menu'),
      msgCopy: document.getElementById('msg-copy'),
      msgDelete: document.getElementById('msg-delete'),
      apiStatusText: document.getElementById('api-status-text'),
      apiPanel: document.getElementById('api-panel'),
      apiKeyInput: document.getElementById('api-key-input'),
      apiSaveBtn: document.getElementById('api-save-btn'),
      apiBackBtn: document.getElementById('api-back-btn'),
      providerList: document.getElementById('provider-list'),
      providerAdd: document.getElementById('provider-add'),
      providerDel: document.getElementById('provider-del'),
      providerFormTitle: document.getElementById('provider-form-title'),
      customLlmForm: document.getElementById('custom-llm-form'),
      customLlmName: document.getElementById('custom-llm-name'),
      customLlmBase: document.getElementById('custom-llm-base'),
      customLlmKey: document.getElementById('custom-llm-key'),
      customLlmModel: document.getElementById('custom-llm-model'),
      customLlmTest: document.getElementById('custom-llm-test'),
      createOverlay: document.getElementById('create-overlay'),
      createModal: document.getElementById('create-modal'),
      libraryOverlay: document.getElementById('library-overlay'),
      libraryList: document.getElementById('library-list'),
      libraryCreateBtn: document.getElementById('library-create-btn'),
      libraryCloseBtn: document.getElementById('library-close-btn'),
      createName: document.getElementById('create-name'),
      createDesc: document.getElementById('create-desc'),
      createMaterial: document.getElementById('create-material'),
      createCancelBtn: document.getElementById('create-cancel-btn'),
      createSubmitBtn: document.getElementById('create-submit-btn'),
      createHint: document.getElementById('create-hint'),
      avatarPicker: document.getElementById('avatar-picker'),
      createAvatarInput: document.getElementById('create-avatar-input'),
      createAttachBtn: document.getElementById('create-attach-btn'),
      createAttachInput: document.getElementById('create-attach-input'),
      themeToggle: document.getElementById('theme-toggle'),
      sidebarToggle: document.getElementById('sidebar-toggle'),
      sidebarOverlay: document.getElementById('sidebar-overlay'),
      sbBackup: document.getElementById('sb-backup'),
      sbWall: document.getElementById('sb-wall'),
      wallOverlay: document.getElementById('wall-overlay'),
      wallModal: document.getElementById('wall-modal'),
      wallCrop: document.getElementById('wall-crop'),
      wallCanvas: document.getElementById('wall-canvas'),
      wallCropHint: document.getElementById('wall-crop-hint'),
      wallPickBtn: document.getElementById('wall-pick-btn'),
      wallResetBtn: document.getElementById('wall-reset-btn'),
      wallApplyBtn: document.getElementById('wall-apply-btn'),
      wallFileInput: document.getElementById('wall-file-input'),
      sbFont: document.getElementById('sb-font'),
      sbVoiceReply: document.getElementById('sb-voice-reply'),
      sbVoiceReplyMode: document.getElementById('sb-voice-reply-mode'),
      sbProactive: document.getElementById('sb-proactive'),
      sbProactiveMode: document.getElementById('sb-proactive-mode'),
      sbNotify: document.getElementById('sb-notify'),
      sbNotifyMode: document.getElementById('sb-notify-mode'),
      fontOverlay: document.getElementById('font-overlay'),
      fontModal: document.getElementById('font-modal'),
      fontOptions: document.getElementById('font-options'),
      sbUpdate: document.getElementById('sb-update'),
      sbApi: document.getElementById('sb-api'),
      sbClear: document.getElementById('sb-clear'),
      updateOverlay: document.getElementById('update-overlay'),
      updateModal: document.getElementById('update-modal'),
      updateDesc: document.getElementById('update-desc'),
      updateCopyBtn: document.getElementById('update-copy-btn'),
      updateCancelBtn: document.getElementById('update-cancel-btn'),
      updateDownloadBtn: document.getElementById('update-download-btn'),
      updateProgress: document.getElementById('update-progress'),
      updateProgressBar: document.getElementById('update-progress-bar'),
      updateProgressText: document.getElementById('update-progress-text'),
      backupOverlay: document.getElementById('backup-overlay'),
      backupModal: document.getElementById('backup-modal'),
    backupExportBtn: document.getElementById('backup-export-btn'),
    backupImportBtn: document.getElementById('backup-import-btn'),
    backupFileInput: document.getElementById('backup-file-input'),
      toast: document.getElementById('toast'),
      wall: document.getElementById('wall'),
      gfInfo: document.getElementById('gf-info'),
      profileOverlay: document.getElementById('profile-overlay'),
      profilePanel: document.getElementById('profile-panel'),
      profileClose: document.getElementById('profile-close'),
      profileAvatar: document.getElementById('profile-avatar'),
      profileName: document.getElementById('profile-name'),
      profileTag: document.getElementById('profile-tag'),
      profileSignature: document.getElementById('profile-signature'),
      profileStats: document.getElementById('profile-stats'),
      profileBody: document.getElementById('profile-body'),
    };
  },

  // ═══ 主题 ═══
  // 三主题循环：纯白(white) → 纯黑(black) → 自定义(custom, 有壁纸时动态加入)（issue #48）
  THEMES: {
    white: '纯白',
    black: '纯黑',
    gf: '角色专属',   // issue #69 改造：与纯白/纯黑/自定义同级；选中后随当前角色切换整套视觉
  },
  THEME_ORDER: ['white', 'black', 'gf'],
  // ═══ 角色专属视觉包（issue #69，mxai gpt-image-2 生成） ═══
  // 立绘 = 个人主页背景；chatWall = 聊天背景（直接接管 #wall，与主题同级——
  // 自定义主题的用户壁纸仅对无视觉包的角色生效）；头像已直接替换文件。
  // 自建角色（无视觉包）行为与现状完全一致。
  // 视觉包（issue #65 重定义）：hero = 角色聊天壁纸（竖版立绘直接作壁纸）；
  // 原 chatWall 聊天壁纸退役；个人主页回归纯白样式（无立绘背景）
  VISUAL_PACKS: {
    wanwan:  { hero: 'assets/wanwan-hero.webp' },
    tangtang: { hero: 'assets/tangtang-hero.webp' },
    jiying: { hero: 'assets/jiying-hero.webp' },
  },
  // ═══ 字体偏好（issue #5）：四档选项，key 存 localStorage('aigf_font') ═══
  FONT_OPTIONS: [
    { key: '', label: '系统默认' },
    { key: 'fangsong', label: '华文仿宋' },
    { key: 'song', label: '宋体' },
    { key: 'kai', label: '楷体' },
  ],
  // 与 tokens.css 的 html[data-font] 覆盖块保持一致（弹层选项的「所见即所得」样例用）
  FONT_STACKS: {
    fangsong: "'STFangsong', 'FangSong', 'Zhuque Fangsong', serif",
    song: "'SimSun', 'STSong', 'Source Han Serif SC', serif",
    kai: "'KaiTi', 'STKaiti', 'LXGW WenKai', serif",
  },
  applyTheme() {
    let saved = localStorage.getItem('aigf_theme') || 'white';
    // 旧主题迁移（issue #48）：浅色系→纯白，暗色系→纯黑（收编 issue #12 的 moon/shanyue 迁移）
    const LEGACY_THEME = { light: 'white', harbor: 'white', moon: 'black', shanyue: 'black', yuejian: 'black' };
    if (LEGACY_THEME[saved]) saved = LEGACY_THEME[saved];
    if (saved === 'custom' && !this.THEMES.custom) saved = 'black';   // 自定义壁纸被移除后回落
    if (!this.THEMES[saved]) saved = 'white';   // 兼容旧值/未知值
    document.documentElement.setAttribute('data-theme', saved);
    // 角色专属主题（issue #69 改造）：壁纸 = 当前角色的 chatWall（有包角色），无包角色无壁纸。
    // 其余主题走既有逻辑：custom 从 IndexedDB 内联用户壁纸，纯白/纯黑清内联回落 --wall token
    if (saved === 'gf') {
      this.applyGfWall();
    } else {
      this.idbGet('wall').then(data => {
        if (document.documentElement.getAttribute('data-theme') === 'custom') {
          if (data) this.applyWallInline(data);
        } else {
          this.applyWallInline(null);
        }
      }).catch(() => {});
    }
    const name = this.THEMES[saved];
    this.el.themeToggle.title = '切换主题（当前：' + name + '）';
  },
  toggleTheme() {
    const cur = document.documentElement.getAttribute('data-theme');
    const next = this.THEME_ORDER[(this.THEME_ORDER.indexOf(cur) + 1) % this.THEME_ORDER.length];
    document.documentElement.setAttribute('data-theme', next);
    try { localStorage.setItem('aigf_theme', next); }
    catch (e) { console.error('[theme] save', e); }
    // 壁纸淡入过渡
    const wall = this.el.wall;
    wall.classList.remove('theme-fade');
    void wall.offsetWidth;   // 重启动画
    wall.classList.add('theme-fade');
    this.applyTheme();
    this.toast('已切换为「' + this.THEMES[next] + '」主题');
  },

  // ═══ 检查更新（公开发布仓库渠道）═══
  // 更新源：chemmy-11/moonveil-updates-public（公开版更新源，latest.json + 带版本号的 APK，匿名可读；与主线更新源不同——见 docs/publication-policy.md §四）
  // 发布流程：上传 AI-GF-<版本>.apk → 更新 latest.json（apk_url 指向带版本文件名）→ 手机点「检查更新」
  // ⚠ 双源设计（2026-09-03 教训）：raw.githubusercontent.com 的 Fastly 边缘缓存 max-age=300
  // 且缓存键忽略 query（cache-busting 无效），发版后 5 分钟内手机可能读到旧 latest.json 误判
  // 「已是最新」——先走 api.github.com contents API（不走 raw 缓存、基本实时），失败回退 raw 源。
  // 双源拉取 latest.json（手动/自动检查共用，issue #26 抽取）
  // ⚠ 双源设计（2026-09-03 教训）：raw.githubusercontent.com 的 Fastly 边缘缓存 max-age=300
  // 且缓存键忽略 query（cache-busting 无效），发版后 5 分钟内手机可能读到旧 latest.json 误判
  // 「已是最新」——先走 api.github.com contents API（不走 raw 缓存、基本实时），失败回退 raw 源。
  async fetchLatestMeta() {
    const RAW_URL = 'https://raw.githubusercontent.com/chemmy-11/moonveil-updates-public/master/latest.json';
    const API_URL = 'https://api.github.com/repos/chemmy-11/moonveil-updates-public/contents/latest.json';
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);   // 15s 超时兜底
    const fetchJson = async (url) => {
      const resp = await fetch(url, {
        cache: 'no-store',
        signal: controller.signal,
        headers: url.startsWith('https://api.github.com') ? { 'Accept': 'application/vnd.github.raw+json' } : {},
      });
      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      return resp.json();
    };
    try {
      // API 源 6s 快速失败回退 raw 源（共享同一个总超时 controller）
      try {
        return await Promise.race([
          fetchJson(API_URL),
          new Promise((_, rej) => setTimeout(() => rej(new Error('api timeout')), 6000)),
        ]);
      } catch (e1) {
        return await fetchJson(RAW_URL);
      }
    } finally {
      clearTimeout(timeout);
    }
  },
  // 更新弹窗填充与打开（手动/自动共用，issue #26 抽取）
  showUpdateModal(latest, meta) {
    const notes = String((meta && meta.notes) || '').trim().split('\n').slice(0, 6).join('\n');
    this.el.updateDesc.textContent =
      '当前版本 v' + String(APP_VERSION || '1.0.0') + '，发现新版本 v' + latest + '。' +
      (notes ? '\n\n' + notes : '');
    this.el.updateDownloadBtn.dataset.url = (meta && meta.apk_url) || '';
    this.el.updateDownloadBtn.dataset.version = latest;
    this.el.updateProgress.classList.add('hidden');   // 重置上次的下载进度
    this.el.updateOverlay.classList.remove('hidden');
    this.el.updateModal.classList.remove('hidden');
  },
  checkUpdate() {
    const btn = document.getElementById('sb-update');
    btn.disabled = true;
    btn.style.opacity = '.55';
    this.fetchLatestMeta()
      .then((meta) => {
        const latest = String(meta.version || '').replace(/^v/i, '');
        const cur = String(APP_VERSION || '1.0.0');
        if (!latest || this.compareVersions(latest, cur) <= 0) {
          this.toast('已是最新版本 v' + cur);
          return;
        }
        this.showUpdateModal(latest, meta);
      })
      .catch((e) => {
        console.error('[checkUpdate]', e);
        this.toast(e.name === 'AbortError'
          ? '检查更新超时（网络到更新源不通），请稍后再试'
          : '检查更新失败，请稍后再试');
      })
      .finally(() => {
        btn.disabled = false;
        btn.style.opacity = '';
      });
  },
  // ═══ 自动检查更新（issue #26）═══
  // 启动 10s 后一次（避让首屏）+ 长存会话每小时探测、距上次检查 ≥24h 才真查
  // （localStorage 记时刻，防匿名 API 限流）；每次会话至多提示一次。
  // 无新版/失败全程静默零打扰；有新版出可点击轻提示 → 点进既有更新弹窗。
  AUTO_UPDATE_DELAY: 10e3,
  AUTO_UPDATE_INTERVAL: 24 * 3600e3,
  scheduleAutoUpdate() {
    setTimeout(() => this.autoCheckUpdate(true), this.AUTO_UPDATE_DELAY);
    setInterval(() => this.autoCheckUpdate(false), 3600e3);
  },
  async autoCheckUpdate(isStartup) {
    if (this.state.autoUpdateNotified) return;   // 每会话至多提示一次
    if (!isStartup) {
      const last = Number(localStorage.getItem('aigf_last_update_check') || 0);
      if (Date.now() - last < this.AUTO_UPDATE_INTERVAL) return;   // 24h 节流
    }
    localStorage.setItem('aigf_last_update_check', String(Date.now()));
    let meta;
    try {
      meta = await this.fetchLatestMeta();
    } catch (e) {
      console.warn('[autoCheckUpdate] 静默失败:', e.message || e);   // 无网/限流/超时：零打扰
      return;
    }
    const latest = String(meta.version || '').replace(/^v/i, '');
    const cur = String(APP_VERSION || '1.0.0');
    if (!latest || this.compareVersions(latest, cur) <= 0) return;   // 无新版：零打扰
    this.state.autoUpdateNotified = true;
    this.toast('发现新版本 v' + latest + '，点此查看', () => this.showUpdateModal(latest, meta));
  },
  compareVersions(a, b) {
    const pa = String(a).split('.').map(Number);
    const pb = String(b).split('.').map(Number);
    const n = Math.max(pa.length, pb.length);
    for (let i = 0; i < n; i++) {
      const da = pa[i] || 0, db = pb[i] || 0;
      if (da !== db) return da > db ? 1 : -1;
    }
    return 0;
  },
  closeUpdate() {
    this.el.updateOverlay.classList.add('hidden');
    this.el.updateModal.classList.add('hidden');
  },

  // ═══ 字体选择（issue #5）：localStorage('aigf_font') + html[data-font] ═══
  applyFont() {
    const v = localStorage.getItem('aigf_font') || '';
    if (v && this.FONT_STACKS[v]) {
      document.documentElement.setAttribute('data-font', v);
    } else {
      document.documentElement.removeAttribute('data-font');   // '' = 系统默认栈
    }
    if (this.el.playerInput) this.autoResizeInput();   // 行高随字体变，已增高的输入框按新行高重算上限（issue #17）
  },
  openFontModal() {
    const cur = localStorage.getItem('aigf_font') || '';
    this.el.fontOptions.innerHTML = this.FONT_OPTIONS.map(o => `
      <button class="font-option ${o.key === cur ? 'sel' : ''}" data-font-key="${o.key}">
        <span class="font-option-label">${this.esc(o.label)}</span>
        <span class="font-option-sample" ${o.key && this.FONT_STACKS[o.key] ? `style="font-family:${this.esc(this.FONT_STACKS[o.key])}"` : ''}>月见 Moonveil · 相处的记忆 123</span>
        ${o.key === cur ? '<span class="font-option-check">✓</span>' : ''}
      </button>`).join('');
    this.el.fontOverlay.classList.remove('hidden');
    this.el.fontModal.classList.remove('hidden');
  },
  closeFontModal() {
    this.el.fontOverlay.classList.add('hidden');
    this.el.fontModal.classList.add('hidden');
  },
  setFont(key) {
    if (key && this.FONT_STACKS[key]) localStorage.setItem('aigf_font', key);
    else localStorage.removeItem('aigf_font');
    this.applyFont();
    this.openFontModal();   // 重渲染选中态
    this.toast('字体已切换');
  },

  // ═══ 引用记忆条（issue #2 ①）：主页「聊这个」→ 输入框上方引用 → 发送注入 ═══
  showQuoteBar() {
    const q = this.state.quote;
    if (!q) return;
    this.el.quoteText.textContent = `【${q.title} · ${this.fmtDate(q.ts)}】${q.text}`;
    this.el.quoteBar.classList.remove('hidden');
  },
  clearQuote(silent) {
    this.state.quote = null;
    this.el.quoteBar.classList.add('hidden');
    if (!silent) this.toast('已取消引用');
  },

  // ═══ 自定义壁纸（issue #15）：上传 → 按屏幕比例取景 → 本机保存 ═══
  // 存储走 IndexedDB（大 dataURL 不挤 localStorage 配额——真机上配额不足
  // 会导致「应用后不生效」，Android 反馈的实际根因）
  WALL_MAX_LONG: 2000,     // 裁剪输出长边上限
  WALL_TARGET_KB: 400,     // 压缩产物目标
  WALL_IDB: 'moonveil',
  wallDB() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(this.WALL_IDB, 1);
      req.onupgradeneeded = () => { try { req.result.createObjectStore('kv'); } catch (e) { /* 已存在 */ } };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  },
  async idbSet(key, val) {
    const db = await this.wallDB();
    return new Promise((res, rej) => {
      const tx = db.transaction('kv', 'readwrite');
      tx.objectStore('kv').put(val, key);
      tx.oncomplete = res;
      tx.onerror = () => rej(tx.error);
    });
  },
  async idbGet(key) {
    const db = await this.wallDB();
    return new Promise((res, rej) => {
      const rq = db.transaction('kv', 'readonly').objectStore('kv').get(key);
      rq.onsuccess = () => res(rq.result);
      rq.onerror = () => rej(rq.error);
    });
  },
  async idbDel(key) {
    const db = await this.wallDB();
    return new Promise((res, rej) => {
      const tx = db.transaction('kv', 'readwrite');
      tx.objectStore('kv').delete(key);
      tx.oncomplete = res;
      tx.onerror = () => rej(tx.error);
    });
  },
  // canvas → JPEG dataURL：超 targetKB 时逐档降质量（公共 util，#8 图片消息复用）
  compressCanvas(canvas, maxKB) {
    let q = 0.8;
    let out = canvas.toDataURL('image/jpeg', q);
    while (out.length * 0.75 / 1024 > maxKB && q > 0.4) {
      q -= 0.15;
      out = canvas.toDataURL('image/jpeg', q);
    }
    return out;
  },
  // 图片文件 → 等比压缩 dataURL（issue #8：FileReader dataURL 中转，不用 blob URL——
  // blob URL 在 img 解码前 revoke 会碎图，且 dataURL 直接就是最终存储形态）
  compressImageFile(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(new Error('图片读取失败'));
      reader.onload = () => {
        const img = new Image();
        img.onerror = () => reject(new Error('图片解码失败'));
        img.onload = () => {
          try {
            const long = Math.max(img.naturalWidth, img.naturalHeight) || 1;
            const scale = Math.min(1, this.IMG_MAX_LONG / long);
            const cv = document.createElement('canvas');
            cv.width = Math.max(1, Math.round(img.naturalWidth * scale));
            cv.height = Math.max(1, Math.round(img.naturalHeight * scale));
            cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
            resolve(this.compressCanvas(cv, this.IMG_TARGET_KB));
          } catch (e) { reject(e); }
        };
        img.src = reader.result;
      };
      reader.readAsDataURL(file);
    });
  },
  // ═══ 聊天图片（issue #8）═══
  pickChatImage() {
    this.el.imgFileInput.removeAttribute('capture');   // 相册入口：系统选择器（issue #74 三瓦片拆分）
    this.el.imgFileInput.value = '';   // 允许重选同一张
    this.el.imgFileInput.click();
  },
  // 拍照入口（issue #74）：capture=environment 直调系统相机
  pickChatPhoto() {
    this.el.imgFileInput.setAttribute('capture', 'environment');
    this.el.imgFileInput.value = '';
    this.el.imgFileInput.click();
  },
  async handleChatImageFile(file) {
    if (!file) return;
    try {
      const dataURL = await this.compressImageFile(file);
      this._pendingImg = dataURL;
      this.el.imgPreviewThumb.src = dataURL;
      this.el.imgPreviewBar.classList.remove('hidden');
    } catch (e) {
      console.error('[handleChatImageFile]', e);
      this.toast('这张图读不出来，换一张试试');
    }
  },
  clearPendingImg() {
    this._pendingImg = null;
    this.el.imgPreviewBar.classList.add('hidden');
    this.el.imgPreviewThumb.removeAttribute('src');
  },
  openLightbox(dataURL) {
    this.el.lightboxImg.src = dataURL;
    this.el.lightboxOverlay.classList.remove('hidden');
  },
  closeLightbox() {
    this.el.lightboxOverlay.classList.add('hidden');
    this.el.lightboxImg.removeAttribute('src');
  },

  // ═══ 网络搜索（issue #9：会话级开关默认关，Tavily 客户端检索注入） ═══
  toggleSearch() {
    // 免费渠道（Bing 中国 RSS，issue #64）：无需任何 key
    this.state.searchEnabled = !this.state.searchEnabled;
    this.refreshSearchUi();
    this.toast(this.state.searchEnabled ? '联网搜索已开启（本条消息先检索再回答）' : '联网搜索已关闭');
  },
  // 搜索状态的 UI 呈现（issue #23：入口收进「+」菜单后）——
  // + 键本体带小圆点标记（菜单关闭时状态仍可见）+ 菜单项高亮与「已开/关」徽标
  refreshSearchUi() {
    const on = this.state.searchEnabled;
    if (this.el.inputPlusBtn) this.el.inputPlusBtn.classList.toggle('search-on', on);
    if (this.el.searchPill) {
      this.el.searchPill.classList.toggle('active', on);
      this.el.searchPill.setAttribute('aria-pressed', on ? 'true' : 'false');
    }
  },
  // ═══ 深度思考开关（issue #74）：关 = thinking disabled（响应更快），开 = enabled + high ═══
  // 自定义供应商同样可用（issue #49）：独白协议是纯 content 约定与通道无关，
  // thinking 字段按通道分别组装（见 callLLM）；自定义通道 effort 固定 high（有的模型无 max 档）
  deepThinkingOn() {
    return localStorage.getItem('aigf_deep_thinking') !== '0';   // 默认开
  },
  toggleThinking() {
    const on = !this.deepThinkingOn();
    try { localStorage.setItem('aigf_deep_thinking', on ? '1' : '0'); } catch (e) { /* 忽略 */ }
    this.refreshThinkUi();
    if (on && this.useCustomLlm()) this.toast('深度思考已开启（自定义供应商：发送 thinking + effort high；若对话报错请关掉它）');
    else this.toast(on ? '深度思考已开启' : '深度思考已关闭（回复更快）');
  },
  refreshThinkUi() {
    const on = this.deepThinkingOn();
    if (this.el.thinkPill) {
      this.el.thinkPill.classList.toggle('active', on);
      this.el.thinkPill.classList.remove('locked');
      this.el.thinkPill.setAttribute('aria-pressed', on ? 'true' : 'false');
      this.el.thinkPill.title = this.useCustomLlm()
        ? '深度思考 · 自定义供应商：开 = 发送 thinking + effort high（网关不认未知字段时可能 400，可先「测试连接」验证）；关 = 不发送（最兼容）'
        : '深度思考（关闭后响应更快）';
    }
  },
  // ═══ 清空输入（issue #74）：× 清除文字与待发图片 ═══
  clearInput() {
    if (this.state.isComposing) return;   // IME 组合态不响应
    this.el.playerInput.value = '';
    this.clearPendingImg();
    this.autoResizeInput();
    this.el.playerInput.focus();
  },
  toggleInputPlusMenu() {
    const menu = this.el.inputPlusMenu;
    if (menu.classList.contains('hidden')) {
      this.refreshSearchUi();   // 打开前同步开关状态
      this.closeVoiceMenu();    // 抽屉与音色列表二选一展开
      menu.classList.remove('hidden');
      this.el.inputPlusBtn.setAttribute('aria-expanded', 'true');
      // 微信行为（issue #30）：抽屉顶起输入区前先收软键盘，避免键盘与抽屉抢高度
      try { this.el.playerInput.blur(); } catch (e) { /* 忽略 */ }
    } else {
      this.closeInputPlusMenu();
    }
  },
  closeInputPlusMenu() {
    this.el.inputPlusMenu.classList.add('hidden');
    this.el.inputPlusBtn.setAttribute('aria-expanded', 'false');
  },
  // 朗读音色（issue #73）：抽屉「朗读音色」项 → 整行选择列表，点选即生效
  refreshVoiceUi() {
    const cur = this.ttsVoice();
    const v = this.TTS_VOICES.find(x => x.id === cur);
    if (this.el.plusVoice && v) {
      const st = this.el.plusVoice.querySelector('.plus-voice-state');
      if (st) st.textContent = v.short;
    }
    if (this.el.voiceMenu) {
      this.el.voiceMenu.querySelectorAll('.voice-item').forEach(b =>
        b.classList.toggle('active', b.dataset.voice === cur));
    }
  },
  openVoiceMenu() {
    this.closeInputPlusMenu();
    // 音色按当前角色性别过滤（issue #57）：女角色 4 档 / 男角色 2 档，两池不同时出现
    const pool = this.TTS_VOICES.filter(x => x.gender === this.ttsGender());
    const cur = this.ttsVoice();
    this.el.voiceMenu.innerHTML = pool.map(v => `
      <button class="voice-item${v.id === cur ? ' active' : ''}" type="button" data-voice="${v.id}">
        <span class="vi-name">${v.name}</span><span class="vi-desc">${v.desc}${v.id === this.TTS_VOICE_DEFAULT[this.ttsGender()] ? ' · 默认' : ''}</span>
        <svg class="vi-check" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12l5 5L20 7"/></svg>
      </button>`).join('');
    this.refreshVoiceUi();
    this.el.voiceMenu.classList.remove('hidden');
  },
  closeVoiceMenu() {
    this.el.voiceMenu.classList.add('hidden');
  },
  // Bing 中国 RSS 搜索（issue #64）：免费无 key 国内直连；返回格式化检索块，失败/超时 throw（调用方静默降级）。
  // RSS 无 CORS 头——Android 端走 CapacitorHttp 原生请求绕过；Web 端 fetch 会被 CORS 拦截（明确提示）。
  // 双端点回落（issue #70）：cn 不可达/被劫持/空结果时换 www 再试一次——真机网络差异保险；
  // 超时（AbortError）不回落：真慢换端点也慢，避免等待翻倍。
  // mkt=zh-CN（issue #19）：缺省市场识别下 RSS 对中文 query 返回字面切词的降级排序
  // （「甄嬛传 演员表」→「甄」字百科），显式声明市场后与网页版排序一致——对照实测。
  async webSearch(query) {
    const q = encodeURIComponent(query.slice(0, this.SEARCH_QUERY_LEN));
    const endpoints = [
      'https://cn.bing.com/search?q=' + q + '&format=rss&count=10&mkt=zh-CN',
      'https://www.bing.com/search?q=' + q + '&format=rss&count=10&mkt=zh-CN',
    ];
    let lastErr = null;
    for (const url of endpoints) {
      try {
        const items = this._parseBingRss(await this._fetchBingRss(url));
        console.log('[webSearch]', new URL(url).host, items.length + ' items, q=' + query.slice(0, 40));
        if (items.length) return this._formatSearchBlock(items);
        lastErr = new Error('empty results');
      } catch (e) {
        lastErr = e;
        if (e.name === 'AbortError') throw e;
      }
    }
    throw lastErr || new Error('search failed');
  },
  // 检索 query 提炼（issue #19）：口语原句直接搜索命中字面切词（「那个演甄嬛传的演员」→「那个」词汇
  // 百科），检索前用 small 模型提炼成领域关键词。要点：不保留口语语序、去虚词、歧义时间词转领域词
  // （「适不适合洗车」→「洗车指数」——保留原句词序仍会字面命中鲁迅《明天》）。失败/超时回退原文截断。
  async refineSearchQuery(text) {
    try {
      const out = await this.smallLLMCall([
        { role: 'system', content: '把用户的话提炼成中文网络搜索词。只输出搜索词本身（4~15字），不要任何解释、引号或句号。要求：用领域关键词，去掉「帮我/一下/那个/我想」等口语虚词，不保留整句语序；生活场景用行业词（如「适不适合洗车」提炼为「洗车指数 明天」）。' },
        { role: 'user', content: text.slice(0, 120) },
      ], 60, 8000);
      const s = String(out || '').trim().replace(/^["「『]|["」』]/g, '').replace(/[。.！!？?]+$/, '');
      return (s && s.length >= 2) ? s.slice(0, 30) : null;
    } catch (e) {
      return null;
    }
  },
  async _fetchBingRss(url) {
    const capHttp = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.CapacitorHttp;
    if (capHttp) {
      const resp = await capHttp.get({ url, responseType: 'text', readTimeout: this.SEARCH_TIMEOUT, connectTimeout: this.SEARCH_TIMEOUT });
      if (resp.status >= 400) throw new Error('search ' + resp.status);
      return resp.data || '';
    }
    const resp = await fetch(url);
    if (!resp.ok) throw new Error('search ' + resp.status);
    return resp.text();
  },
  _parseBingRss(xmlText) {
    const doc = new DOMParser().parseFromString(xmlText, 'text/xml');
    return [...doc.querySelectorAll('item')].slice(0, this.SEARCH_MAX_RESULTS).map(it => ({
      title: it.querySelector('title')?.textContent || '',
      link: it.querySelector('link')?.textContent || '',
      content: it.querySelector('description')?.textContent || '',
    })).filter(r => r.title || r.content);
  },
  _formatSearchBlock(items) {
    const lines = items.map((r, i) => {
      const host = (() => { try { return new URL(r.link).hostname; } catch (e) { return ''; } })();
      const content = this.cleanRssSnippet(r.content);
      return `${i + 1}. ${r.title || '（无标题）'}${host ? '（' + host + '）' : ''}：${content}`;
    });
    // 注入隔离声明：检索结果是不可信外部文本，禁止当作记忆/人设/他说过的话
    return '【网络检索结果 · 以下是刚从外部网页查到的资料，不是你自己的记忆与人设，也不是他说过的话；参考回答时可自然提及来源域名】\n' + lines.join('\n');
  },
  // RSS 摘要清洗（issue #70）：Bing RSS 的 description 实测含站点导航路径
  // （「当前位置：首页 北京 …」）、内嵌 HTML、结尾省略号与话题标签串——按真实样本
  // 做针对性去噪，让注入模型的摘要干净可读。宁少勿滥：只删确定的噪音，不动正文。
  cleanRssSnippet(text) {
    let s = String(text || '')
      .replace(/<[^>]*>/g, ' ')        // 去内嵌 HTML 标签
      .replace(/&(nbsp|#160);/g, ' ')  // 去不换行空格实体
      .replace(/&(amp|lt|gt|quot|#39);/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    // 站点导航噪音：从「当前位置」类标记起整段砍掉（实测样本：当前位置：首页 北京市 …
    // 全是导航路径无正文）；开头即噪音则砍空，该条靠标题+域名兜底
    const navMark = s.search(/当前位置|您现在的位置|当前的位置|所在位置/);
    if (navMark >= 0) s = s.slice(0, navMark).trim();
    // 结尾话题标签串（实测小红书式摘要：「… ＃上海旅游 ＃遛娃好去处」）
    s = s.replace(/(\s*[#＃][^\s#＃]+)+\s*$/, '').trim();
    // 结尾省略号（「…」「...」）
    s = s.replace(/[\s.。…·,，、;；\-—]{0,4}[.…]{2,}[\s.。…]*$/, '').trim();
    return s.slice(0, this.SEARCH_SNIPPET_LEN);
  },

  // 句尾句号剥离（issue #43 层二 · 渲染层兜底）：微信式拟真——真人发消息不用句号收尾，
  // prompt 约束（层一）偶有漏网 + 存量历史消息统一在显示层剥净。只剥尾部连续中文句号
  // （含句号前后的尾随空白）；英文句点（小数 3.5）、省略号（…）、？/！/～/颜文字不碰。
  // 只影响显示：hist 存原文（记忆归因完整），TTS 朗读不受影响。
  stripTrailingPeriod(text) {
    return String(text || '').replace(/\s*。+\s*$/, '');
  },

  // ═══ 语音系统（issue #38 v1）═══
  // 语音输入（ASR）：DashScope fun-asr-realtime WS 直连（协议来源：aliyun 官方浏览器 JS 示例）
  // wss://dashscope.aliyuncs.com/api-ws/v1/inference/?api_key=<KEY>（query 传 key，浏览器无 CORS 限制）
  // 朗读（TTS，issue #42/#73）：阶跃 StepAudio audio/speech；千问 cosyvoice 通道已移除
  dashKey() {
    return localStorage.getItem('dashscope_api_key') || '';
  },
  _wsUuid() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
      const r = Math.random() * 16 | 0;
      return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
    });
  },
  _mediaCtx() {
    if (!this.__mediaCtx) this.__mediaCtx = new (window.AudioContext || window.webkitAudioContext)();
    return this.__mediaCtx;
  },
  // TTS 供应商（issue #42，#73 起唯一）：阶跃 StepAudio 2.5，音色可选
  hasStepKey() { return !!localStorage.getItem('stepfun_api_key'); },
  // 当前朗读音色（issue #73）：localStorage 全局持久化，非法值回落默认
  // 音色双槽（issue #57）：按当前角色性别取槽（f/m 各自记忆）；旧单键（全女声时代）首读迁移归 f 槽
  ttsGender() {
    const gf = this.allGfs()[this.state.currentGf];
    return gf && gf.gender === 'male' ? 'm' : 'f';   // 无 gender（旧自建角色）回落女声池
  },
  ttsVoice() {
    const g = this.ttsGender();
    let v = localStorage.getItem('aigf_tts_voice_' + g);
    if (v == null && g === 'f') {
      v = localStorage.getItem('aigf_tts_voice');   // 旧单键迁移：原三档全女声，归 f 槽
      if (v != null) { try { localStorage.setItem('aigf_tts_voice_f', v); } catch (e) { /* 忽略 */ } }
    }
    return this.TTS_VOICES.some(x => x.id === v && x.gender === g) ? v : this.TTS_VOICE_DEFAULT[g];
  },
  setTtsVoice(id) {
    const v = this.TTS_VOICES.find(x => x.id === id);
    if (v) localStorage.setItem('aigf_tts_voice_' + this.ttsGender(), id);
  },
  stepTtsSynthesize(text, instructions) {
    const key = localStorage.getItem('stepfun_api_key');
    if (!key) return Promise.reject(new Error('NO_STEP_KEY'));
    // OpenAI 兼容：POST {base}/audio/speech → mp3 二进制 → decodeAudioData
    // instructions（issue #44）：自然语言情绪演绎指导，仅 stepaudio-2.5/3-tts 生效
    const body = { model: this.STEP_TTS_MODEL, voice: this.ttsVoice(), input: text, response_format: 'mp3' };
    if (instructions) body.instructions = instructions;
    return fetch(this.STEP_TTS_BASE + '/audio/speech', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).then(async (resp) => {
      if (!resp.ok) {
        const detail = await resp.text().catch(() => '');
        let msg = 'StepFun 合成失败 ' + resp.status;
        try { msg = JSON.parse(detail).message || msg; } catch (e) {}
        throw new Error(msg);
      }
      const ab = await resp.arrayBuffer();
      return this._mediaCtx().decodeAudioData(ab);
    });
  },
  // 情绪演绎指令（issue #44）：小调用读台词 → 一句中文演绎指导。
  // 失败/超时静默回落默认温柔语气——绝不阻塞朗读。
  TTS_DEFAULT_INSTRUCTION: '温柔、亲密、自然的情侣语气',
  async ttsEmotionInstruction(text) {
    try {
      const out = await this.smallLLMCall([
        { role: 'system', content: '你是配音导演。根据台词写一句中文的语音演绎指令（15~25 字），描述说话人此刻的情绪与语气，如「委屈中带着撒娇，声音渐弱」「开心到语速加快，尾音上扬」。只输出指令本身，不要任何解释、引号或前缀。' },
        { role: 'user', content: text },
      ], 60, 12000);
      const s = String(out || '').trim().replace(/^["「『]|["」』]$/g, '');
      return (s && s.length <= 40) ? s : this.TTS_DEFAULT_INSTRUCTION;
    } catch (e) {
      return this.TTS_DEFAULT_INSTRUCTION;
    }
  },
  // 朗读入口（issue #44 起带情绪）：先取情绪指令再合成
  async synthesizeGfVoice(text) {
    const instructions = await this.ttsEmotionInstruction(text);
    return this.stepTtsSynthesize(text, instructions);
  },
  // 停掉当前播放（同一时间只播一条）
  stopVoicePlayback() {
    if (this.__playingSrc) {
      try { this.__playingSrc.onended = null; this.__playingSrc.stop(); } catch (e) {}
      this.__playingSrc = null;
    }
    document.querySelectorAll('.msg-voice.playing, .msg-tts-btn.playing').forEach(el => el.classList.remove('playing'));
  },
  // 播放 AudioBuffer（TTS 用），带互斥与 UI 态
  playAudioBuffer(buffer, uiEl, ctx) {
    this.stopVoicePlayback();
    const c = ctx || this._mediaCtx();
    const src = c.createBufferSource();
    src.buffer = buffer;
    src.connect(c.destination);
    if (uiEl) uiEl.classList.add('playing');
    this.__playingSrc = src;
    src.onended = () => { if (this.__playingSrc === src) this.__playingSrc = null; if (uiEl) uiEl.classList.remove('playing'); };
    src.start();
  },
  // 播放历史语音消息（webm/opus dataURL → decodeAudioData 播放）
  async playMsgAudio(dataURL, uiEl) {
    try {
      this.stopVoicePlayback();
      if (uiEl) uiEl.classList.add('playing');
      const resp = await fetch(dataURL);
      const ab = await resp.arrayBuffer();
      const buf = await this._mediaCtx().decodeAudioData(ab);
      const src = this._mediaCtx().createBufferSource();
      src.buffer = buf;
      src.connect(this._mediaCtx().destination);
      this.__playingSrc = src;
      src.onended = () => { if (this.__playingSrc === src) this.__playingSrc = null; if (uiEl) uiEl.classList.remove('playing'); };
      src.start();
    } catch (e) {
      console.error('[playMsgAudio]', e);
      if (uiEl) uiEl.classList.remove('playing');
      this.toast('这条语音播放失败');
    }
  },
  // 女友气泡朗读：合成（按 音色+mid+文本 内存缓存）→ 播放
  // 语音气泡段合成（issue #13）：key 含段序——同段重进/点播直接命中缓存
  async gfVoiceBuf(mid, speak) {
    if (!this._ttsCache) this._ttsCache = new Map();
    const key = this.ttsVoice() + ':' + mid + ':' + speak;
    let buf = this._ttsCache.get(key);
    if (!buf) {
      buf = await this.synthesizeGfVoice(speak);
      this._ttsCache.set(key, buf);
    }
    return buf;
  },
  // 语音气泡点播：无缓存则静默重合成（合成只依赖文本+情绪指令，可复现）
  async playGfVoice(mid, speak, el) {
    el.classList.add('loading');
    try {
      const buf = await this.gfVoiceBuf(mid, speak);
      const durEl = el.querySelector('.mv-dur');
      if (durEl) durEl.textContent = Math.max(1, Math.round(buf.duration)) + '″';
      this.playAudioBuffer(buf, el, this._mediaCtx());
    } catch (e) {
      console.error('[playGfVoice]', e);
      el.classList.remove('loading');
      this.toast(e.message || '语音合成失败');
    }
  },
  // gf 语音气泡构建（issue #13）：复用玩家侧 mic 形态；动作描写存在时给「原文」chip 展开看全文
  appendGfVoiceBubble(bubble, mid, speak, raw) {
    const est = Math.max(1, Math.round(speak.length / 4));
    const voice = document.createElement('div');
    voice.className = 'msg-voice';
    voice.title = '点击播放';
    voice.addEventListener('click', () => this.playGfVoice(mid, speak, voice));
    const bars = document.createElement('span');
    bars.className = 'mv-bars';
    bars.innerHTML = '<i></i><i></i><i></i><i></i>';
    const d = document.createElement('span');
    d.className = 'mv-dur';
    d.textContent = est + '″';
    voice.appendChild(bars);
    voice.appendChild(d);
    bubble.appendChild(voice);
    if (raw && raw !== speak) {
      const tr = document.createElement('button');
      tr.type = 'button';
      tr.className = 'mv-transcript-toggle';
      tr.textContent = '原文';
      tr.addEventListener('click', (e) => {
        e.stopPropagation();
        const vt = bubble.querySelector('.mv-transcript');
        if (vt) vt.classList.toggle('show');
        tr.textContent = vt && vt.classList.contains('show') ? '收起' : '原文';
      });
      bubble.appendChild(tr);
      const vt = document.createElement('div');
      vt.className = 'mv-transcript';
      vt.textContent = raw;
      bubble.appendChild(vt);
    }
  },
  async playGfTTS(mid, text, uiEl) {
    if (!this.hasStepKey()) {
      this.toast('先在「设置 API Key」里填写阶跃 StepFun Key 才能朗读');
      this.openApiPanel();
      return;
    }
    if (!this._ttsCache) this._ttsCache = new Map();
    // 缓存键带音色（issue #73）：切音色后同一条消息重新合成，不会串旧声音。
    // mid + 文本缺一不可：同一次回复的多个气泡共用同一个 mid，
    // 只用 mid 会导致第二条起全部播放第一句的声音（owner 实机反馈）
    const cacheKey = this.ttsVoice() + ':' + mid + ':' + text;
    try {
      if (uiEl) uiEl.classList.add('loading');
      let buf = this._ttsCache.get(cacheKey);
      if (!buf) {
        buf = await this.synthesizeGfVoice(text);
        this._ttsCache.set(cacheKey, buf);
      }
      if (uiEl) uiEl.classList.remove('loading');
      this.playAudioBuffer(buf, uiEl, this._mediaCtx());
    } catch (e) {
      if (uiEl) uiEl.classList.remove('loading');
      console.error('[playGfTTS]', e);
      this.toast(e.message === 'NO_STEP_KEY' ? '请先配置语音 Key' : (e.message || '朗读失败'));
    }
  },
  // blob → dataURL（语音消息落历史用；与图片同模式，避免 blob URL 失效坑）
  blobToDataURL(blob) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result);
      r.onerror = () => reject(new Error('读取失败'));
      r.readAsDataURL(blob);
    });
  },
  // ASR：录音 blob → 16k mono Int16 PCM → fun-asr-realtime → 文本
  async transcribeAudio(blob) {
    const key = this.dashKey();
    if (!key) throw new Error('NO_VOICE_KEY');
    // webm/opus → AudioBuffer → OfflineAudioContext 重采样 16k 单声道
    const ab = await blob.arrayBuffer();
    const decodeCtx = new (window.AudioContext || window.webkitAudioContext)();
    const decoded = await decodeCtx.decodeAudioData(ab);
    await decodeCtx.close();
    const targetLen = Math.max(1, Math.ceil(decoded.duration * 16000));
    const off = new OfflineAudioContext(1, targetLen, 16000);
    const src = off.createBufferSource();
    src.buffer = decoded;
    src.connect(off.destination);
    src.start();
    const rendered = await off.startRendering();
    const f32 = rendered.getChannelData(0);
    const i16 = new Int16Array(f32.length);
    for (let i = 0; i < f32.length; i++) {
      const s = Math.max(-1, Math.min(1, f32[i]));
      i16[i] = s < 0 ? s * 32768 : s * 32767;
    }
    // WS 识别：run-task → 分帧发 PCM → finish-task → 收文本
    return new Promise((resolve, reject) => {
      const taskId = this._wsUuid();
      let finalText = '';
      let settled = false;
      let ws;
      try {
        ws = new WebSocket('wss://dashscope.aliyuncs.com/api-ws/v1/inference/?api_key=' + encodeURIComponent(key));
      } catch (e) { reject(e); return; }
      ws.binaryType = 'arraybuffer';
      const timeout = setTimeout(() => {
        if (!settled) { settled = true; try { ws.close(); } catch (e) {} reject(new Error('识别超时')); }
      }, 30000);
      ws.onopen = () => {
        ws.send(JSON.stringify({
          header: { action: 'run-task', task_id: taskId, streaming: 'duplex' },
          payload: {
            task_group: 'audio', task: 'asr', function: 'recognition', model: this.ASR_MODEL,
            parameters: { format: 'pcm', sample_rate: 16000, disfluency_removal_enabled: false, language_hints: ['zh'] },
            input: {},
          },
        }));
      };
      ws.onmessage = (ev) => {
        if (typeof ev.data !== 'string') return;
        let m;
        try { m = JSON.parse(ev.data); } catch (e) { return; }
        const evt = m.header && m.header.event;
        if (evt === 'task-started') {
          // 分帧发送（4KB/帧，缓冲积压时等排空再继续，模拟真实语速节流）
          const frameBytes = 4096;
          const send = async () => {
            for (let off2 = 0; off2 < i16.byteLength; off2 += frameBytes) {
              if (ws.readyState !== 1) return;
              ws.send(i16.buffer.slice(off2, off2 + frameBytes));
              if (ws.bufferedAmount > 1024 * 1024) {
                await new Promise(r => setTimeout(r, 100));
              }
            }
            if (ws.readyState === 1) ws.send(JSON.stringify({ header: { action: 'finish-task', task_id: taskId, streaming: 'duplex' }, payload: { input: {} } }));
          };
          send();
        } else if (evt === 'result-generated') {
          // 取句级文本；sentence_end 的覆盖为准（中间态可能被修正）
          const st = m.payload && m.payload.output && m.payload.output.sentence;
          if (st && st.text) finalText = st.text.trim();
        } else if (evt === 'task-finished') {
          settled = true; clearTimeout(timeout); ws.close();
          resolve(finalText);
        } else if (evt === 'task-failed') {
          settled = true; clearTimeout(timeout); ws.close();
          reject(new Error((m.header && m.header.error_message && m.header.error_message.message) || '识别失败'));
        }
      };
      ws.onerror = () => { if (!settled) { settled = true; clearTimeout(timeout); reject(new Error('语音识别连接失败')); } };
      ws.onclose = () => { if (!settled) { settled = true; clearTimeout(timeout); reject(new Error('语音识别连接中断')); } };
    });
  },

  // ═══ 语音模式（微信式：切换键 + 按住说话） ═══
  toggleVoiceMode() {
    // 移动端已移除语音输入入口（owner 决策：输入法自带语音转文字更方便）——
    // CSS 已隐藏切换键，这里再兜一道，防止窄窗口/外接键盘路径进入
    if (window.matchMedia('(max-width: 768px)').matches) {
      this.toast('手机上直接用输入法的语音转文字更方便哦');
      return;
    }
    if (!this.dashKey()) {
      this.toast('先在「设置 API Key」里填写千问 DashScope Key 才能发语音');
      this.openApiPanel();
      return;
    }
    this.state.voiceMode = !this.state.voiceMode;
    const on = this.state.voiceMode;
    this.el.voiceModeBtn.classList.toggle('active', on);
    this.el.voiceModeBtn.innerHTML = on
      ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><rect x="2" y="6" width="16" height="12" rx="2"/><path d="M22 8v8"/></svg>'
      : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 10v1a7 7 0 0 0 14 0v-1M12 18v4"/></svg>';
    this.el.playerInput.classList.toggle('hidden', on);
    this.el.holdTalkBtn.classList.toggle('hidden', !on);
    this.el.sendBtn.classList.toggle('hidden', on);
    if (on) this.el.playerInput.blur();
    else this.el.playerInput.focus();
  },
  // 按住说话：pointer 事件驱动；滑出按钮 = 取消；超时自动截断
  startHoldTalk(e) {
    e.preventDefault();
    if (this._recording) return;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || !window.MediaRecorder) {
      this.toast('当前环境不支持录音');
      return;
    }
    this._recording = true;
    this._recCanceled = false;
    this.el.holdTalkBtn.classList.add('recording');
    this.el.holdTalkBtn.querySelector('.ht-label').textContent = '松开 发送 · 滑出取消';
    const chunks = [];
    this._recChunks = chunks;
    this._recStart = Date.now();
    navigator.mediaDevices.getUserMedia({ audio: true }).then(stream => {
      if (this._recCanceled) { stream.getTracks().forEach(t => t.stop()); return; }
      this._recStream = stream;
      try {
        this._recorder = new MediaRecorder(stream);
      } catch (err) {
        this._recording = false;
        stream.getTracks().forEach(t => t.stop());
        this.toast('录音启动失败');
        return;
      }
      this._recorder.ondataavailable = (ev) => { if (ev.data && ev.data.size) chunks.push(ev.data); };
      this._recorder.onstop = () => this.finishRecording();
      this._recorder.start();
      // 最长录音时长自动截断
      this._recTimer = setTimeout(() => { if (this._recorder && this._recorder.state === 'recording') this._recorder.stop(); }, this.VOICE_MAX_DUR * 1000);
    }).catch(err => {
      console.error('[getUserMedia]', err);
      this._recording = false;
      this.toast('麦克风权限被拒绝，无法录音');
    });
  },
  endHoldTalk(cancel) {
    if (!this._recording) return;
    this._recording = false;
    clearTimeout(this._recTimer);
    this.el.holdTalkBtn.classList.remove('recording');
    this.el.holdTalkBtn.querySelector('.ht-label').textContent = '按住 说话';
    // 松手时录音器还没起来（getUserMedia 延迟中）→ 一律按取消处理，
    // 否则会在松手后才开始录且无人停止（最长挂到 60s 截断）
    if (!this._recorder) cancel = true;
    if (cancel) this._recCanceled = true;
    if (this._recorder && this._recorder.state === 'recording') this._recorder.stop();
    else if (cancel) this._recChunks = null;
  },
  async finishRecording() {
    if (this._recStream) { this._recStream.getTracks().forEach(t => t.stop()); this._recStream = null; }
    const chunks = this._recChunks;
    this._recorder = null;
    this._recChunks = null;
    if (this._recCanceled || !chunks || !chunks.length) return;
    const dur = Math.round((Date.now() - this._recStart) / 1000);
    if (dur < 1) { this.toast('太短了，按住多说一会儿'); return; }
    const blob = new Blob(chunks, { type: chunks[0].type || 'audio/webm' });
    this.toast('识别中…');
    try {
      const [text, dataURL] = await Promise.all([
        this.transcribeAudio(blob),
        this.blobToDataURL(blob),
      ]);
      if (!text) { this.toast('没听清，再试一次？'); return; }
      this.sendMessage({ text, audio: dataURL, dur });
    } catch (e) {
      console.error('[finishRecording]', e);
      this.toast(e.message === 'NO_VOICE_KEY' ? '请先配置语音 Key' : (e.message || '语音识别失败'));
    }
  },
  applyWallInline(dataURL) {
    const wall = document.getElementById('wall');
    if (!wall) return;
    if (dataURL) wall.style.backgroundImage = `url("${dataURL}")`;
    else wall.style.removeProperty('background-image');
  },
  async initWall() {
    try {
      // 迁移 0.1.4/0.1.5 的 localStorage 旧壁纸数据
      const legacy = localStorage.getItem('aigf_wall');
      if (legacy) { await this.idbSet('wall', legacy); localStorage.removeItem('aigf_wall'); }
      const data = await this.idbGet('wall');
      if (data) {
        this.enableCustomTheme();
        this.applyWallInline(data);
        if (localStorage.getItem('aigf_theme') === 'custom') this.applyTheme();
      }
    } catch (e) { console.error('[initWall]', e); }
  },
  openWallModal() {
    const crop = this.el.wallCrop;
    crop.style.aspectRatio = `${window.innerWidth} / ${window.innerHeight}`;   // 裁剪框 = 屏幕比例
    this.resetWallCropView();
    this.el.wallApplyBtn.style.display = 'none';
    this.el.wallOverlay.classList.remove('hidden');
    this.el.wallModal.classList.remove('hidden');
    this.idbGet('wall').then(has => {
      this.el.wallResetBtn.style.display = has ? '' : 'none';
    }).catch(() => {});
  },
  closeWallModal() {
    this.el.wallOverlay.classList.add('hidden');
    this.el.wallModal.classList.add('hidden');
  },
  resetWallCropView() {
    this._wall = null;
    const cv = this.el.wallCanvas;
    cv.width = 0;
    this.el.wallCropHint.style.display = '';
  },
  // 取景渲染：canvas 尺寸 = 容器 × dpr，按 cover 缩放 + 拖动偏移绘制（issue #15 改版）
  drawWallCrop() {
    const w = this._wall;
    if (!w) return;
    const cv = this.el.wallCanvas;
    const dpr = window.devicePixelRatio || 1;
    const W = Math.round(w.cw * dpr), H = Math.round(w.ch * dpr);
    if (cv.width !== W || cv.height !== H) { cv.width = W; cv.height = H; }
    const ctx = cv.getContext('2d');
    ctx.fillStyle = '#1B2436';
    ctx.fillRect(0, 0, cv.width, cv.height);
    const s = w.scale * dpr;
    ctx.drawImage(w.img, w.dx * dpr, w.dy * dpr, w.iw * s, w.ih * s);
  },
  loadWallFile(file) {
    // 不检查 file.type：Android 相册选图的 MIME 可能为空，交给 Image 加载成败判断
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        const crop = this.el.wallCrop;
        const cw = crop.clientWidth, ch = crop.clientHeight;
        const scale = Math.max(cw / img.naturalWidth, ch / img.naturalHeight);   // cover 铺满
        const dx = (cw - img.naturalWidth * scale) / 2, dy = (ch - img.naturalHeight * scale) / 2;
        this._wall = { img, iw: img.naturalWidth, ih: img.naturalHeight, cw, ch, scale, dx, dy, dataURL: reader.result };
        this.el.wallCropHint.style.display = 'none';
        this.el.wallApplyBtn.style.display = '';
        this.drawWallCrop();
      };
      img.onerror = () => this.toast('图片加载失败，换一张试试');
      img.src = reader.result;
    };
    reader.onerror = () => this.toast('读取图片失败');
    reader.readAsDataURL(file);
  },
  // 取景拖动（pointer 事件统一鼠标/触屏；限制在 cover 范围内不露底）
  bindWallCropDrag() {
    const crop = this.el.wallCrop;
    let dragging = false, sx = 0, sy = 0, sdx = 0, sdy = 0;
    crop.addEventListener('pointerdown', (e) => {
      if (!this._wall) return;
      dragging = true;
      sx = e.clientX; sy = e.clientY; sdx = this._wall.dx; sdy = this._wall.dy;
      crop.classList.add('dragging');
      try { crop.setPointerCapture(e.pointerId); } catch (err) { /* 无活动指针时忽略 */ }
    });
    crop.addEventListener('pointermove', (e) => {
      if (!dragging || !this._wall) return;
      const w = this._wall;
      w.dx = Math.min(0, Math.max(w.cw - w.iw * w.scale, sdx + e.clientX - sx));
      w.dy = Math.min(0, Math.max(w.ch - w.ih * w.scale, sdy + e.clientY - sy));
      this.drawWallCrop();
    });
    const end = () => { dragging = false; crop.classList.remove('dragging'); };
    crop.addEventListener('pointerup', end);
    crop.addEventListener('pointercancel', end);
  },
  async applyWall() {
    const w = this._wall;
    if (!w) { this.toast('先选择一张图片'); return; }
    // 输出 = 取景框视野放大：canvas 尺寸保持屏幕比例，长边 ≤ 上限
    const k = this.WALL_MAX_LONG / Math.max(w.cw, w.ch);
    const W = Math.round(w.cw * k), H = Math.round(w.ch * k);
    const canvas = document.createElement('canvas');
    canvas.width = W; canvas.height = H;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#1B2436';
    ctx.fillRect(0, 0, W, H);
    // 容器视野 → 源图区域反算
    ctx.drawImage(w.img, -w.dx / w.scale, -w.dy / w.scale, w.cw / w.scale, w.ch / w.scale, 0, 0, W, H);
    const dataURL = this.compressCanvas(canvas, this.WALL_TARGET_KB);
    try {
      await this.idbSet('wall', dataURL);
      this.enableCustomTheme();
      localStorage.setItem('aigf_theme', 'custom');
      this.applyTheme();
      this.applyWallInline(dataURL);
      this.el.wallResetBtn.style.display = '';
      this.closeWallModal();
      this.toast('已创建自定义主题');
    } catch (e) {
      console.error('[applyWall]', e);
      this.toast('壁纸保存失败（存储不可用），现有数据未受影响');
    }
  },
  // 自定义主题：存在用户壁纸时加入主题循环（issue #15 交互改版：导入图片创建为新主题）
  enableCustomTheme() {
    if (!this.THEMES.custom) {
      this.THEMES.custom = '自定义';
      this.THEME_ORDER.push('custom');
    }
  },
  async resetWall() {
    if (!confirm('移除自定义壁纸？将恢复内置主题循环。')) return;
    try { await this.idbDel('wall'); } catch (e) { /* 忽略 */ }
    this.applyWallInline(null);
    delete this.THEMES.custom;
    this.THEME_ORDER = this.THEME_ORDER.filter(t => t !== 'custom');
    if (localStorage.getItem('aigf_theme') === 'custom') localStorage.setItem('aigf_theme', 'white');
    this.applyTheme();
    this.el.wallResetBtn.style.display = 'none';
    this.resetWallCropView();
    this.el.wallApplyBtn.style.display = 'none';
    this.toast('已恢复内置主题');
  },

  // ═══ 应用内更新：流式下载 APK（带进度）→ 拉起系统安装器；Web 端回退为直接下载 ═══
  blobToBase64(blob) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result));
      r.onerror = () => reject(new Error('read blob failed'));
      r.readAsDataURL(blob);
    });
  },
  async performUpdate(url) {
    if (!url) { this.toast('更新链接无效'); return; }
    if (this._updateBusy) return;
    this._updateBusy = true;
    const btn = this.el.updateDownloadBtn;
    const prog = this.el.updateProgress;
    const bar = this.el.updateProgressBar;
    const text = this.el.updateProgressText;
    const setPct = (p) => {
      prog.classList.remove('hidden');
      bar.style.width = Math.max(2, Math.min(100, p)) + '%';
      text.textContent = p >= 100 ? '下载完成，准备安装…' : '下载中 ' + Math.round(p) + '%';
    };
    btn.disabled = true;
    const fname = 'moonveil-' + (this.el.updateDownloadBtn.dataset.version || APP_VERSION) + '.apk';
    const cap = window.Capacitor;
    const capFs = (cap && cap.Plugins && cap.Plugins.Filesystem) || null;
    const capOpener = (cap && cap.Plugins && cap.Plugins.FileOpener) || null;
    const native = !!(cap && cap.isNativePlatform && cap.isNativePlatform());
    try {
      const resp = await fetch(url, { cache: 'no-store' });
      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      const total = Number(resp.headers.get('content-length')) || 0;
      const reader = resp.body && resp.body.getReader ? resp.body.getReader() : null;
      const chunks = [];
      let received = 0;
      setPct(0);
      if (reader) {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(value);
          received += value.length;
          if (total) setPct((received / total) * 100);
        }
      } else {
        chunks.push(new Uint8Array(await resp.arrayBuffer()));
      }
      const blob = new Blob(chunks, { type: 'application/vnd.android.package-archive' });
      if (native && capFs) {
        // 应用内更新：写应用缓存 → FileOpener（内置 FileProvider）拉起系统安装器
        const dataUrl = await this.blobToBase64(blob);
        const b64 = dataUrl.split(',')[1];
        const w = await capFs.writeFile({ path: fname, directory: 'CACHE', data: b64, recursive: true });
        setPct(100);
        if (capOpener && typeof capOpener.open === 'function' && w && w.uri) {
          await capOpener.open({ filePath: w.uri, contentType: 'application/vnd.android.package-archive' });
          this.toast('若提示「未知来源」，请在系统弹窗中允许后继续安装');
          this.closeUpdate();
        } else {
          // FileOpener 缺失降级：写公共 Documents，引导文件管理器安装
          await capFs.writeFile({ path: fname, directory: 'DOCUMENTS', data: b64, recursive: true });
          this.toast('已下载到 Documents/' + fname + '，请在文件管理器中安装');
          this.closeUpdate();
        }
      } else {
        // Web 端：Blob 触发浏览器下载
        const objUrl = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = objUrl;
        a.download = fname;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(objUrl), 8000);
        setPct(100);
        this.toast('APK 已开始下载，完成后打开安装');
        this.closeUpdate();
      }
    } catch (e) {
      console.error('[performUpdate]', e);
      prog.classList.add('hidden');
      this.toast('更新下载失败，请稍后再试');
    } finally {
      this._updateBusy = false;
      btn.disabled = false;
    }
  },

  // ═══ 复制更新下载链接（WebView 拦截/系统浏览器未打开时的兜底通道）═══
  copyUpdateUrl() {
    const url = this.el.updateDownloadBtn.dataset.url;
    if (!url) return;
    const done = () => this.toast('下载链接已复制，粘贴到浏览器打开即可');
    const fail = () => this.toast('复制失败，请长按记录链接：' + url);
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(url).then(done).catch(fail);
    } else {
      fail();
    }
  },

  // ═══ 存档管理（手动导出/导入聊天记录） ═══
  openBackup() {
    this.renderSaveSlots();
    this.el.backupOverlay.classList.remove('hidden');
    this.el.backupModal.classList.remove('hidden');
  },

  // ═══ 快照槽位（HELIOS 式 · 纯 localStorage，移动端零依赖） ═══
  SNAPSHOT_SLOTS: 3,
  snapKey(i) { return 'aigf_snap_' + i; },
  collectData() {
    return {
      app: 'moonveil',
      savedAt: new Date().toISOString(),
      version: APP_VERSION,
      histories: this.state.histories,
      favs: this.state.favs,
      memories: this.state.memories,
      corrections: this.state.corrections,
      customGfs: this.state.customGfs,
      enabledGfs: [...this.state.enabledGfs],   // 角色库启用集随档迁移（issue #7：旧档无此字段保持本机现状）
    };
  },
  restoreData(data) {
    this.state.histories = {};
    this.state.favs = {};
    this.state.memories = {};
    this.state.corrections = {};
    // 先恢复自定义角色定义（否则遍历不到存档里的自定义角色）
    this.state.customGfs = {};
    const cg = data.customGfs || {};
    for (const id of Object.keys(cg)) {
      if (cg[id] && cg[id].name && cg[id].prompt) this.state.customGfs[id] = cg[id];
    }
    this.saveCustomGfs();
    // 角色库启用集（issue #7）：随档恢复；旧档无此字段时保持本机现状不覆盖
    if (Array.isArray(data.enabledGfs)) {
      this.state.enabledGfs = new Set(data.enabledGfs.filter(id => this.allGfs()[id]));
      if (this.state.enabledGfs.size === 0) this.state.enabledGfs = new Set([Object.keys(this.allGfs())[0]]);
      this.saveEnabledGfs();
    }
    for (const id of Object.keys(this.allGfs())) {
      this.state.histories[id] = Array.isArray(data.histories[id]) ? data.histories[id] : [];
      this.state.favs[id] = Array.isArray(data.favs && data.favs[id]) ? data.favs[id] : [];
      this.state.memories[id] = Array.isArray(data.memories && data.memories[id]) ? data.memories[id] : [];
      this.state.corrections[id] = Array.isArray(data.corrections && data.corrections[id]) ? data.corrections[id] : [];
      this.saveHistory(id);
      this.saveFavs(id);
      this.saveMemories(id);
      this.saveCorrections(id, this.state.corrections[id]);
    }
    this.renderGfList();
    if (!this.allGfs()[this.state.currentGf] || !this.state.enabledGfs.has(this.state.currentGf)) {
      this.switchGf(this.firstEnabledGfId(), true);   // 恢复的目标角色已不存在或已停用 → 回落首个启用角色
    }
    else this.renderHistory();
  },
  renderSaveSlots() {
    const wrap = document.getElementById('save-slots');
    if (!wrap) return;
    let html = '';
    for (let i = 0; i < this.SNAPSHOT_SLOTS; i++) {
      let snap = null;
      try {
        const raw = localStorage.getItem(this.snapKey(i));
        if (raw) snap = JSON.parse(raw);
      } catch (e) { snap = null; }
      const filled = !!snap;
      let meta = '空';
      if (filled) {
        const d = new Date(snap.savedAt);
        const timeStr = `${d.getMonth() + 1}月${d.getDate()}日 ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
        const msgCount = Object.values(snap.histories || {}).reduce((n, arr) => n + (Array.isArray(arr) ? arr.length : 0), 0);
        meta = `${timeStr} · ${msgCount} 条消息`;
      }
      html += `<div class="save-slot ${filled ? 'filled' : 'empty'}">`;
      html += `<div class="save-slot-header">快照 ${i + 1}<span class="save-slot-meta">${this.esc(meta)}</span></div>`;
      html += `<div class="save-slot-actions">`;
      if (filled) {
        html += `<button class="save-action-btn" data-slot="${i}" data-act="restore">恢复</button>`;
        html += `<button class="save-action-btn" data-slot="${i}" data-act="overwrite">覆盖</button>`;
        html += `<button class="save-action-btn danger" data-slot="${i}" data-act="delete">删除</button>`;
      } else {
        html += `<button class="save-action-btn primary" data-slot="${i}" data-act="save">保存当前</button>`;
      }
      html += `</div></div>`;
    }
    wrap.innerHTML = html;
    wrap.querySelectorAll('.save-action-btn').forEach(btn => {
      btn.addEventListener('click', () => this.handleSaveAction(parseInt(btn.dataset.slot, 10), btn.dataset.act));
    });
  },
  handleSaveAction(slot, act) {
    if (act === 'save' || act === 'overwrite') {
      if (act === 'overwrite' && !confirm('覆盖快照 ' + (slot + 1) + '？该位置原有快照将被替换。')) return;
      try {
        localStorage.setItem(this.snapKey(slot), JSON.stringify(this.stripHistImgs(this.collectData())));
        this.toast('已保存到快照 ' + (slot + 1));
      } catch (e) {
        console.error('[saveSnapshot]', e);
        this.toast('保存失败：本机存储空间不足');
      }
    } else if (act === 'restore') {
      if (!confirm('恢复快照 ' + (slot + 1) + '？当前所有聊天与记忆将被快照内容覆盖。')) return;
      try {
        const snap = JSON.parse(localStorage.getItem(this.snapKey(slot)));
        this.restoreData(snap);
        this.toast('已恢复快照 ' + (slot + 1));
      } catch (e) {
        console.error('[restoreSnapshot]', e);
        this.toast('恢复失败：快照数据无效');
      }
    } else if (act === 'delete') {
      if (!confirm('删除快照 ' + (slot + 1) + '？此操作不可恢复。')) return;
      localStorage.removeItem(this.snapKey(slot));
      this.toast('已删除快照 ' + (slot + 1));
    }
    this.renderSaveSlots();
  },
  closeBackup() {
    this.el.backupOverlay.classList.add('hidden');
    this.el.backupModal.classList.add('hidden');
  },
  // ── 导出为 .md 文件：手机端写入公共 Documents 目录，网页端触发下载 ──
  archiveStamp() {
    const d = new Date(), p = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
  },
  buildArchiveMarkdown(data) {
    // 用四反引号围栏：JSON 内可能含 ```（模型思考文本），三反引号会被提前截断
    // 图片 dataURL 剥离为 [图片] 占位（issue #8）：导出体积可控，已知限制
    const json = JSON.stringify(this.stripHistImgs(data), null, 2);
    const d = new Date(), p = n => String(n).padStart(2, '0');
    const time = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
    const msgs = Object.values(data.histories || {}).reduce((n, arr) => n + (Array.isArray(arr) ? arr.length : 0), 0);
    const gfs = Object.keys(data.histories || {}).filter(id => (data.histories[id] || []).length).length;
    return [
      '# 月见 Moonveil 存档',
      '',
      `> 导出时间：${time}  `,
      `> 应用版本：v${data.version} · ${gfs} 位角色 · ${msgs} 条消息`,
      '',
      '本文件由「月见 Moonveil」导出，用于备份或跨设备迁移。',
      '在 **存档管理 → 导入存档文件** 中选择本文件即可完整恢复。',
      '',
      '## 存档数据',
      '',
      '````json',
      json,
      '````',
      '',
      '> ⚠️ 请勿修改上方代码块内的数据，否则将无法导入。',
      '',
    ].join('\n');
  },
  async exportBackup() {
    const data = this.collectData();
    const md = this.buildArchiveMarkdown(data);
    const fname = 'moonveil-存档-' + this.archiveStamp() + '.md';
    // ① Capacitor 原生（Android）：写公共 Documents，文件管理器可见
    const cap = window.Capacitor;
    const capFs = (cap && cap.Plugins && cap.Plugins.Filesystem) || null;
    if (capFs && cap.isNativePlatform && cap.isNativePlatform()) {
      try {
        await capFs.writeFile({ path: fname, data: md, directory: 'DOCUMENTS', encoding: 'utf8', recursive: true });
        this.toast('已导出到 手机存储/Documents/' + fname);
        return;
      } catch (e) {
        console.error('[exportBackup] DOCUMENTS 写入失败', e);
        this.toast('导出失败：' + (e && e.message ? e.message : '存储写入被拒绝'));
        return;
      }
    }
    // ② Web（桌面 / 移动网页版）：Blob 下载真实文件
    try {
      const blob = new Blob([md], { type: 'text/markdown;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = fname;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 4000);
      this.toast('存档文件已开始下载');
    } catch (e) {
      console.error('[exportBackup] web 下载失败', e);
      this.toast('导出失败，请重试');
    }
  },
  // ── 导入兼容三种形态：纯 JSON 存档 / .md 存档（代码块内 JSON）/ 容错围栏 ──
  parseArchiveText(text) {
    try {
      const d = JSON.parse(text);
      if (d && typeof d === 'object') return d;
    } catch (e) { /* 不是纯 JSON，尝试 Markdown 代码块 */ }
    // 终止符须 ≥4 反引号：消息内容里可能含 ```（三反引号），三反引号围栏会被提前截断
    const m = text.match(/`{4,}json\s*([\s\S]*?)\s*`{4,}/) || text.match(/`{3,}\s*([\s\S]*?)\s*`{3,}/);
    if (m) return JSON.parse(m[1].trim());
    throw new Error('no archive data found');
  },
  importBackup(file) {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const data = this.parseArchiveText(reader.result);
        if (data.app !== 'moonveil' || !data.histories || typeof data.histories !== 'object') {
          throw new Error('bad format');
        }
        if (!confirm('导入将覆盖当前全部聊天记录，确定继续？')) return;
        this.restoreData(data);
        this.toast('存档已导入');
      } catch (e) {
        console.error('[importBackup]', e);
        this.toast('存档文件无效，请检查');
      }
    };
    reader.readAsText(file);
  },

  // ═══ 持久化 ═══
  // 深拷贝并剥离历史媒体 dataURL（issue #8 图片 / #38 语音）：存档 .md / 快照不内联 base64
  // （体积可控、避免 localStorage 配额爆），降级为 imgLost/audioLost 标记 → 导入后渲染占位，文字保留
  stripHistImgs(data) {
    const clone = JSON.parse(JSON.stringify(data));
    for (const arr of Object.values(clone.histories || {})) {
      if (!Array.isArray(arr)) continue;
      for (const m of arr) {
        if (m && m.img) { delete m.img; m.imgLost = true; }
        if (m && m.audio) { delete m.audio; delete m.dur; m.audioLost = true; }
      }
    }
    return clone;
  },
  // ── 角色：内置两位（data.js GIRLFRIENDS）+ 用户自建角色（localStorage） ──
  allGfs() {
    return Object.assign({}, GIRLFRIENDS, this.state.customGfs);
  },
  loadCustomGfs() {
    try {
      const raw = localStorage.getItem('aigf_custom_gfs');
      const arr = raw ? JSON.parse(raw) : [];
      this.state.customGfs = {};
      for (const g of (Array.isArray(arr) ? arr : [])) {
        if (g && g.id && g.name && g.prompt) this.state.customGfs[g.id] = g;
      }
    } catch (e) {
      this.state.customGfs = {};
    }
  },
  saveCustomGfs() {
    try {
      localStorage.setItem('aigf_custom_gfs', JSON.stringify(Object.values(this.state.customGfs)));
    } catch (e) { console.error('[saveCustomGfs]', e); }
  },
  // ── 角色库（issue #7）：启用集持久化 + 启停 + 回落 ──
  // 未初始化记录（老用户升级/新装首启）→ 默认集兜底（既有内置角色全启用，升级无损）。
  // 停用不删任何数据：histories/favs/memories/corrections 按 gfId 存 localStorage，重新启用即恢复。
  loadEnabledGfs() {
    let ids = null;
    try {
      const raw = localStorage.getItem('aigf_gf_enabled');
      if (raw) {
        const arr = JSON.parse(raw);
        if (Array.isArray(arr)) ids = arr.filter(x => typeof x === 'string');
      }
    } catch (e) { /* 解析失败回落默认 */ }
    if (!ids) ids = this.DEFAULT_ENABLED_IDS.slice();   // 首启：默认集（新内置角色不自动出现）
    this.state.enabledGfs = new Set(ids.filter(id => this.allGfs()[id]));
    if (this.state.enabledGfs.size === 0) this.state.enabledGfs = new Set([Object.keys(this.allGfs())[0]]);
    this.saveEnabledGfs();
  },
  saveEnabledGfs() {
    try { localStorage.setItem('aigf_gf_enabled', JSON.stringify([...this.state.enabledGfs])); }
    catch (e) { console.error('[saveEnabledGfs]', e); }
  },
  firstEnabledGfId() {
    return Object.keys(this.allGfs()).find(id => this.state.enabledGfs.has(id)) || null;
  },
  // 启停切换：停用当前会话角色时自动回落到首个启用角色；至少保留一位启用
  setGfEnabled(id, on) {
    if (!this.allGfs()[id] || !this.state.enabledGfs) return false;
    if (on) this.state.enabledGfs.add(id);
    else {
      if (this.state.enabledGfs.size <= 1) { this.toast('至少保留一位启用的角色'); return false; }
      this.state.enabledGfs.delete(id);
    }
    this.saveEnabledGfs();
    return true;
  },
  // 删除自建角色（与停用不同：连同本地数据一起清，二次确认）
  removeCustomGf(id) {
    const gf = this.state.customGfs[id];
    if (!gf) return;
    if (!confirm('删除角色「' + gf.name + '」？聊天记录与记忆将一并删除，不可恢复。')) return;
    delete this.state.customGfs[id];
    delete this.state.histories[id];
    delete this.state.favs[id];
    delete this.state.memories[id];
    delete this.state.corrections[id];
    try {
      localStorage.removeItem(this.histKey(id));
      localStorage.removeItem(this.favsKey(id));
      localStorage.removeItem(this.memsKey(id));
    } catch (e) { /* 忽略 */ }
    this.saveCustomGfs();
    if (this.state.enabledGfs.has(id)) { this.state.enabledGfs.delete(id); this.saveEnabledGfs(); }
    if (this.state.currentGf === id) {
      const fallback = this.firstEnabledGfId();
      if (fallback) this.switchGf(fallback);
    }
    this.renderGfList();
    this.renderLibraryList();
    this.toast('已删除「' + gf.name + '」');
  },
  nextId() {
    const n = this._idSeq = (this._idSeq || 0) + 1;
    return Date.now().toString(36) + '-' + n.toString(36);
  },
  histKey(id) { return 'aigf_hist_' + id; },
  favsKey(id) { return 'aigf_favs_' + id; },
  memsKey(id) { return 'aigf_mem_' + id; },
  loadAllHistories() {
    for (const id of Object.keys(this.allGfs())) {
      try {
        const raw = localStorage.getItem(this.histKey(id));
        const arr = raw ? JSON.parse(raw) : [];
        if (Array.isArray(arr)) {
          for (const m of arr) if (!m.id) m.id = this.nextId();   // 兼容旧存档，补历史项 id
        }
        this.state.histories[id] = Array.isArray(arr) ? arr : [];
      } catch (e) {
        this.state.histories[id] = [];
      }
      // 喜好与回忆（自动提取的卡片数据）+ Correction 规则
      for (const kind of ['favs', 'memories']) {
        const key = kind === 'favs' ? this.favsKey(id) : this.memsKey(id);
        try {
          const raw = localStorage.getItem(key);
          const arr = raw ? JSON.parse(raw) : [];
          this.state[kind][id] = Array.isArray(arr) ? this.normMemList(arr) : [];
        } catch (e) {
          this.state[kind][id] = [];
        }
      }
      this.state.corrections[id] = this.normMemList(this.loadCorrections(id));
    }
  },
  // 旧记忆数据无感升级：补 id / pinned / source 默认值（id 用 ts 派生 + 随机后缀防同毫秒冲突）
  normMemList(arr) {
    for (const e of arr) {
      if (!e.id) e.id = this.genMemId(e.ts);
      if (typeof e.pinned !== 'boolean') e.pinned = false;
      if (!e.source) e.source = 'auto';
    }
    return arr;
  },
  genMemId(ts) {
    return 'me' + (ts || Date.now()).toString(36) + Math.random().toString(36).slice(2, 6);
  },
  // FIFO 淘汰：超出上限时从最旧开始移除未置顶条目；全部置顶则不淘汰
  evictOldest(arr, max) {
    while (arr.length > max) {
      const idx = arr.findIndex(e => !e.pinned);
      if (idx < 0) break;
      arr.splice(idx, 1);
    }
  },
  saveHistory(id) {
    // 图片配额保护（issue #8）：每女友历史最多保留 MAX_IMGS 张图，
    // 超限从最旧开始降级——删 dataURL、置 imgLost，渲染为 [图片] 占位，文字永不丢
    // 语音同模式（issue #38）：MAX_AUDIOS 条，最旧降级 [语音] 占位
    const arr = this.state.histories[id];
    if (Array.isArray(arr)) {
      let count = arr.reduce((n, m) => n + (m && m.img ? 1 : 0), 0);
      for (const m of arr) {
        if (count <= this.MAX_IMGS) break;
        if (m && m.img) { delete m.img; m.imgLost = true; count--; }
      }
      let acount = arr.reduce((n, m) => n + (m && m.audio ? 1 : 0), 0);
      for (const m of arr) {
        if (acount <= this.MAX_AUDIOS) break;
        if (m && m.audio) { delete m.audio; delete m.dur; m.audioLost = true; acount--; }
      }
    }
    try { localStorage.setItem(this.histKey(id), JSON.stringify(this.state.histories[id] || [])); }
    catch (e) { console.error('[saveHistory]', e); }
  },
  saveFavs(id) {
    try { localStorage.setItem(this.favsKey(id), JSON.stringify(this.state.favs[id] || [])); }
    catch (e) { console.error('[saveFavs]', e); }
  },
  saveMemories(id) {
    try { localStorage.setItem(this.memsKey(id), JSON.stringify(this.state.memories[id] || [])); }
    catch (e) { console.error('[saveMemories]', e); }
  },

  // ═══ 角色列表渲染（侧栏 + 底部导航；issue #7：仅已启用角色） ═══
  renderGfList() {
    const listHtml = Object.values(this.allGfs())
      .filter(gf => this.state.enabledGfs && this.state.enabledGfs.has(gf.id))
      .map(gf => `
      <div class="gf-card" data-gf="${gf.id}">
        <img class="gf-card-avatar" src="${gf.avatar}" alt="">
        <div>
          <div class="gf-card-name">${gf.name}</div>
          <div class="gf-card-tag">${gf.tag}</div>
        </div>
      </div>`).join('');
    this.el.gfList.innerHTML = listHtml + `
      <div class="gf-card gf-card-add" id="gf-library-btn" role="button" tabindex="0">
        <div class="gf-card-avatar avatar-add"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><path d="M17.5 14.5v7M14 18h7"/></svg></div>
        <div>
          <div class="gf-card-name">角色库</div>
          <div class="gf-card-tag">启用 / 停用 · 创建新角色</div>
        </div>
      </div>`;

  },

  // ═══ 角色库弹层（issue #7：内置/自建两组 + 启停开关；停用不删数据） ═══
  renderLibraryList() {
    const all = this.allGfs();
    const row = (gf, custom) => `
      <div class="lib-row" data-lib-gf="${gf.id}">
        <img class="lib-avatar" src="${gf.avatar}" alt="">
        <div class="lib-info">
          <div class="lib-name">${gf.name}${gf.mbti ? ' <span class="lib-mbti">' + gf.mbti + '</span>' : ''}</div>
          <div class="lib-tag">${gf.tag || ''}</div>
        </div>
        ${custom ? '<button class="lib-del" data-lib-del="' + gf.id + '" title="删除角色" aria-label="删除角色">删除</button>' : ''}
        <button class="lib-toggle${this.state.enabledGfs.has(gf.id) ? ' on' : ''}" data-lib-toggle="${gf.id}" role="switch"
          aria-checked="${this.state.enabledGfs.has(gf.id)}" aria-label="启用 ${gf.name}" tabindex="0"></button>
      </div>`;
    const builtin = Object.values(all).filter(g => !g.id.startsWith('custom_')).map(g => row(g, false)).join('');
    const customs = Object.values(all).filter(g => g.id.startsWith('custom_')).map(g => row(g, true)).join('');
    this.el.libraryList.innerHTML = `
      <div class="lib-group-title">内置角色</div>
      ${builtin || '<div class="lib-empty">暂无</div>'}
      <div class="lib-group-title">我的角色 · 自建</div>
      ${customs || '<div class="lib-empty">还没有自建角色，点下方「创建自定义角色」试试</div>'}`;
  },
  openLibraryModal() {
    this.renderLibraryList();
    this.el.libraryOverlay.classList.remove('hidden');
  },
  closeLibraryModal() {
    this.el.libraryOverlay.classList.add('hidden');
  },

  // ═══ 切换女友 ═══
  // silent（issue #53）：初始化/恢复存档跳过切换编排（无旧内容可退出）
  switchGf(id, silent) {
    const gf = this.allGfs()[id];
    if (!gf) return;
    this.state.currentGf = id;
    this.state.unread[id] = 0;
    this.clearQuote(true);   // 引用不跨角色残留（issue #2 ①）
    // 自定义角色主题色：inline 注入基础色相进派生体系（issue #11）——
    // 仅自定义角色（data.js 的 color 字段是头像用色，不注入）；传空清除 inline 让内置 CSS 块生效
    document.body.style.setProperty('--gf-color-base', id.startsWith('custom_') ? (gf.color || '') : '');

    // 主题色随角色切换
    this.el.body.setAttribute('data-gf', id);
    document.title = gf.name + ' · 月见';

    // 侧栏高亮
    document.querySelectorAll('.gf-card').forEach(c => {
      c.classList.toggle('active', c.dataset.gf === id);
    });
    this.refreshNavUnread();

    // 该女友的流已结束（历史已保存）时，清掉其队列残留，避免与 renderHistory 重复渲染
    if (this.state.activeStreamGf !== id) {
      this.state.bubbleQueue = this.state.bubbleQueue.filter(i => i.gfId !== id);
    }

    // 切换编排与探针（issue #26/#53）：退出淡出 → 内容替换 → 淡入上移；
    // 长对话先上骨架再分批渲染。快速连切时 currentGf 守卫丢弃过期渲染。
    const histLen = (this.state.histories[id] || []).length;
    const areaEl = this.el.dialogueArea;
    const infoEl = this.el.gfInfo;
    const t0 = performance.now();
    const finishSwitch = () => {
      // 顶栏（进入阶段随内容一起换，crossfade 自然）
      this.el.topAvatar.src = gf.avatar;
      this.el.topName.textContent = gf.name;
      this.el.topStatusText.textContent = gf.status;
      if (histLen > this.RENDER_BATCH) {
        areaEl.innerHTML = this.SKELETON_HTML;
        setTimeout(() => {
          if (this.state.currentGf !== id) return;   // 骨架期间已切走
          this.renderHistory();
          const ms = Math.round(performance.now() - t0);
          console.debug('[perf] 切换 ' + gf.name + '：' + ms + 'ms（首屏 ' + Math.min(histLen, this.RENDER_BATCH) + '/' + histLen + ' 条）');
        }, 80);   // 让骨架至少完整绘制一帧，渲染间隙不再是空白
      } else {
        this.renderHistory();
        const ms = Math.round(performance.now() - t0);
        console.debug('[perf] 切换 ' + gf.name + '：' + ms + 'ms（' + histLen + ' 条）');
      }
      // 进入动画（class 重放：强制 reflow 重置；issue #56：快速淡入，无两段编排）
      if (!silent) {
        areaEl.classList.remove('switch-enter'); void areaEl.offsetWidth; areaEl.classList.add('switch-enter');
        infoEl.classList.remove('switch-enter'); void infoEl.offsetWidth; infoEl.classList.add('switch-enter');
      }
    };
    finishSwitch();   // issue #56：瞬时呈现最新会话界面（无 leave 空窗），仅快速淡入
    this.updateApiStatus();
    this.closeMsgMenu();         // 切女友时关闭消息右键菜单
    this.closeInputPlusMenu();   // 切女友时收起「+」抽屉（issue #30）
    this.closeVoiceMenu();       // 连带音色列表（issue #73）
    this.applyGfWall();          // 角色专属聊天背景接管（issue #69）
    // 不再自动 focus 输入框（issue #53）：移动端切会话弹键盘打断浏览；用户点击输入框时再聚焦
  },

  // ═══ 角色专属主题壁纸（issue #65 重定义）═══
  // 仅在「角色专属」主题下生效：当前角色有视觉包 → **立绘 hero 作聊天壁纸**接管 #wall；
  // 无包角色 → 无壁纸。其它主题（纯白/纯黑/自定义）完全不受角色包影响。
  // 个人主页回归纯白样式——立绘不再上主页（has-hero 门控已退役）。
  applyGfWall() {
    if (document.documentElement.getAttribute('data-theme') !== 'gf') return;
    const pack = this.getVisualPack(this.state.currentGf);
    this.applyWallInline(pack && pack.hero ? pack.hero : null);
  },

  // ═══ 视觉包通用注册表（issue #99 阶段一）═══
  // 内置角色走静态 map；自建角色读自身 visual 字段（{hero, chatWall}，assets/ 相对路径），
  // 随 customGfs 一同持久化与存档导出。设置入口：App.setCustomVisual(id, hero, chatWall)。
  getVisualPack(gfId) {
    if (this.VISUAL_PACKS[gfId]) return this.VISUAL_PACKS[gfId];
    const cg = this.state.customGfs[gfId];
    if (cg && cg.visual && (cg.visual.hero || cg.visual.chatWall)) {
      // 旧自建数据 chatWall 语义已废——统一映射到 hero（新语义=聊天壁纸）
      const v = cg.visual;
      return { hero: v.hero || v.chatWall };
    }
    return null;
  },
  // 设置/清除自建角色的专属视觉包（内置 id 忽略——静态包不可覆盖）
  setCustomVisual(id, hero, chatWall) {
    const cg = this.state.customGfs[id];
    if (!cg) { this.toast('只有自建角色可以挂载视觉包'); return; }
    if (this.VISUAL_PACKS[id]) { this.toast('内置角色的视觉包不可覆盖'); return; }
    const heroOk = typeof hero === 'string' && hero.trim();
    const wallOk = typeof chatWall === 'string' && chatWall.trim();
    if (!heroOk && !wallOk) { delete cg.visual; }
    else {
      cg.visual = {
        ...(heroOk ? { hero: hero.trim() } : {}),
        ...(wallOk ? { chatWall: chatWall.trim() } : {}),
      };
    }
    this.saveCustomGfs();
    this.applyGfWall();
    this.toast(heroOk || wallOk ? '专属视觉已更新' : '专属视觉已清除');
  },

  // ═══ 未读刷新（底栏已移除；unread 计数保留，切回该女友时清零） ═══
  refreshNavUnread() { /* 预留：侧栏女友卡未读角标 */ },

  // ═══ 渲染对话历史 ═══
  // ═══ 渲染对话历史（issue #26：首屏分批 + 向上懒加载，长对话不再全量重建）═══
  RENDER_BATCH: 50,      // 首屏与每次向上加载的消息条数（issue #56：owner 指定 50）
  // 切换骨架（issue #26）：三条仿气泡呼吸占位，仅长对话显示
  SKELETON_HTML: `
    <div class="hist-skeleton" aria-hidden="true">
      <div class="sk-msg gf"><div class="sk-avatar"></div><div class="sk-bubble" style="width:62%"></div></div>
      <div class="sk-msg player"><div class="sk-bubble" style="width:44%"></div></div>
      <div class="sk-msg gf"><div class="sk-avatar"></div><div class="sk-bubble" style="width:70%"></div></div>
    </div>`,
  _histObserver: null,   // 顶部哨兵观察器（每次 renderHistory 重建）
  _renderStart: 0,       // 当前已渲染窗口在 hist 中的起始下标
  _loadingOlder: false,
  _segCache: new Map(),  // m.id → 拆条结果缓存（消息内容按 id 不可变，切回免重复拆分）
  renderHistory() {
    this.disconnectHistObserver();
    const area = this.el.dialogueArea;
    area.innerHTML = '';
    const hist = this.state.histories[this.state.currentGf] || [];

    if (hist.length === 0) {
      // 首次进入：女友发来开场白
      const gf = this.allGfs()[this.state.currentGf];
      const mid = this.nextId();
      hist.push({ role: 'gf', text: gf.greeting, ts: Date.now(), id: mid });
      this.state.histories[this.state.currentGf] = hist;
      this.saveHistory(this.state.currentGf);
      this.appendMessage('gf', gf.greeting, false, null, mid);
      this.updateApiStatus();
      return;
    }

    // 首屏窗口：最近 RENDER_BATCH 条；起点向前对齐到时间分隔条边界（最多回看 10 条），窗口首条必带分隔条
    this._renderStart = this.alignBatchStart(hist, Math.max(0, hist.length - this.RENDER_BATCH));

    if (this._renderStart > 0) area.appendChild(this.buildSentinel());
    const frag = document.createDocumentFragment();
    this.renderSlice(hist, this._renderStart, hist.length, frag);
    area.appendChild(frag);
    this.observeHistSentinel();
    // 贴底多重校准（issue #61）：切换瞬间布局未稳定（scrollHeight≈视口高）导致
    // scrollToBottom 无效，图片解码撑高内容后视口停在顶部——用户看到最旧消息。
    // 立即贴底 + rAF/200ms/600ms 三次校准（用户手动滚动则让位，_pinnedToBottom 由 scroll 监听维护）
    this._pinnedToBottom = true;
    this.scrollToBottom(false);
    requestAnimationFrame(() => { if (this._pinnedToBottom) this.scrollToBottom(false); });
    setTimeout(() => { if (this._pinnedToBottom) this.scrollToBottom(false); }, 200);
    setTimeout(() => { if (this._pinnedToBottom) this.scrollToBottom(false); }, 600);
  },

  // 窗口起点向前对齐：找到第一个「距上一条 ≥5 分钟」的边界（最多回看 10 条防病态数据）
  alignBatchStart(hist, start) {
    for (let i = start; i > Math.max(0, start - 10); i--) {
      const ts = (hist[i] || {}).ts || 0, prev = (hist[i - 1] || {}).ts || 0;
      if (ts && prev && ts - prev >= 5 * 60 * 1000) return i;
    }
    return start;
  },

  // 渲染 [from, to) 区间进 frag（分隔条/独白/拆条逻辑与旧全量渲染一致）
  renderSlice(hist, from, to, frag) {
    let lastTs = 0;
    for (let i = from; i < to; i++) {
      const m = hist[i];
      const ts = m.ts || 0;
      if (ts && ts - lastTs >= 5 * 60 * 1000) this.appendTimeDivider(ts, frag);
      if (ts) lastTs = ts;
      if (m.role === 'gf') {
        // 内心独白（💭 ta的独白）：整组回复渲染一次，置于首条气泡上方
        if (m.inner) this.appendReasoningBlock(m.id, m.inner, frag);   // 💭 ta的独白（issue #12：只渲染 <inner> 协议字段；旧 reasoning=思维链不再展示，数据保留）
        // 同一次回复的多个气泡（\n 分隔）拆成多条渲染
        // 语音气泡模式（issue #13）：整条回复 = 一整段语音气泡（动作描写剥离，带情绪演绎）
        if (m.vmode) {
          this.appendMessage('gf', m.text, true, null, m.id, null, frag, { speak: this.stripActionText(m.text) || m.text, idx: 0 });
        } else {
          for (const seg of this.segsOf(m)) {
            if (seg.trim()) this.appendMessage('gf', seg, true, null, m.id, null, frag);
          }
        }
      } else {
        this.appendMessage(m.role, m.text, true, null, m.id, {
          img: m.img || (m.imgLost ? 'LOST' : null),
          audio: m.audio,
          audioLost: m.audioLost,
          dur: m.dur,
        }, frag);
      }
    }
  },

  // 拆条缓存：文本按消息 id 不可变，切回复用
  segsOf(m) {
    if (!m.id) return m.text.split('\n');
    let segs = this._segCache.get(m.id);
    if (!segs) { segs = m.text.split('\n'); this._segCache.set(m.id, segs); }
    return segs;
  },

  buildSentinel() {
    const s = document.createElement('div');
    s.id = 'hist-sentinel';
    const tip = document.createElement('div');
    tip.className = 'hist-older-tip';
    tip.textContent = '—— 上翻加载更早的对话 ——';
    s.appendChild(tip);
    return s;
  },

  observeHistSentinel() {
    const area = this.el.dialogueArea;
    const sentinel = area.querySelector('#hist-sentinel');
    if (!sentinel) return;
    this._histObserver = new IntersectionObserver((entries) => {
      if (entries.some(en => en.isIntersecting)) this.loadOlderBatch();
    }, { root: area, rootMargin: '160px 0px 0px 0px' });
    this._histObserver.observe(sentinel);
  },

  disconnectHistObserver() {
    if (this._histObserver) { this._histObserver.disconnect(); this._histObserver = null; }
  },

  // 向上加载更早一批：插入到哨兵之后，scrollTop 补偿保持视口不跳
  loadOlderBatch() {
    if (this._loadingOlder) return;
    const area = this.el.dialogueArea;
    const hist = this.state.histories[this.state.currentGf] || [];
    const start = this._renderStart;
    if (start <= 0) { this.disconnectHistObserver(); const s = area.querySelector('#hist-sentinel'); if (s) s.remove(); return; }
    this._loadingOlder = true;
    try {
      const newStart = this.alignBatchStart(hist, Math.max(0, start - this.RENDER_BATCH));
      if (newStart >= start) { this.disconnectHistObserver(); const s = area.querySelector('#hist-sentinel'); if (s) s.remove(); return; }
      const prevH = area.scrollHeight, prevTop = area.scrollTop;
      const frag = document.createDocumentFragment();
      this.renderSlice(hist, newStart, start, frag);
      const sentinel = area.querySelector('#hist-sentinel');
      // 新批次插在哨兵之后（哨兵必须始终保持最顶，否则后续批次会插进已加载内容中间）
      if (sentinel) sentinel.after(frag); else area.prepend(frag);
      this._renderStart = newStart;
      area.scrollTop = prevTop + (area.scrollHeight - prevH);
      if (newStart === 0) { this.disconnectHistObserver(); if (sentinel) sentinel.remove(); }
    } finally { this._loadingOlder = false; }
  },

  // ═══ 时间分隔条（≥5 分钟间隔显示，淡雅小字） ═══
  appendTimeDivider(ts, target) {
    const d = new Date(ts);
    const now = new Date();
    const hm = String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
    let label;
    if (d.toDateString() === now.toDateString()) {
      label = hm;
    } else if (Date.now() - ts < 7 * 864e5) {
      label = ['日', '一', '二', '三', '四', '五', '六'][d.getDay()] === undefined ? hm :
        '周' + ['日', '一', '二', '三', '四', '五', '六'][d.getDay()] + ' ' + hm;
    } else {
      label = (d.getMonth() + 1) + '/' + d.getDate() + ' ' + hm;
    }
    const wrap = document.createElement('div');
    wrap.className = 'msg time-divider';
    const el = document.createElement('div');
    el.className = 'time-divider-text';
    el.textContent = label;
    wrap.appendChild(el);
    (target || this.el.dialogueArea).appendChild(wrap);
  },

  // ═══ 内心独白（💭 ta的独白）═══
  // 折叠形态：标签行可点击，思考全文默认收起（历史渲染用）。
  // buildReasoningShell 为实时/历史两条路径共用的骨架，保证形态一致。
  appendReasoningBlock(mid, reasoning, target) {
    const wrap = this.buildReasoningShell(mid);
    wrap.querySelector('.reasoning-text').textContent = reasoning;
    (target || this.el.dialogueArea).appendChild(wrap);
  },
  buildReasoningShell(mid) {
    const wrap = document.createElement('div');
    wrap.className = 'msg gf reasoning-row';
    wrap.dataset.forMid = mid || '';
    const body = document.createElement('div');
    body.className = 'reasoning-body';
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'reasoning-toggle';
    toggle.innerHTML = '<span class="rt-emoji">💭</span> ta的独白<span class="rt-arrow">▸</span>';
    toggle.addEventListener('click', () => {
      const open = toggle.classList.toggle('open');
      toggle.querySelector('.rt-arrow').classList.toggle('open', open);
      wrap.querySelector('.reasoning-text').classList.toggle('hidden', !open);
      // 不自动滚动：回看历史时展开不应劫持滚动位置
    });
    const text = document.createElement('div');
    text.className = 'reasoning-text hidden';
    body.appendChild(toggle);
    body.appendChild(text);
    wrap.appendChild(body);
    return wrap;
  },

  // ═══ 实时独白模块（流式思考阶段构建：收起 + 「正在独白」动效）═══
  // 定稿后仍是收起态，点击标签行才展开全文
  createLiveReasoning(mid) {
    const wrap = this.buildReasoningShell(mid);
    const body = wrap.querySelector('.reasoning-body');
    body.classList.add('thinking');
    const toggle = wrap.querySelector('.reasoning-toggle');
    toggle.disabled = true;   // 思考中无内容可展开
    toggle.querySelector('.rt-arrow').classList.add('hidden');   // 思考中用 dots 代替箭头
    const dots = document.createElement('span');
    dots.className = 'reasoning-dots';
    dots.setAttribute('aria-hidden', 'true');
    dots.innerHTML = '<span></span><span></span><span></span>';
    toggle.appendChild(dots);
    this.el.dialogueArea.appendChild(wrap);
    this.scrollToBottom();
    return wrap;
  },
  finalizeLiveReasoning(el, reasoning) {
    if (!el) return;
    if (!el.isConnected) return;   // 已切对话：DOM 重建后由 renderHistory 补画
    const text = (reasoning || '').trim();
    const body = el.querySelector('.reasoning-body');
    if (!body || !text) { el.remove(); return; }   // 没有思考内容：不留空壳
    body.classList.remove('thinking');
    const toggle = el.querySelector('.reasoning-toggle');
    const dots = toggle.querySelector('.reasoning-dots');
    if (dots) dots.remove();
    toggle.disabled = false;
    toggle.querySelector('.rt-arrow').classList.remove('hidden');
    el.querySelector('.reasoning-text').textContent = text;
  },

  // ═══ 追加消息气泡 ═══
  // gfId 指定气泡归属（流式回复跨女友时用），缺省为当前女友
  // media 参数（issue #8 图片 / #38 语音）：{ img: dataURL|'LOST', imgLost, audio: dataURL, audioLost, dur }
  // target 参数（issue #26）：分批渲染时传入 DocumentFragment，缺省仍为对话区
  appendMessage(role, text, noScroll, gfId, mid, media, target, voice) {
    const targetGf = gfId || this.state.currentGf;
    const imgData = media && media.img;
    const audioData = media && media.audio;
    const audioLost = media && media.audioLost;
    const dur = (media && media.dur) || 0;

    // 跨女友守卫：气泡属于别的女友且当前没在看她 → 不上屏，计入未读
    if (role === 'gf' && targetGf !== this.state.currentGf) {
      this.state.unread[targetGf] = (this.state.unread[targetGf] || 0) + 1;
      this.state.streamSkips++;      // 记录被跳过的气泡，流结束后按历史补渲染
      this.refreshNavUnread();
      return;
    }

    if (role === 'gf' && text) text = this.stripTrailingPeriod(text);   // #43 层二：显示级剥离，hist 存原文
    const area = target || this.el.dialogueArea;
    const wrap = document.createElement('div');
    wrap.className = 'msg ' + (role === 'player' ? 'player' : 'gf');
    if (mid) wrap.dataset.mid = mid;      // 气泡 → 历史项映射（右键复制/删除用）

    if (role === 'gf') {
      const gf = this.allGfs()[targetGf];
      const avatar = document.createElement('img');
      avatar.className = 'msg-avatar';
      avatar.src = gf.avatar;
      avatar.alt = gf.name;
      avatar.classList.add('pop');                       // 新到头像微弹（一次性）
      avatar.addEventListener('animationend', () => avatar.classList.remove('pop'), { once: true });
      wrap.appendChild(avatar);
    }

    const bubble = document.createElement('div');
    bubble.className = 'msg-text' + (imgData ? ' has-img' : '');
    if (imgData === 'LOST') {
      const lost = document.createElement('div');
      lost.className = 'msg-img-lost';
      lost.textContent = '[图片]';       // 旧图已降级（配额/存档），文字保留
      bubble.appendChild(lost);
    } else if (imgData) {
      const im = document.createElement('img');
      im.className = 'msg-img';
      im.src = imgData;
      im.alt = '图片';
      // issue #61：历史图片异步解码不阻塞切换；加载完成若用户仍贴底则校准贴底
      im.setAttribute('loading', 'lazy');
      im.setAttribute('decoding', 'async');
      im.addEventListener('load', () => { if (this._pinnedToBottom) this.scrollToBottom(false); });
      im.addEventListener('click', () => this.openLightbox(imgData));
      bubble.appendChild(im);
    }
    // 语音气泡（issue #38）：微信式 mic+时长+声波条；audioLost 降级 [语音] 占位；转文字开关
    if (audioData || audioLost) {
      const voice = document.createElement('div');
      voice.className = 'msg-voice';
      if (audioData) {
        voice.title = '点击播放';
        voice.addEventListener('click', () => this.playMsgAudio(audioData, voice));
        const bars = document.createElement('span');
        bars.className = 'mv-bars';
        bars.innerHTML = '<i></i><i></i><i></i><i></i>';
        const d = document.createElement('span');
        d.className = 'mv-dur';
        d.textContent = (dur || 1) + '″';
        voice.appendChild(bars);
        voice.appendChild(d);
        bubble.appendChild(voice);
        if (text) {
          const tr = document.createElement('button');
          tr.type = 'button';
          tr.className = 'mv-transcript-toggle';
          tr.textContent = '转文字';
          tr.addEventListener('click', (e) => {
            e.stopPropagation();
            const vt = bubble.querySelector('.mv-transcript');
            if (vt) vt.classList.toggle('show');
            tr.textContent = vt && vt.classList.contains('show') ? '收起' : '转文字';
          });
          bubble.appendChild(tr);
          const vt = document.createElement('div');
          vt.className = 'mv-transcript';
          vt.textContent = text;
          bubble.appendChild(vt);
        }
      } else {
        const lostV = document.createElement('div');
        lostV.className = 'msg-img-lost';
        lostV.textContent = '[语音]';
        bubble.appendChild(lostV);
        if (text) bubble.appendChild(document.createTextNode(text));
      }
      wrap.appendChild(bubble);
      this.attachMsgOps(wrap, area, noScroll);
      return;
    }
    // gf 语音气泡（issue #13）：语音气泡模式的历史/变形渲染路径
    if (role === 'gf' && voice && voice.speak) {
      this.appendGfVoiceBubble(bubble, mid, voice.speak, text);
      wrap.appendChild(bubble);
      this.attachMsgOps(wrap, area, noScroll);
      return;
    }
    if (text) bubble.appendChild(document.createTextNode(text));
    // 女友气泡朗读键（issue #38）：点击合成/播放（缓存策略见 playGfTTS）
    if (role === 'gf' && text) {
      const tts = document.createElement('button');
      tts.type = 'button';
      tts.className = 'msg-tts-btn';
      tts.title = '听她说';
      tts.setAttribute('aria-label', '朗读这条消息');
      tts.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5 6 9H2v6h4l5 4z"/><path d="M15.5 8.5a5 5 0 0 1 0 7M18.4 5.6a9 9 0 0 1 0 12.8"/></svg>';
      tts.addEventListener('click', () => this.playGfTTS(mid, text, tts));
      bubble.appendChild(tts);
    }
    wrap.appendChild(bubble);
    this.attachMsgOps(wrap, area, noScroll);
  },

  // 桌面端 hover 行内操作（移动端走长按菜单）：复制 / 删除
  attachMsgOps(wrap, area, noScroll) {
    const ops = document.createElement('div');
    ops.className = 'msg-ops';
    // SVG 用全局 defs 符号复用（issue #26），不再每条消息内联完整路径
    ops.innerHTML = `
      <button class="msg-op" data-op="copy" title="复制" aria-label="复制"><svg><use href="#ic-copy"/></svg></button>
      <button class="msg-op danger" data-op="delete" title="删除" aria-label="删除"><svg><use href="#ic-del"/></svg></button>`;
    wrap.appendChild(ops);
    area.appendChild(wrap);
    if (!noScroll) this.scrollToBottom();
  },

  scrollToBottom(smooth = true) {
    const area = this.el.dialogueArea;
    // ⚠ 非 smooth 场景必须 'instant'（issue #61 复发 v1.8.1 老坑）：#dialogue-area 有
    // CSS scroll-behavior: smooth，behavior:'auto' 会被平滑化成异步滚动——
    // 切换瞬间布局未稳 + 图片解码撑高内容，平滑滚动追不上最终停在顶部
    area.scrollTo({ top: area.scrollHeight, behavior: smooth ? 'smooth' : 'instant' });
  },

  // ═══ 回到底部按钮（距底部 >80px 时浮现） ═══
  toggleScrollBottomBtn() {
    const area = this.el.dialogueArea;
    const nearBottom = area.scrollHeight - area.scrollTop - area.clientHeight < 80;
    this._pinnedToBottom = nearBottom;   // 贴底跟踪：键盘重锚定（issue #4）与按钮共用同一阈值
    this.el.scrollBottomBtn.classList.toggle('show', !nearBottom);
    // 滚动边界渐隐（issue #100）：距底超过阈值才启用底部渐隐带——贴底时最新消息不能被削淡
    this.el.dialogueArea.classList.toggle('edge-fade', !nearBottom);
  },

  // ═══ 打字指示器 ═══
  showTyping(gfId) {
    if (this.state.typingActive) return;
    const gf = this.allGfs()[gfId || this.state.currentGf];
    if (!gf || gf.id !== this.state.currentGf) return;   // 已切走：不显示指示器
    this.state.typingActive = true;
    this.el.body.classList.add('waiting');     // 发送按钮呼吸微光
    const area = this.el.dialogueArea;
    const wrap = document.createElement('div');
    wrap.className = 'msg gf';
    wrap.id = 'typing-indicator';
    const img = document.createElement('img');
    img.className = 'msg-avatar';
    img.src = gf.avatar;
    img.alt = gf.name;
    wrap.appendChild(img);
    const bubble = document.createElement('div');
    bubble.className = 'msg-text';
    bubble.innerHTML = '<span class="typing-indicator"><span></span><span></span><span></span></span>';
    wrap.appendChild(bubble);
    area.appendChild(wrap);
    this.scrollToBottom();
  },
  removeTyping() {
    this.state.typingActive = false;
    const t = document.getElementById('typing-indicator');
    if (t) t.remove();
    this.el.body.classList.remove('waiting');   // 停止发送按钮呼吸微光
  },

  // ═══ 发送（流式：智能拆条 + 逐条延迟上屏，像真人微信聊天） ═══
  async sendMessage(voiceMsg) {
    // voiceMsg（issue #38）：语音消息入口——text=转写文本、audio=dataURL、dur=秒
    const text = voiceMsg ? voiceMsg.text : this.el.playerInput.value.trim();
    const img = voiceMsg ? null : (this._pendingImg || null);   // 待发送图片（issue #8；每条限 1 张）
    const audio = voiceMsg ? (voiceMsg.audio || null) : null;
    const dur = voiceMsg ? (voiceMsg.dur || 0) : 0;
    if (!text && !img && !audio) return;
    this.closeInputPlusMenu();   // 发送即收起「+」抽屉（issue #30）
    this.closeVoiceMenu();       // 连带音色列表（issue #73）

    // 打断上一轮未完成的回复：中止进行中的流 + 丢弃待发送气泡队列
    if (this.state.activeController || this.state.bubbleQueue.length > 0) {
      this.interruptPending();
    }

    const gfId = this.state.currentGf;
    this.state.activeStreamGf = gfId;
    this.state.streamSkips = 0;
    this.proactiveTouch(gfId);   // 主动消息节流的「距上次聊天」锚（issue #27）
    if (!voiceMsg) {
      this.el.playerInput.value = '';
      this.clearPendingImg();
      this.autoResizeInput();
    }

    // 乐观上屏（先判断是否需要时间分隔条）
    const now = Date.now();
    const histArr = this.state.histories[gfId];
    const prevTs = histArr.length ? (histArr[histArr.length - 1].ts || 0) : 0;
    if (now - prevTs >= 5 * 60 * 1000) this.appendTimeDivider(now);
    const mid = this.nextId();
    const item = { role: 'player', text, ts: now, id: mid };
    if (img) item.img = img;
    if (audio) { item.audio = audio; item.dur = dur; }
    // 引用记忆（issue #2 ①）：引用块存入历史项，每轮 LLM 组装时前置；气泡只显示原文
    if (this.state.quote && this.state.quote.gfId === gfId) {
      item.quote = `【引用记忆 · ${this.state.quote.title} · ${this.fmtDate(this.state.quote.ts)}】${this.state.quote.text}`;
      this.clearQuote(true);
    }
    histArr.push(item);
    this.saveHistory(gfId);
    this.appendMessage('player', text, false, null, mid, { img: img || null, audio: audio || null, dur });
    this.playSound();

    // 联网搜索（issue #9）：开关开启且有文字时，先提炼检索词再检索（issue #19），检索块拼进本次 LLM 消息。
    // 检索块只拼进本次 LLM 的 user 消息，历史项存原文——记忆提取天然不消费检索块。
    // 失败/超时静默降级：不带检索结果照常发送，绝不阻塞。
    let llmMessage = text;
    this.showTyping(gfId);   // 提前（issue #19）：提炼+检索最长 ~20s，让打字指示覆盖等待期，消除「没反应」体感
    if (this.state.searchEnabled && text) {
      try {
        const refined = await this.refineSearchQuery(text);
        const block = await this.webSearch(refined || text);
        llmMessage = block + '\n\n【用户消息】' + text;
      } catch (e) {
        console.error('[webSearch]', e);
        // 提示按失败原因区分（issue #64：Bing RSS 免费渠道，Web 端 CORS / 服务异常）
        if (e.name === 'AbortError') {
          this.toast('检索超时，本次未联网');
        } else if (e instanceof TypeError && !window.Capacitor?.isNativePlatform?.()) {
          this.toast('网页版暂不支持联网搜索，请在手机 App 使用');
        } else {
          this.toast('检索失败，本次未联网');
        }
      }
    }

    await this.runGfReply(gfId, llmMessage, text, img, false);
  },

  // ═══ 回复流公共管线（issue #27 期一抽取）：手动消息与主动消息共用同一套
  // 拆条 / 独白闸门 / 收尾 / 记忆提取，防双路径漂移。isProactive：出错静默
  // 不弹 toast（用户可能根本没在看 App）；userText 为触发侧「用户消息」
  // （主动消息传 ''，节律指令不参与记忆归因）。
  async runGfReply(gfId, llmMessage, userText, img, isProactive) {
    // 流式回复：智能拆条（微信连续多条消息感）
    // - \n 始终切（prompt 消息模式约定：每条消息用换行分隔）
    // - 强标点 。！？!? 处记录可切点，但**延迟到下一个文字字符到达才切**
    //   → 连续标点（！！）、句末 emoji/颜文字（！✨）整体并入同一条，不再产生碎片
    // - ～…；; 等弱标点不切（语气词与颜文字的组成部分）
    // - ≥50 字强切兜底；单次回复最多 10 条，超出并入最后一条（内容不丢）
    const gf = this.allGfs()[gfId];
    const replyId = this.nextId();   // 本次回复的历史项 id（气泡上屏与 commit 共用）
    const bubbles = [];       // 本次回复的所有气泡文本（历史用）
    const MAX_BUBBLES = 10;
    let curSentence = '';     // 当前句子缓冲
    let cutPos = -1;          // 缓冲中的可切分位置（最后一个强标点之后）
    let gotContent = false;
    let liveReasoning = null; // 实时独白块：独白闭合即定稿（正文随后逐条上屏），流结束兜底收尾
    // ═══ 内心独白拦截（issue #12）═══
    // 独白随正文 content 流输出（<inner>…</inner> 定界），不再消费模型 reasoning_content 思维链。
    // 状态机防「<inner>」被拆在多个 delta 里；模型漏写定界符 → 缓冲全文回灌正文，该条无独白（优雅降级）。
    const OPEN = '<inner>', CLOSE = '</inner>';
    const gate = { state: 'wait', buf: '' };   // wait=开头判定中；in=独白正文累积中；done=直通
    this._lastInner = '';
    const onInnerClosed = (raw) => {
      const text = raw.trim();
      if (!text) return;
      this._lastInner = text;
      if (this.state.typingActive) this.removeTyping();   // 独白动效接管「正在回复」
      if (!liveReasoning) liveReasoning = this.createLiveReasoning(replyId);
      this.finalizeLiveReasoning(liveReasoning, text);   // 独白先行定稿，正文随后逐条上屏
    };
    const gateChunk = (chunk) => {
      if (gate.state === 'done') return chunk;
      if (gate.state === 'wait') {
        gate.buf += chunk;
        const probe = gate.buf.replace(/^\s+/, '');   // 容忍前导空白
        if (!probe) return '';
        if (OPEN.startsWith(probe) && probe.length < OPEN.length) return '';   // 仍是 <inner 前缀，等下一片
        if (probe.startsWith(OPEN)) {
          gate.state = 'in';
          gate.buf = '';
          const rest = probe.slice(OPEN.length);
          return rest ? gateChunk(rest) : '';
        }
        gate.state = 'done';   // 不是独白开头：全文回灌正文管线
        const out = gate.buf; gate.buf = '';
        return out;
      }
      gate.buf += chunk;
      const idx = gate.buf.indexOf(CLOSE);
      if (idx < 0) return '';
      const inner = gate.buf.slice(0, idx);
      const tail = gate.buf.slice(idx + CLOSE.length);
      gate.state = 'done'; gate.buf = '';
      onInnerClosed(inner);
      return tail;
    };
    const gateFlush = () => {   // 流结束收尾：未闭合的独白段尽力保留，wait 残留必是半截标记、丢弃
      if (gate.state === 'in') {
        const rest = gate.buf;
        gate.state = 'done'; gate.buf = '';
        onInnerClosed(rest);
        return;
      }
      gate.state = 'done'; gate.buf = '';
    };
    const flushAt = (len) => {
      const seg = (len > 0 ? curSentence.slice(0, len) : curSentence).trim();
      if (len > 0) curSentence = curSentence.slice(len);
      else curSentence = '';
      if (!seg) return;
      if (bubbles.length >= MAX_BUBBLES) {
        // 超出上限：并入最后一条（空格分隔，历史渲染按 \n 拆条不受影响）
        bubbles[bubbles.length - 1] += ' ' + seg;
        return;
      }
      bubbles.push(seg);
      this.queueBubble(gfId, seg, bubbles.length === 1, replyId);  // 入队延迟上屏；首条气泡带提示音
    };

    try {
      await this.callLLM(gf.prompt, gfId, llmMessage, (delta) => {
        gotContent = true;
        if (this.state.typingActive) this.removeTyping();  // 首个 token 到达 → 移除打字指示器
        const chunk = gateChunk(delta);   // issue #12：正文流里的 <inner> 段先过独白闸门
        if (!chunk) return;
        for (const ch of chunk) {
          curSentence += ch;
          if (ch === '\n') { flushAt(0); cutPos = -1; continue; }
          const isPunct = /[。！？!?]/.test(ch);
          const isSoft = ch === '～' || ch === '…';
          if (isPunct && curSentence.trim().length >= 6) cutPos = curSentence.length;
          else if (!isPunct && !isSoft && IS_TEXT_RE.test(ch) && cutPos > 0) {
            flushAt(cutPos);
            cutPos = -1;
          }
          if (curSentence.length >= 50) {           // 超长兜底
            if (cutPos > 0) { flushAt(cutPos); cutPos = -1; }
            else flushAt(0);
          }
        }
      }, img);
      gateFlush();   // 流结束：未闭合独白尽力收尾（wait 残留=半截标记，已丢弃）
      // 流结束：剩余缓冲提交
      if (curSentence.trim()) flushAt(0);
      if (!gotContent || bubbles.length === 0) {
        const fallback = '……（她好像走神了，再说一次？）';
        bubbles.push(fallback);
        this.queueBubble(gfId, fallback, false, replyId);
      }
      liveReasoning = null;   // 独白已在闭合时即时定稿（onInnerClosed）；无独白则从未建壳
      // 同一次回复的多个气泡合并为一条历史消息（\n 分隔），渲染时拆条
      // （commitReply 内会剥离【喜好】标记并入库）
      this.commitReply(gfId, bubbles, replyId, this._lastInner);
      this.settleStream(gfId);
      // 记忆提取（均后台静默）：喜好每轮小调用；回忆按周期/信号词盘点
      this.extractFavs(gfId);
      this.maybeReviewMemories(gfId, userText);
      this.updateDrives(gfId, userText);
      this.maybeCorrect(gfId, userText);
    } catch (e) {
      // 主动消息：用户可能不在看，任何错误静默落日志，绝不弹窗打扰
      if (isProactive) {
        console.error('[runGfReply:proactive]', e, e.body || '');
        this.removeTyping();
        this.state.activeStreamGf = null;
        return;
      }
      // 被打断：静默放弃残句（用户已发新消息）
      if (this.state.interrupted) {
        this.state.interrupted = false;
        this.removeTyping();
        if (liveReasoning && liveReasoning.isConnected) liveReasoning.remove();   // 回复整体放弃，独白不留壳
        liveReasoning = null;
        return;
      }
      // 断流：已收到的内容保留上屏（入队）；已闭合独白自然保留，未闭合段尽力收尾
      gateFlush();
      if (curSentence.trim()) flushAt(0);
      this.commitReply(gfId, bubbles, replyId, this._lastInner);
      this.removeTyping();
      this.settleStream(gfId);
      console.error('[sendMessage]', e, e.body || '');
      if (e.message === 'NO_API_KEY') {
        this.toast('请先配置 API Key');
        this.openApiPanel();
      } else if (e.status === 401 || e.status === 403) {
        this.toast('API Key 无效，请检查后重试');
        this.openApiPanel();
      } else if (e.status === 402) {
        this.toast('API 余额不足，请到 DeepSeek 平台充值后重试');
      } else if (e.status === 429) {
        this.toast('请求太频繁了，稍等一下再发');
      } else if (e.status === 400) {
        this.toast('请求被服务端拒绝（400），详情见控制台日志');   // issue #55：参数/模型类问题不再伪装成网络问题
      } else if (e.status >= 500) {
        this.toast('DeepSeek 服务端异常（' + e.status + '），请稍后再试');
      } else if (this.state.interrupted) {
        this.state.interrupted = false;   // 用户主动打断（连接阶段 abort）：静默，此前会误报「网络不稳定」
      } else if (e.name === 'AbortError') {
        this.toast('连接超时（服务器 30 秒未响应），请检查网络或稍后再试');
      } else if (e instanceof TypeError) {
        this.toast('网络连接失败，请检查手机网络后重试');
      } else {
        this.toast('网络似乎不太稳定，稍后再试试');
      }
    }
    this.removeTyping();
    this.state.activeStreamGf = null;
  },

  // ═══ 主动消息（issue #27 期一：App 存活期节律主动）═══
  // 边界诚实声明：纯前端无推送通道，本机制只在 App 存活（前台/后台未杀）时可靠；
  // WebView 后台节流下心跳可能停摆——回前台 visibilitychange 立即补检，错过窗口不补发。
  PROACTIVE_WIN: { morning: 9 * 60, night: 22 * 60 + 30 },   // 节律窗口锚点（分钟）
  PROACTIVE_QUIET_END: 8 * 60,        // 勿扰时段 0:00–8:00
  PROACTIVE_MAX_DAY: 3,               // 每角色每日上限（owner 2026-09-29 调整）
  PROACTIVE_IDLE_MIN: 3 * 3600e3,     // 距上次用户交互阈值（防刚聊完又主动）
  loadProactive() {
    if (this.proactiveCfg) return this.proactiveCfg;
    let cfg = null;
    try { cfg = JSON.parse(localStorage.getItem('aigf_proactive') || 'null'); } catch (e) { /* 损坏即重建 */ }
    this.proactiveCfg = Object.assign({ enabled: false, gfs: {} }, cfg || {});
    return this.proactiveCfg;
  },
  saveProactive() {
    try { localStorage.setItem('aigf_proactive', JSON.stringify(this.proactiveCfg)); } catch (e) { /* 忽略 */ }
  },
  proactiveOn() { return !!this.loadProactive().enabled; },
  async toggleProactive() {
    const cfg = this.loadProactive();
    if (!cfg.enabled) {
      // 开启前先过通知权限（issue #41：Android 13+ 需运行时授权——未授权时排程会
      // 静默失败「Notifications not enabled」，用户以为开了却永远收不到）
      try {
        const cap = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.LocalNotifications;
        if (cap && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform()) {
          const r = await cap.requestPermissions();
          if (r && r.display && r.display !== 'granted') {
            this.toast('需要通知权限才能收到她的主动消息，请在系统设置中开启');
            return;   // 未授权不启用
          }
        }
      } catch (e) { /* 权限查询失败不阻塞开启（Web 端无此插件） */ }
    }
    cfg.enabled = !cfg.enabled;
    this.saveProactive();
    this.refreshProactiveUi();
    this.toast(cfg.enabled ? '她会主动找你聊天了（到点消耗 API 额度）' : '已关闭主动消息');
    if (cfg.enabled) this.scheduleNextPlaceholder();   // 期二（issue #41）：开即预排占位通知
    else this.cancelPlaceholders();
  },
  refreshProactiveUi() {
    if (this.el.sbProactiveMode) this.el.sbProactiveMode.textContent = this.proactiveOn() ? '开' : '关';
  },
  // 窗口随机偏移：日期串哈希派生 ±30 分钟（同日稳定，防机械准点；无需持久化）
  proactiveOffsets(dateKey) {
    let h = 0;
    for (const c of dateKey) h = (h * 31 + c.charCodeAt(0)) >>> 0;
    return { morning: (h % 61) - 30, night: ((h >> 8) % 61) - 30 };
  },
  proactiveTouch(gfId) {   // 用户交互时刻（sendMessage 调），主动消息节流的「距上次聊天」锚
    const cfg = this.loadProactive();
    const st = cfg.gfs[gfId] || (cfg.gfs[gfId] = {});
    st.lastInteract = Date.now();
    this.saveProactive();
  },
  proactiveCheck() {
    const cfg = this.loadProactive();
    if (!cfg.enabled || !this.state.enabledGfs) return;
    const now = new Date();
    const min = now.getHours() * 60 + now.getMinutes();
    if (min < this.PROACTIVE_QUIET_END) return;                       // 勿扰时段
    if (this.state.activeController || this.state.bubbleQueue.length) return;   // 有流/队列中：不打扰
    const dateKey = now.toISOString().slice(0, 10);
    const off = this.proactiveOffsets(dateKey);
    for (const gf of Object.values(this.allGfs())) {
      if (!this.state.enabledGfs.has(gf.id)) continue;                // 只对已启用角色
      const st = cfg.gfs[gf.id] || (cfg.gfs[gf.id] = {});
      if (st.sentDate !== dateKey) { st.sentDate = dateKey; st.sentCount = 0; st.wins = ''; }
      if ((st.sentCount || 0) >= this.PROACTIVE_MAX_DAY) continue;
      const idle = Date.now() - (st.lastInteract || 0);
      if (idle < this.PROACTIVE_IDLE_MIN) continue;
      let win = null;
      if (Math.abs(min - (this.PROACTIVE_WIN.morning + off.morning)) <= 2) win = 'morning';
      else if (Math.abs(min - (this.PROACTIVE_WIN.night + off.night)) <= 2) win = 'night';
      else if (idle >= 24 * 3600e3) win = 'miss';                     // 久未聊天想念（勿扰时段外任意时刻）
      if (!win || (st.wins || '').includes(win)) continue;            // 同窗口同日只发一次
      this.proactiveSend(gf.id, win, idle);
      break;                                                          // 每 tick 至多一条，错峰
    }
    this.saveProactive();
  },
  async proactiveSend(gfId, win, idleMs) {
    const cfg = this.loadProactive();
    const st = cfg.gfs[gfId] || (cfg.gfs[gfId] = {});
    st.sentCount = (st.sentCount || 0) + 1;
    st.wins = (st.wins || '') + win;
    this.saveProactive();
    const gf = this.allGfs()[gfId];
    if (!gf) return;
    const now = new Date();
    const hhmm = now.getHours() + ':' + String(now.getMinutes()).padStart(2, '0');
    const idleH = Math.max(1, Math.round(idleMs / 3600e3));
    const desc = win === 'morning' ? `早上 ${hhmm}，新的一天刚开始`
      : win === 'night' ? `晚上 ${hhmm}，夜深了`
      : `现在 ${hhmm}，你们已经 ${idleH} 个小时没有说话`;
    const instruction = `【系统节律提示 · 这不是用户发的消息，请勿回应或提及本提示】现在是${desc}。请完全以「${gf.name}」的身份和性格，主动给对方发一条微信消息——1~2 条短消息，符合此刻的时间与心境，像你平时那样说话。不要解释，不要复述本提示。`;
    try {
      await this.runGfReply(gfId, instruction, '', null, true);
    } catch (e) {
      console.error('[proactive]', e);
    }
    this.maybeNotifyProactive(gfId);   // App 在后台 → 系统通知（issue #41 期二）
    this.scheduleNextPlaceholder();    // 顺排下一个窗口的占位提醒
  },

  // ═══ 本地通知（issue #41 期二：主动消息移动端提示）═══
  // @capacitor/local-notifications（官方免费插件）。三件事：
  // ① 存活期即时通知——主动消息入历史且 App 在后台 → 系统通知（真实首条气泡内容）；
  //    前台聊天零打扰（站内未读已覆盖）
  // ② 后台预排通知——当前角色下一个节律窗口的「想你了，来聊聊」占位（无内容预生成，
  //    生成与通知解耦：点开由期一心跳评估补发真消息）；只给当前角色排，防多角色轰炸
  // ③ 点通知深链——切到对应角色会话；冷启走 localStorage pending 标记兜底
  // 边界（诚实声明）：纯本地通知无推送通道；App 被杀 / 国产 ROM 清后台时预排也可能
  // 收不到（平台限制，开关 title 有说明）；Web 端不承诺系统通知。
  // 权限：Android 13+ POST_NOTIFICATIONS 在开关手势内运行时申请；拒绝 → 降级仅站内未读。
  NOTIFY_KEY: 'aigf_notify_enabled',
  NOTIFY_PENDING_KEY: 'aigf_notify_pending_gf',
  NOTIFY_PLACEHOLDER_ID: 41,   // 占位通知固定 id：重排天然覆盖、单独可取消
  NOTIFY_CHANNEL: 'proactive',
  notifyPlugin() {
    const cap = window.Capacitor;
    return (cap && cap.isNativePlatform && cap.isNativePlatform() && cap.Plugins && cap.Plugins.LocalNotifications) || null;
  },
  notifyOn() { return localStorage.getItem(this.NOTIFY_KEY) !== '0'; },   // 默认开；无权限时零副作用
  async toggleNotify() {
    const on = !this.notifyOn();
    localStorage.setItem(this.NOTIFY_KEY, on ? '1' : '0');
    this.refreshNotifyUi();
    if (!on) {
      this.cancelPlaceholders();
      this.toast('已关闭系统通知（仍在应用内提示未读）');
      return;
    }
    const ln = this.notifyPlugin();
    if (!ln) { this.toast('消息通知已开启（网页版不出系统通知）'); return; }
    try {
      const p = await ln.requestPermissions();   // Android 13+ 运行时权限（开关手势内请求）
      if (p && p.display === 'granted') {
        this.toast('消息通知已开启');
        this.scheduleNextPlaceholder();
      } else {
        this.toast('通知权限未授予——她发消息时仅应用内提示未读（可在系统设置开启）');
      }
    } catch (e) {   // 权限接口异常不阻塞开关
      this.toast('消息通知已开启');
    }
  },
  refreshNotifyUi() {
    if (this.el.sbNotifyMode) this.el.sbNotifyMode.textContent = this.notifyOn() ? '开' : '关';
  },
  async notifyPermitted() {
    const ln = this.notifyPlugin();
    if (!ln) return false;
    try { const p = await ln.checkPermissions(); return !!(p && p.display === 'granted'); }
    catch (e) { return false; }
  },
  // ① 即时通知：主动消息流收尾后调用；后台 + 开 + 有权限三过才发
  async maybeNotifyProactive(gfId) {
    if (!document.hidden) return;                     // 前台：站内未读已覆盖，零打扰
    if (!this.notifyOn() || !(await this.notifyPermitted())) return;
    const ln = this.notifyPlugin();
    const gf = this.allGfs()[gfId];
    const last = [...(this.state.histories[gfId] || [])].reverse().find(m => m.role !== 'player');
    if (!ln || !gf || !last) return;
    try {
      await ln.schedule({
        notifications: [{
          id: Math.floor(Math.random() * 2100000000),
          title: gf.name,
          body: (last.text || '给你发了一条消息').slice(0, 60),
          smallIcon: 'ic_stat_notify',
          channelId: this.NOTIFY_CHANNEL,
          extra: { gfId },
        }],
      });
    } catch (e) { console.warn('[notify]', e); }
  },
  // ② 预排占位：当前角色的下一个节律窗口（已过/太近则顺延明天；≥30 分钟后才排）
  async scheduleNextPlaceholder() {
    const ln = this.notifyPlugin();
    if (!ln || !this.notifyOn() || !this.proactiveOn()) return;
    const gfId = this.state.currentGf;
    const gf = this.allGfs()[gfId];
    if (!gf || !this.state.enabledGfs || !this.state.enabledGfs.has(gfId)) return;
    const now = new Date();
    const off = this.proactiveOffsets(now.toISOString().slice(0, 10));
    const at = [this.PROACTIVE_WIN.morning + off.morning, this.PROACTIVE_WIN.night + off.night]
      .map((min) => {
        const d = new Date(now);
        d.setHours(Math.floor(min / 60), ((min % 60) + 60) % 60, 0, 0);
        if (d.getTime() <= now.getTime() + 30 * 60e3) d.setDate(d.getDate() + 1);
        return d;
      })
      .sort((a, b) => a - b)[0];
    await this.cancelPlaceholders();
    try {
      await ln.schedule({
        notifications: [{
          id: this.NOTIFY_PLACEHOLDER_ID,
          title: gf.name,
          body: '想你了，来聊聊',
          schedule: { at, allowWhileIdle: true },
          smallIcon: 'ic_stat_notify',
          channelId: this.NOTIFY_CHANNEL,
          extra: { gfId },
        }],
      });
    } catch (e) { console.warn('[notify:placeholder]', e); }
  },
  async cancelPlaceholders() {
    const ln = this.notifyPlugin();
    if (!ln) return;
    try { await ln.cancel({ notifications: [{ id: this.NOTIFY_PLACEHOLDER_ID }] }); } catch (e) { /* 未排过/失败静默 */ }
  },
  // ③ 深链：init 挂监听（温启直接切会话）+ 冷启 pending 标记兜底
  async initNotify() {
    this.refreshNotifyUi();
    const ln = this.notifyPlugin();
    if (!ln) return;
    try {
      await ln.createChannel({   // 幂等；锁屏不显示消息内容
        id: this.NOTIFY_CHANNEL, name: '她的消息', importance: 3, visibility: 'private',
      });
    } catch (e) { /* 渠道已存在/低版本静默 */ }
    try {
      await ln.addListener('localNotificationActionPerformed', (ev) => {
        const gfId = ev && ev.notification && ev.notification.extra && ev.notification.extra.gfId;
        if (!gfId || !this.allGfs()[gfId]) return;
        localStorage.setItem(this.NOTIFY_PENDING_KEY, gfId);
        if (this.state.ready) this.consumePendingNotify();
      });
    } catch (e) { /* Web/旧版静默 */ }
    this.consumePendingNotify();
    if (this.notifyOn() && this.proactiveOn()) this.scheduleNextPlaceholder();
  },
  consumePendingNotify() {
    const gfId = localStorage.getItem(this.NOTIFY_PENDING_KEY);
    if (!gfId) return;
    localStorage.removeItem(this.NOTIFY_PENDING_KEY);
    if (this.allGfs()[gfId] && gfId !== this.state.currentGf) this.switchGf(gfId);
  },

  // ═══ 流结束收尾 ═══
  // 历史已保存：若期间有气泡因切走被跳过（已计入未读）、且用户已切回本女友，
  // 清掉该女友的队列残留并按历史全量重渲染，避免部分气泡缺屏或重复显示
  settleStream(gfId) {
    if (this.state.streamSkips > 0 && this.state.currentGf === gfId) {
      this.state.bubbleQueue = this.state.bubbleQueue.filter(i => i.gfId !== gfId);
      this.renderHistory();
    }
    this.state.streamSkips = 0;
  },

  // ═══ 提交回复：剥离喜好标记 → 存历史 ═══
  commitReply(gfId, bubbles, mid, inner) {
    const clean = bubbles
      .map(b => this.stripFavTags(gfId, b))
      .filter(b => b.trim());
    let item = null;
    if (clean.length) {
      item = { role: 'gf', text: clean.join('\n'), ts: Date.now(), id: mid || this.nextId() };
      if (inner && inner.trim()) item.inner = inner.trim();   // 💭 ta的独白（issue #12：<inner> 协议解析结果，无独白不存字段）
      // 语音气泡模式（issue #13）：定稿标记每段可朗读性（stripActionText 剥后非空），随后 DOM 变形 + 逐条自动合成
      if (this.voiceReplyOn() && this.hasStepKey()) item.vmode = true;
      this.state.histories[gfId].push(item);
      this.saveHistory(gfId);
    }
    if (item && item.vmode) this.morphReplyToVoice(gfId, item.id);
  },

  // 语音气泡变形（issue #13）：移除该回复已上屏的文字气泡，按 vflags 重渲染（可朗读段 = 语音气泡，
  // 纯动作段保留文字），并逐条自动合成——串行防限流；单条失败该段降级回文字，绝不丢消息
  // 整段语音变形（issue #13 owner 定调）：整条回复 = 一整段语音气泡——
  // 动作描写（…）/*…*/〔…〕先剥离只读自然对话；合成带情绪演绎（ttsEmotionInstruction 按内容逐条生成，句句不同）。
  // 合成失败 → 气泡还原为文字（消息绝不丢）。
  morphReplyToVoice(gfId, mid) {
    const area = this.el.dialogueArea;
    const hist = this.state.histories[gfId] || [];
    const item = [...hist].reverse().find(h => h.id === mid);
    if (!item || !item.vmode) return;
    area.querySelectorAll(`.msg.gf[data-mid="${mid}"]`).forEach(el => {
      if (!el.querySelector('.reasoning-row')) el.remove();   // 💭 独白块保留
    });
    const speak = this.stripActionText(item.text) || item.text;   // 整条纯动作 → 回落原文，绝不合成空白音频
    // 仍在队列里未上屏的文字段直接丢弃——整段语音气泡已覆盖全部内容，避免文字/语音重复显示
    this.state.bubbleQueue = this.state.bubbleQueue.filter(q => q.mid !== mid);
    const frag = document.createDocumentFragment();
    this.appendMessage('gf', item.text, false, gfId, mid, null, frag, { speak, idx: 0 });
    area.appendChild(frag);
    if (this._pinnedToBottom) this.scrollToBottom(false);
    this.synthVoiceReply(gfId, mid, speak, item.text);
  },
  // 整段自动合成：成功回填真实时长并点亮可播；失败还原文字
  async synthVoiceReply(gfId, mid, speak, raw) {
    const el = this.el.dialogueArea.querySelector(`.msg.gf[data-mid="${mid}"] .msg-voice`);
    if (!el) return;
    el.classList.add('loading');
    try {
      const buf = await this.gfVoiceBuf(mid, speak);
      el.dataset.synth = '1';
      const durEl = el.querySelector('.mv-dur');
      if (durEl) durEl.textContent = Math.max(1, Math.round(buf.duration)) + '″';
    } catch (e) {
      console.error('[synthVoiceReply]', e);
      this.degradeVoiceToText(mid, raw);
    } finally {
      el.classList.remove('loading');
    }
  },
  // 合成失败 → 气泡还原为文字（原文含动作描写一并可见）
  degradeVoiceToText(mid, raw) {
    const wrap = this.el.dialogueArea.querySelector(`.msg.gf[data-mid="${mid}"]`);
    if (!wrap) return;
    const bubble = wrap.querySelector('.msg-text');
    if (!bubble) return;
    bubble.querySelectorAll('.msg-voice, .mv-transcript-toggle, .mv-transcript').forEach(el => el.remove());
    bubble.appendChild(document.createTextNode(raw));
  },

  // ═══ 语音气泡模式（issue #13）═══
  // 全局开关（侧栏）：off = 文字 + 手动朗读（现状）；on = 女友回复定稿后自动变形为语音气泡（逐条合成，失败降级文字）。
  // 历史只存 vmode/vflags 标记、不落音频——点播时无缓存则静默重合成（合成只依赖文本+情绪指令，可复现）。
  voiceReplyOn() { return localStorage.getItem('aigf_voice_reply') === 'voice'; },
  syncVoiceReplyUi() {
    if (!this.el.sbVoiceReplyMode) return;
    this.el.sbVoiceReplyMode.textContent = this.voiceReplyOn() ? '语音气泡' : '文字';
  },
  toggleVoiceReply() {
    const on = this.voiceReplyOn();
    if (on) {
      localStorage.removeItem('aigf_voice_reply');
      this.toast('语音回复：文字（点朗读键播放）');
    } else {
      localStorage.setItem('aigf_voice_reply', 'voice');
      this.toast(this.hasStepKey() ? '语音气泡已开：她的回复将直接以语音送达' : '语音气泡已开：还需阶跃 Key 才能合成，期间回复保持文字');
    }
    this.syncVoiceReplyUi();
  },
  // 动作描写剥离（issue #13 关键约束）：朗读只读自然对话——（…）/(…)/*…*/〔…〕及 markdown 斜体括注全部剥除。
  // 只剥成对括注、宁少勿滥；剥后为空的段由调用方守卫（整条纯动作 → 回落原文，绝不合成空白音频）。
  stripActionText(text) {
    let s = String(text || '');
    s = s.replace(/（[^（）]*）/g, ' ').replace(/\([^()]*\)/g, ' ');
    s = s.replace(/〔[^〔〕]*〕/g, ' ');
    s = s.replace(/\*[^*\n]+\*/g, ' ');
    return s.replace(/\s+/g, ' ').trim();
  },

  // ═══ 喜好标记提取（低门槛 · 零额外调用） ═══
  // 「【喜好：xxx】」从回复文本中剥离（用户不可见）并入库去重，返回干净文本。
  // 上屏（pumpQueue）与历史保存（commitReply）都会调用，相同条目去重保证幂等。
  // 近重复判定（issue #32）：字符集合重合率 ≥60% 视为同一偏好——短标签（2~8 字）
  // 下比词级比对稳：「喜欢旧书店」/「爱逛旧书店」重合 3/5、「喜欢旧书」3/3 均判同；
  // 「猫咪」/「猫粮」1/2 不判同。三条入库路径（本函数/结构化 add/旧行解析）统一走它。
  favSimilar(a, b) {
    a = (a || '').trim(); b = (b || '').trim();
    if (!a || !b) return false;
    if (a === b) return true;
    if (a.length < 2 || b.length < 2) return a.includes(b) || b.includes(a);
    const A = new Set(a), B = new Set(b);
    let inter = 0;
    for (const ch of A) if (B.has(ch)) inter++;
    return inter / Math.min(A.size, B.size) >= 0.6;
  },
  // 归因守卫（issue #32 联动 #25 身份头）：条目文本若只出现在【用户】的消息里、
  // 从未出现在她的消息里——视为把用户喜好安到她头上，拒收。
  // 确定性拦截最恶劣 badcase（用户说「我喜欢吃辣」→ 卡上「她喜欢吃辣」），
  // LLM 层排除规则之外的最后闸门；双侧都提过则放行（归 LLM 判定）。
  favUserOnly(gfId, text) {
    const t = (text || '').trim();
    if (!t) return false;
    let inUser = false, inGf = false;
    for (const m of (this.state.histories[gfId] || []).slice(-12)) {
      if (!m.text || !m.text.includes(t)) continue;
      if (m.role === 'player') inUser = true; else inGf = true;
    }
    return inUser && !inGf;
  },
  stripFavTags(gfId, text) {
    const re = /【喜好[:：]\s*([^【】]{2,40}?)】/g;
    const favs = this.state.favs[gfId] || (this.state.favs[gfId] = []);
    let added = false;
    let m;
    while ((m = re.exec(text)) !== null) {
      const item = m[1].trim().replace(/^她(喜欢|爱|讨厌|不喜欢|爱吃|爱喝|爱听)/, '').trim();
      if (item && !favs.some(f => this.favSimilar(f.text, item)) && !this.favUserOnly(gfId, item)) {
        favs.push({ id: this.genMemId(), ts: Date.now(), text: item, pinned: false, source: 'auto' });
        this.evictOldest(favs, this.MAX_FAVS);
        added = true;
      }
    }
    if (added) this.saveFavs(gfId);
    return text.replace(re, '').trim();
  },

  // ═══ 通用小调用（流式 · 失败静默）═══
  // 记忆提取类辅助请求共用：返回回复文本，失败返回 null，绝不影响聊天主流程。
  // 注意：思考模型在非流式响应下 content 可能为空（输出全进 reasoning_content），
  // 因此这里与主聊天一样走 SSE 流式、只拼接 delta.content。
  async smallLLMCall(messages, maxTokens, timeoutMs) {
    const cfg = LLM_CONFIG;
    const apiKey = localStorage.getItem('deepseek_api_key');
    if (!apiKey) return null;
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs || 15000);
      const resp = await fetch(cfg.endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + apiKey,
        },
        body: JSON.stringify({
          model: cfg.model,
          messages: messages,
          max_tokens: maxTokens,
          stream: true,
        }),
        signal: controller.signal,
      });
      clearTimeout(timeout);
      if (!resp.ok) return null;
      // SSE 流解析（delta.content 增量；reasoning_content 忽略）
      const reader = resp.body.getReader();
      const decoder = new TextDecoder('utf-8');
      let buffer = '';
      let full = '';
      let streamDone = false;
      while (!streamDone) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let nl;
        while ((nl = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 1);
          if (!line.startsWith('data:')) continue;
          const data = line.slice(5).trim();
          if (data === '[DONE]') { streamDone = true; break; }
          try {
            const json = JSON.parse(data);
            const delta = json.choices?.[0]?.delta?.content;
            if (delta) full += delta;
          } catch (e) { /* 忽略异常行 */ }
        }
      }
      return full.trim();
    } catch (e) {
      console.error('[smallLLMCall]', e);
      return null;
    }
  },

  // ═══ 喜好提取（低门槛 · 每轮异步小调用）═══
  // 记录的是「她」（女友）的喜好：喜欢/讨厌的事物、口味、习惯、爱好。
  // 思考模型对回复内嵌标记协议的遵守率不稳定，改为流结束后单独小调用提取，
  // 体验同样自然（后台静默、主页即时可见）。主回复中偶发的【喜好】标记仍会被
  // stripFavTags 剥离入库，两条通道靠条目去重保证幂等。
  async extractFavs(gfId) {
    if (this.state.extracting) return;
    const gf = this.allGfs()[gfId];
    if (!gf) return;
    const hist = this.state.histories[gfId] || [];
    const favs = this.state.favs[gfId] || (this.state.favs[gfId] = []);
    const existing = favs.map(f => `- ${f.id}: ${f.text}`).join('\n');
    const recent = hist.slice(-8)
      .map(m => (m.role === 'player' ? '【用户】' : '【' + gf.name + '】')   // 身份头与主对话同格式（issue #25）：归因判定的锚
        + (m.img || m.imgLost ? '[发了一张图片]' + (m.text ? '\n' : '') : '') + m.text)   // 图片不进记忆管线，占位即可
      .join('\n');
    if (!recent.trim()) return;

    this.state.extracting = true;
    try {
      const out = await this.smallLLMCall([
        {
          role: 'system',
          content: `你是偏好记录员。从对话中提取关于「她」（${gf.name}）的喜好变化：她喜欢或讨厌的事物、口味、习惯、爱好（花、食物、音乐、电影、小习惯等）。
【归因判定（最高优先级）】材料中【用户】开头是对方发的话，【${gf.name}】开头才是她本人说的——只记录她的偏好；【用户】说的任何喜好（如「我喜欢吃辣」）绝不是她的，绝不入库。
【提取标准】她本人明确表达的偏好，或她的言行稳定体现的偏好才算。以下一律不提取：
- 对方（用户）的喜好或习惯
- 假设/条件句（「如果养猫大概会喜欢…」「要是…也许…」）
- 转述第三人的喜好（「我朋友超爱爬山」）
- 单次行为（「今天想喝奶茶」≠ 一直爱喝奶茶）
- 问候客套与抽象感受（「喜欢和你聊天」类不算具体偏好）
【依据要求】每条 add 必须给 evidence：从她本人的原话里摘 ≤12 字的短依据；给不出依据就不提取。
对记忆库执行操作：
- add：新发现的她的喜好（text 为 2~8 个字，直接写事物本身，不要「她喜欢」前缀；evidence 为原话短依据）
- delete：对话中她明确表示不再喜欢某条旧喜好（target_id 指向该条）
已有喜好（不要 add 重复，也不要 add 与既有条目意思相近的近重复）：
${existing || '（暂无）'}
没有需要执行的操作就输出 []。只输出 JSON 数组，不要任何其他文字：
[{"op":"add","text":"洋桔梗","evidence":"新到的洋桔梗很好看"},{"op":"delete","target_id":"id"}]`,
        },
        { role: 'user', content: recent + '\n\n请输出喜好操作 JSON 数组（没有就输出 []）。' },
      ], 800, 15000);
      if (!out) return;

      // 结构化解析（issue #2 ②）：成功走 op 分支，失败静默回退旧行解析
      let handled = false;
      try {
        const m = out.match(/\[[\s\S]*\]/);
        if (m) {
          const arr = JSON.parse(m[0]);
          if (Array.isArray(arr)) {
            handled = true;
            let added = 0;
            for (const op of arr) {
              if (!op || typeof op !== 'object') continue;
              if (op.op === 'add' && typeof op.text === 'string') {
                const line = op.text.trim();
                if (line.length < 2 || line.length > 16) continue;   // chips 保持短标签
                if (favs.some(f => this.favSimilar(f.text, line))) continue;   // 全等 → 近重复（issue #32）
                if (this.favUserOnly(gfId, line)) { console.warn('[extractFavs] 拒收疑似用户偏好:', line); continue; }   // 归因守卫
                favs.push({ id: this.genMemId(), ts: Date.now(), text: line, pinned: false, source: 'auto', evidence: (typeof op.evidence === 'string' ? op.evidence.trim().slice(0, 24) : '') });
                this.evictOldest(favs, this.MAX_FAVS);
                added++;
              } else if (op.op === 'delete' && op.target_id) {
                const idx = favs.findIndex(f => f.id === op.target_id);
                if (idx >= 0 && !favs[idx].pinned) favs.splice(idx, 1);
              }
            }
            if (added) this.saveFavs(gfId);
          }
        }
      } catch (e) { /* 回退旧行解析 */ }
      if (handled) return;

      let added = 0;
      for (let line of (out.includes('无') ? '' : out).split('\n')) {
        line = line.replace(/^[-*•\d.、\s]+/, '').replace(/^她(喜欢|爱|讨厌|不喜欢|爱吃|爱喝|爱听)/, '').trim();
        if (line.length < 2 || line.length > 16) continue;   // chips 保持短标签
        if (favs.some(f => this.favSimilar(f.text, line))) continue;   // 近重复（issue #32）
        if (this.favUserOnly(gfId, line)) { console.warn('[extractFavs] 拒收疑似用户偏好:', line); continue; }
        favs.push({ id: this.genMemId(), ts: Date.now(), text: line, pinned: false, source: 'auto' });
        this.evictOldest(favs, this.MAX_FAVS);
        added++;
      }
      if (added) this.saveFavs(gfId);
    } finally {
      this.state.extracting = false;
    }
  },

  // ═══ 回忆盘点触发（严格 · 低频 · 后台静默） ═══
  // 三通道：① 累计玩家消息达 REVIEW_INTERVAL 条；② 信号词立即触发；
  // ③ 记忆纠正语义（issue #2 ②）——触发结构化盘点以改写旧条目（②③受冷却约束）
  maybeReviewMemories(gfId, playerText) {
    const r = this.state.review[gfId] || (this.state.review[gfId] = { since: 0, lastTs: 0 });
    r.since += 1;
    const SIGNAL = /告白|表白|在一起|和好|复合|纪念日|生日|求婚|见家长|结婚|同居/;
    const MEM_CORR_SIGNAL = /其实那次|记错了吧|搞错了吧|不是那样|没有这回事|我记得不是|当时是在|那次是在|不对，.{0,6}是在|我说的不是/;
    const corr = MEM_CORR_SIGNAL.test(playerText);
    const due = r.since >= this.REVIEW_INTERVAL ||
                (SIGNAL.test(playerText) && r.since >= this.REVIEW_COOLDOWN) ||
                (corr && r.since >= this.REVIEW_COOLDOWN);
    if (!due) return;
    r.since = 0;
    r.lastTs = Date.now();
    this.reviewMemories(gfId, corr);   // fire-and-forget，不阻塞聊天；纠正走结构化改写
  },

  // ═══ 回忆盘点（独立小调用 · 严格标准）═══
  // 让 LLM 回顾最近对话，只挑「值得永远记住」的重要回忆。
  // 注意：盘点员是独立任务角色，system 不挂女友人设 prompt——
  // 否则模型会以角色口吻「回忆」并逐字摘抄日常对话，而不是做严格筛选。
  // 失败静默（网络/额度），绝不影响聊天；下次触发自动重试。
  async reviewMemories(gfId, structured) {
    const gf = this.allGfs()[gfId];
    if (!gf) return;
    const hist = this.state.histories[gfId] || [];
    const mems = this.state.memories[gfId] || (this.state.memories[gfId] = []);
    const existing = mems.map(m => `- ${m.id}: ${m.text}${m.pinned ? '（置顶，禁止改动）' : ''}`).join('\n');
    const recent = hist.slice(-24)
      .map(m => (m.role === 'player' ? '【用户】' : '【' + gf.name + '】')   // 身份头与主对话同格式（issue #25）
        + (m.img || m.imgLost ? '[发了一张图片]' + (m.text ? '\n' : '') : '') + m.text)   // 图片不进记忆管线，占位即可
      .join('\n');

    // 结构化协议（issue #2 ②）：盘点输出 add/update/delete，可改写旧条目
    const structuredPrompt = `你是「${gf.name}」与用户之间关系的记忆盘点员。回顾对话材料，对记忆库执行整理：
- add：新的重要回忆——关系里程碑（初遇/告白/在一起/纪念日/求婚）、感情实质进展（吵架和好、重大承诺、重要的第一次）、他的人生大事或强烈情感时刻
- update：用户在对话中纠正或补充了某条旧记忆（target_id 指向该条），text 给出修正后的完整表述
- delete：某条记忆被对话明确否定（target_id 指向该条）

普通日常、玩笑、一般约会不算。宁可空手而归，不记流水账。置顶条目禁止 update/delete。
没有需要执行的操作就输出 []。只输出 JSON 数组，不要任何其他文字：
[{"op":"add","text":"...","mood":"开心|感动|难过|心动"},{"op":"update","target_id":"id","text":"..."},{"op":"delete","target_id":"id"}]

现有记忆：
${existing || '（暂无）'}`;

    // 旧协议（结构化解析失败时的静默回退）
    const legacyPrompt = `你是「${gf.name}」与用户之间关系的记忆盘点员。回顾对话材料，只挑出「值得永远记住」的重要回忆：
- 关系里程碑：初遇、告白、在一起、纪念日、求婚
- 感情有实质进展的时刻：吵架和好、重大承诺、重要的第一次约定
- 他的人生大事或强烈情感时刻

普通日常、玩笑、一般约会不算。宁可空手而归，不记流水账。

已记录的回忆（不要重复，也不要换种说法重复）：
${mems.map(m => m.text).join('\n') || '（暂无）'}

没有新的重要回忆就只输出「无」；有则每行一条，格式：- [情绪] 回忆内容（简洁一句话，不用对话原句）。情绪从这四个里选一个：开心 / 感动 / 难过 / 心动`;

    const out = await this.smallLLMCall([
      { role: 'system', content: structured ? structuredPrompt : legacyPrompt },
      { role: 'user', content: '最近的对话材料：\n\n' + recent + '\n\n' + (structured ? '请输出记忆操作 JSON 数组（没有就输出 []）。' : '请输出值得记住的重要回忆（没有就输出「无」）。') },
    ], 1000, 20000);
    if (!out) return;

    // 结构化优先：解析成功（含空数组 []）即结束；失败静默回退纯追加
    if (structured) {
      if (this.applyStructuredMems(gfId, out)) {
        if (Math.random() < 0.3) this.consolidateMemories(gfId);   // 低频整理（fire-and-forget）
        return;
      }
    } else if (out.includes('无')) return;

    // ── 纯追加回退（旧协议：- [情绪] 内容）──
    let added = 0;
    for (let line of out.split('\n')) {
      if (structured && !/^\s*-/.test(line)) continue;   // 回退时只认旧协议行，跳过 JSON 碎片
      line = line.replace(/^[-*•\d.、\s]+/, '').trim();
      // 解析行首情绪标签「[开心] 内容」；无标签默认「感动」
      const em = line.match(/^\[(开心|感动|难过|心动)\]\s*(.+)$/);
      const mood = em ? em[1] : '感动';
      if (em) line = em[2].trim();
      if (line.length < 4 || line.length > 80) continue;
      if (mems.some(m => m.text === line)) continue;
      mems.push({ id: this.genMemId(), ts: Date.now(), text: line, mood, pinned: false, source: 'auto' });
      this.evictOldest(mems, this.MAX_MEMS);
      added++;
    }
    if (added) this.saveMemories(gfId);
  },
  // 结构化盘点结果应用（issue #2 ②）：add/update/delete；pinned 不删不改
  // 返回 true = JSON 解析成功（无论是否有变更），false = 解析失败走回退
  applyStructuredMems(gfId, out) {
    let arr;
    try {
      const m = out.match(/\[[\s\S]*\]/);   // 容错提取首个 JSON 数组
      if (!m) return false;
      arr = JSON.parse(m[0]);
    } catch (e) { return false; }
    if (!Array.isArray(arr)) return false;
    const mems = this.state.memories[gfId] || (this.state.memories[gfId] = []);
    let changed = 0;
    for (const op of arr) {
      if (!op || typeof op !== 'object') continue;
      if (op.op === 'add' && typeof op.text === 'string') {
        const text = op.text.trim();
        if (text.length >= 4 && text.length <= 80 && !mems.some(x => x.text === text)) {
          mems.push({ id: this.genMemId(), ts: Date.now(), text, mood: ['开心', '感动', '难过', '心动'].includes(op.mood) ? op.mood : '感动', pinned: false, source: 'auto' });
          changed++;
        }
      } else if ((op.op === 'update' || op.op === 'delete') && op.target_id) {
        const idx = mems.findIndex(x => x.id === op.target_id);
        if (idx < 0 || mems[idx].pinned) continue;   // pinned 不删不改
        if (op.op === 'delete') {
          mems.splice(idx, 1);
          changed++;
        } else {
          const text = (op.text || '').trim();
          if (text.length >= 4 && text.length <= 80 && text !== mems[idx].text) {
            mems[idx].text = text;
            changed++;
          }
        }
      }
    }
    this.evictOldest(mems, this.MAX_MEMS);
    if (changed) {
      this.saveMemories(gfId);
      this.toast('我们的回忆更新了');
    }
    return true;
  },
  // 低频记忆整理（issue #2 ③，consolidation，像人睡觉时整理记忆）：
  // 合并相近条目、清理过期喜好；pinned 不删不改。失败静默。
  async consolidateMemories(gfId) {
    const mems = this.state.memories[gfId] || [];
    const favs = this.state.favs[gfId] || [];
    if (mems.length < 4 && favs.length < 6) return;   // 条目太少无整理价值
    const memList = mems.map(m => `- ${m.id}: ${m.text}${m.pinned ? '（置顶）' : ''}`).join('\n');
    const favList = favs.map(f => `- ${f.id}: ${f.text}`).join('\n');
    const out = await this.smallLLMCall([
      {
        role: 'system',
        content: `你是记忆整理器（像人睡觉时整理记忆）。对以下两组记忆做低频整理：
1. mem_merges：同一事件多个版本/明显相近的条目合并——keep_id 保留条目、drop_ids 删除条目、text 为合并后的表述；置顶条目不允许出现在 drop_ids，keep_id 为置顶时不给 text（保留原表述）
2. mem_dels：明显错误的共同回忆条目 id（置顶不允许）
3. fav_dels：明显过时或重复的喜好 id
宁少勿滥：没有可整理的就输出 {}。只输出 JSON，不要任何其他文字：
{"mem_merges":[{"keep_id":"id","drop_ids":["id"],"text":"合并后表述"}],"mem_dels":["id"],"fav_dels":["id"]}

共同回忆：
${memList || '（无）'}

她的喜好：
${favList || '（无）'}`,
      },
      { role: 'user', content: '请输出整理结果 JSON。' },
    ], 800, 20000);
    if (!out) return;
    try {
      const m = out.match(/\{[\s\S]*\}/);
      if (!m) return;
      const plan = JSON.parse(m[0]);
      let changed = 0;
      for (const mg of (plan.mem_merges || [])) {
        if (!mg || typeof mg !== 'object') continue;
        const keep = mems.find(x => x.id === mg.keep_id);
        const drops = (mg.drop_ids || []).map(id => mems.find(x => x.id === id)).filter(x => x && !x.pinned);
        if (!keep || !drops.length) continue;
        const text = (mg.text || '').trim();
        if (!keep.pinned && text.length >= 4 && text.length <= 80) keep.text = text;
        for (const d of drops) mems.splice(mems.indexOf(d), 1);
        changed++;
      }
      for (const id of (plan.mem_dels || [])) {
        const idx = mems.findIndex(x => x.id === id);
        if (idx >= 0 && !mems[idx].pinned) { mems.splice(idx, 1); changed++; }
      }
      for (const id of (plan.fav_dels || [])) {
        const idx = favs.findIndex(x => x.id === id);
        if (idx >= 0) { favs.splice(idx, 1); changed++; }
      }
      if (changed) {
        this.evictOldest(mems, this.MAX_MEMS);
        this.saveMemories(gfId);
        this.saveFavs(gfId);
        this.toast('她整理了共同的记忆');
      }
    } catch (e) { console.error('[consolidateMemories]', e); }   // 失败静默
  },

  // ═══ 工具 ═══
  esc(s) {
    return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  },
  fmtDate(ts) {
    const d = new Date(ts);
    return d.getFullYear() + '年' + (d.getMonth() + 1) + '月' + d.getDate() + '日';
  },

  // ═══ 关系状态机（jiwen 积温思路 · 轻量化四轴）═══
  // 四轴 0-100：connection 连接感 / mood 情绪 / anxiety 牵挂焦虑 / busy 她的忙碌。
  // 每轮对话事件驱动微调，随时间向基线回稳；合成一句状态文案展示在个人主页。
  DRIVES_BASE: { connection: 55, mood: 70, anxiety: 20, busy: 35 },
  drivesKey(id) { return 'aigf_drives_' + id; },
  loadDrives(id) {
    try {
      const raw = localStorage.getItem(this.drivesKey(id));
      const d = raw ? JSON.parse(raw) : null;
      return d && typeof d.connection === 'number' ? d : Object.assign({}, this.DRIVES_BASE, { lastTs: 0 });
    } catch (e) {
      return Object.assign({}, this.DRIVES_BASE, { lastTs: 0 });
    }
  },
  saveDrives(id, d) {
    try { localStorage.setItem(this.drivesKey(id), JSON.stringify(d)); } catch (e) { /* 忽略 */ }
  },
  // 默认状态文案池（issue #33）：内置六角色各自带 statusPool（data.js profile 展示层，
  // 不碰 personas/prompt 段红线），自建角色无池时回落到这里。条目为字符串（任何时段
  // 可选）或 { t: 'night'|'morning'|'day'|'evening', s: '…' }（仅该时段可选）。
  STATUS_POOL_DEFAULT: {
    calm: ['安稳地想着你', '有点想你了', '在等你来聊天', { t: 'night', s: '还醒着，等你道晚安' }, { t: 'morning', s: '刚醒，在想今天怎么过' }],
    warm: ['和你很亲近', '觉得你很懂我', '想和你分享今天', { t: 'evening', s: '想跟你聊聊今天' }],
    low: ['心情一般般', '有点提不起劲', '想安静一会儿', { t: 'night', s: '有点睡不着' }],
    anxious: ['有点担心你', '在等你回消息', '你是不是很忙', { t: 'night', s: '你还没说晚安呢' }],
    busy: ['最近有点忙', '手头有点事', '忙完就找你', { t: 'day', s: '在忙，但想着你' }],
  },
  // 时间桶（issue #33 轻规则）：只影响档内选词，不改档位、不加 LLM 调用
  statusTimeBucket(d) {
    const h = d.getHours();
    if (h >= 23 || h < 5) return 'night';
    if (h < 9) return 'morning';
    if (h < 18) return 'day';
    return 'evening';
  },
  // 时间回稳：距上次更新越久，各轴越靠向基线。issue #33 重校：48h 线性回稳
  // （原 24h 全归位——聊完第二天就归位，变化不可感知）
  decayDrives(d) {
    const hours = Math.min(72, (Date.now() - (d.lastTs || 0)) / 3600000);
    for (const k of Object.keys(this.DRIVES_BASE)) {
      d[k] = d[k] + (this.DRIVES_BASE[k] - d[k]) * Math.min(1, hours / 48);
    }
    d.lastTs = Date.now();
    return d;
  },
  // 事件驱动：按玩家消息关键词微调四轴。issue #33 重校：步长加大——同类事件
  // 连续两轮即入对应档位（原步长要 4~5 轮才到阈值，实际聊天永远停在兜底档）
  updateDrives(gfId, playerText) {
    const d = this.decayDrives(this.loadDrives(gfId));
    const t = playerText || '';
    const clamp = (v) => Math.max(0, Math.min(100, v));
    if (/想你|爱你|喜欢|抱抱|开心|哈哈|好耶/.test(t)) d.connection = clamp(d.connection + 8), d.mood = clamp(d.mood + 4);
    if (/难过|累|烦|压力大|失眠|生病|哭/.test(t)) d.anxiety = clamp(d.anxiety + 10), d.mood = clamp(d.mood - 8);
    if (/加班|工作|开会|忙|项目|考试/.test(t)) d.busy = clamp(d.busy + 9);
    if (/生气|不理你|不想理|冷战|讨厌/.test(t)) d.connection = clamp(d.connection - 8), d.mood = clamp(d.mood - 12);
    this.saveDrives(gfId, d);
    if (this.driveLabelCache) delete this.driveLabelCache[gfId];   // 新事件后下次合成重掷
  },
  // 状态文案合成：主页展示（按当前最显著的轴给一句人话）。
  // 档位阈值随步长同步重校（issue #33）：anx 40 / busy 52 / mood 50 / conn 68，
  // 基线出发两轮可达。档内从文案池随机选词（时段桶过滤），结果缓存到下一次
  // 驱动事件——同会话内刷新主页不闪变；重开 App 重新合成。
  drivesText(gfId) {
    if (this.driveLabelCache && this.driveLabelCache[gfId]) return this.driveLabelCache[gfId];
    const d = this.decayDrives(this.loadDrives(gfId));
    this.saveDrives(gfId, d);
    let tier, fallback;
    if (d.anxiety >= 40) { tier = 'anxious'; fallback = '有点担心你'; }
    else if (d.busy >= 52) { tier = 'busy'; fallback = '最近有点忙'; }
    else if (d.mood <= 50) { tier = 'low'; fallback = '心情一般般'; }
    else if (d.connection >= 68) { tier = 'warm'; fallback = '和你很亲近'; }
    else { tier = 'calm'; fallback = '安稳地想着你'; }
    const gf = this.allGfs()[gfId];
    const pool = (gf && gf.profile && gf.profile.statusPool) || this.STATUS_POOL_DEFAULT;
    const bucket = this.statusTimeBucket(new Date());
    const entries = pool[tier] || this.STATUS_POOL_DEFAULT[tier] || [];
    const eligible = entries.filter(e => typeof e === 'string' || !e.t || e.t === bucket);
    const list = eligible.length ? eligible : entries;
    const pick = list.length ? list[Math.floor(Math.random() * list.length)] : fallback;
    const out = { label: typeof pick === 'string' ? pick : (pick.s || fallback), cls: tier };
    if (!this.driveLabelCache) this.driveLabelCache = {};
    this.driveLabelCache[gfId] = out;
    return out;
  },

  // ═══ 记忆注入（双向回路的「读」侧）═══
  // 把自动提取的本地记忆（Correction 规则 / 她的喜好 / 共同回忆）
  // 组装为 system 消息注入每轮对话，agent 据此调整言行。
  buildMemoryBlock(gfId) {
    const parts = [];
    const corrs = this.state.corrections[gfId] || [];
    const favs = this.state.favs[gfId] || [];
    const mems = this.state.memories[gfId] || [];
    if (corrs.length) {
      parts.push('【相处Correction（最高优先级之一，必须遵守）】这些是从真实相处中修正的规则：\n' +
        corrs.map(c => '- ' + c.text).join('\n'));
    }
    if (favs.length) {
      // 置顶喜好全量置前，未置顶取最近 12 条
      const list = [...favs.filter(f => f.pinned), ...favs.filter(f => !f.pinned).slice(-12)];
      parts.push('【她的喜好（已确认，自然使用不要罗列）】\n' +
        list.map(f => '- ' + f.text).join('\n'));
    }
    if (mems.length) {
      // 置顶回忆全量置前（玩家标记的珍贵时刻），未置顶取最近 8 条
      const list = [...mems.filter(m => m.pinned), ...mems.filter(m => !m.pinned).slice(-8)];
      parts.push('【共同回忆（重要时刻，可在合适时机自然提起）】\n' +
        list.map(m => '- ' + m.text).join('\n'));
    }
    if (!parts.length) return '';
    return '【长期记忆】以下是你们相处中沉淀下来的记忆，融入你的言行：\n\n' + parts.join('\n\n');
  },

  // ═══ Correction 闭环（对话驱动的行为修正）═══
  // 玩家消息出现纠偏信号（你不该…/你应该…/记住了吗）时，
  // 后台用一次小调用把反馈蒸馏成一条规则存入 Correction，下轮起生效。
  CORR_SIGNAL: /你不该|你应该|不要这样|以后不要|你不许|说错了|错了吧|记住了吗|记住没有|你答应过|上次就说过/,
  corrKey(id) { return 'aigf_corr_' + id; },
  loadCorrections(id) {
    try {
      const raw = localStorage.getItem(this.corrKey(id));
      const arr = raw ? JSON.parse(raw) : [];
      return Array.isArray(arr) ? arr : [];
    } catch (e) { return []; }
  },
  saveCorrections(id, arr) {
    try { localStorage.setItem(this.corrKey(id), JSON.stringify(arr)); } catch (e) { /* 忽略 */ }
  },
  maybeCorrect(gfId, playerText) {
    if (!this.CORR_SIGNAL.test(playerText)) return;
    const existing = this.state.corrections[gfId] || (this.state.corrections[gfId] = this.loadCorrections(gfId));
    const corrGfName = (this.allGfs()[gfId] || {}).name || '她';
    const recent = (this.state.histories[gfId] || []).slice(-6)
      .map(m => (m.role === 'player' ? '【用户】' : '【' + corrGfName + '】') + m.text).join('\n');   // 身份头同格式（issue #25）
    // fire-and-forget：蒸馏失败静默，不影响聊天
    (async () => {
      const out = await this.smallLLMCall([
        {
          role: 'system',
          content: `你是行为修正记录员。用户对 AI 角色提出了纠偏反馈。把反馈提炼成一条简洁、可长期执行的行为规则（以「她」开头，20 字内）。\n已有规则（不要重复）：\n${existing.map(c => '- ' + c.text).join('\n') || '（暂无）'}\n只输出一条规则本身，不要解释。若反馈不构成明确的行为修正，只输出「无」。`,
        },
        { role: 'user', content: '最近对话：\n' + recent + '\n\n提炼这条修正规则。' },
      ], 800, 15000);
      if (!out || out.includes('无')) return;
      const text = out.replace(/^[-*•\d.、\s]+/, '').trim();
      if (text.length < 3 || text.length > 40) return;
      if (existing.some(c => c.text.includes(text) || text.includes(c.text))) return;
      existing.push({ id: this.genMemId(), ts: Date.now(), text, pinned: false, source: 'auto' });
      this.evictOldest(existing, this.MAX_CORRS);
      this.saveCorrections(gfId, existing);
      this.toast('她的相处习惯已更新');
    })();
  },

  // ═══ 气泡队列：逐条延迟上屏（微信连发感） ═══
  // 首条延迟 300ms：让同一 tick 内连续入队的气泡聚合成队列，再逐条按拟人化间隔上屏（issue #78）
  // 气泡携带 gfId 归属；同一回复仅首条播提示音（避免连发轰炸）
  queueBubble(gfId, text, withSound, mid) {
    this.state.bubbleQueue.push({ gfId, text, sound: !!withSound, mid });
    this.pumpQueue();
  },
  pumpQueue() {
    if (this.state.queueTimer || this.state.bubbleQueue.length === 0) return;
    const sendNext = () => {
      this.state.queueTimer = null;
      const item = this.state.bubbleQueue.shift();
      // clean 必须在 sendNext 作用域（勿放 if(item) 块内）：下方积压调度要拿它算间隔——
      // 块内声明曾致 ReferenceError 杀死定时链，队列积压时第二条起永不显示（issue #91 回归）
      const clean = item ? this.stripFavTags(item.gfId, item.text) : '';
      if (clean) this.appendMessage('gf', clean, false, item.gfId, item.mid);
      if (item && item.sound) this.playSound();
      if (this.state.bubbleQueue.length > 0) {
        // 间隔拟人化（issue #78）：基础 + 上一条字数加权 + 随机抖动
        this.state.queueTimer = setTimeout(sendNext, this.nextMsgGap(clean));
      }
    };
    this.state.queueTimer = setTimeout(sendNext, 300);
  },
  // 下一条气泡等待时长（issue #78）：真人不会等距发消息——
  // 基础 600ms + 上一条每字 25ms（刚打完长句要歇一下）+ ×(0.75~1.35) 抖动；clamp 3s 防长回复后等待感过重
  MSG_GAP_BASE: 600,
  MSG_GAP_PER_CHAR: 25,
  MSG_GAP_JITTER: [0.75, 1.35],
  MSG_GAP_MAX: 3000,
  nextMsgGap(prevText) {
    const raw = this.MSG_GAP_BASE + String(prevText || '').length * this.MSG_GAP_PER_CHAR;
    const [lo, hi] = this.MSG_GAP_JITTER;
    return Math.min(this.MSG_GAP_MAX, Math.round(raw * (lo + Math.random() * (hi - lo))));
  },
  interruptPending() {
    if (this.state.activeController) {
      this.state.interrupted = true;
      try { this.state.activeController.abort(); } catch (e) { /* 忽略 */ }
      this.state.activeController = null;
    }
    if (this.state.queueTimer) {
      clearTimeout(this.state.queueTimer);
      this.state.queueTimer = null;
    }
    const hadQueued = this.state.bubbleQueue.length > 0;
    this.state.bubbleQueue = [];
    this.removeTyping();
    // 队列里可能有上一轮回复「已入历史但未上屏」的气泡：
    // 按历史重渲染补全（同时清掉被打断流的残留气泡）
    if (hadQueued) this.renderHistory();
  },

  // ═══ LLM 调用（DeepSeek 直连 · SSE 流式）═══
  // 主聊天直连 DeepSeek（EbbingFlow 记忆后端已移除，issue #33）；
  // 记忆提取类辅助调用（smallLLMCall）同样直连。
  async callLLM(systemPrompt, gfId, userMessage, onDelta, img) {
    // 自定义供应商（issue #18）：开关开 → endpoint/model/key 走自定义（OpenAI 兼容），
    // 其余参数（temperature/max_tokens/timeout）沿用 LLM_CONFIG token
    const useCustom = this.useCustomLlm();
    const cfg = useCustom ? Object.assign({}, LLM_CONFIG, this.customLlmCfg()) : LLM_CONFIG;
    const endpoint = useCustom ? this.normalizeChatUrl(cfg.baseUrl) : cfg.endpoint;   // ⚠ P0 回归修复（issue #59）：#33 移除 EbbingFlow 时误删了 endpoint 声明，fetch 处引用未定义变量——0.2.10/0.2.11 起聊天发消息必失败（回归测试发现）
    const apiKey = useCustom ? cfg.apiKey : localStorage.getItem('deepseek_api_key');
    if (!apiKey) throw new Error('NO_API_KEY');

    // system prompt + 最近 10 轮对话 + 当前消息
    // 注意：sendMessage 乐观上屏时已把当前消息推入 history，
    // 组装上下文先剔除它再取最近 10 轮，末尾显式追加一次，避免重复发送
    const history = this.state.histories[gfId] || [];
    const messages = [{ role: 'system', content: systemPrompt }];
    const recent = history.slice(0, -1).slice(-10);
    // 历史图片预算（issue #8）：仅随请求携带最近 IMG_BUDGET 张图，更早的降级 [图片] 文字占位
    const imgIdx = [];
    recent.forEach((m, i) => { if (m.img) imgIdx.push(i); });
    const imgAllowed = new Set(imgIdx.slice(-this.IMG_BUDGET));
    const withImage = (textPart, dataURL) => [
      { type: 'text', text: textPart || '（发了一张图片）' },
      { type: 'image_url', image_url: { url: dataURL } },
    ];
    // 隐藏身份头（issue #25）：历史正文多数不带称呼，超长上下文里 role 字段权重不足，
    // 模型会语义猜「谁说的」导致人称幻觉。双侧加【】头做显式归因（组装时内存态，
    // 不写入 hist/存档）；防模仿句见下方运行时上下文。提取路径用同一格式（见 extractFavs 等）。
    const gfName = (this.allGfs()[gfId] || {}).name || '她';
    for (let i = 0; i < recent.length; i++) {
      const m = recent[i];
      if (m.role === 'player') {
        // 引用记忆（issue #2 ①）：每轮前置引用块，后续轮次 LLM 仍能看到当时引用的上下文
        let textPart = m.text;
        if (m.imgLost) textPart = '[图片]' + (textPart ? '\n' + textPart : '');   // 已降级旧图，文字保留
        if (m.quote) textPart = m.quote + '\n\n' + textPart;
        let content;
        if (m.img && imgAllowed.has(i)) {
          content = withImage('【用户】' + textPart, m.img);
        } else if (m.img) {
          content = '【用户】' + (m.quote ? m.quote + '\n\n' : '') + '[图片]' + (m.text ? '\n' + m.text : '');
        } else {
          content = '【用户】' + textPart;
        }
        messages.push({ role: 'user', content });
      }
      else if (m.role === 'assistant' || m.role === 'gf') messages.push({ role: 'assistant', content: '【' + gfName + '】' + m.text });
    }
    // 记忆上下文：Correction 规则 + 她的喜好 + 共同回忆（自动提取的本地记忆注入给 agent）
    const memBlock = this.buildMemoryBlock(gfId);
    if (memBlock) {
      messages.push({ role: 'system', content: memBlock });
    }
    // 时间上下文 + 输出指令：紧贴当前消息放置（高注意力位）。
    // 时间必须以注入为准，agent 不得自行编造/推测当前时间或日期。
    const now = new Date();
    const week = ['日', '一', '二', '三', '四', '五', '六'][now.getDay()];
    const pad = (n) => String(n).padStart(2, '0');
    const timeStr = `${now.getFullYear()}年${now.getMonth() + 1}月${now.getDate()}日（周${week}）${pad(now.getHours())}:${pad(now.getMinutes())}`;
    // 深度思考开启时注入内心独白协议（issue #12）：独白走正文 <inner> 定界段，
    // 模型 reasoning_content 思维链不再入库/展示（口吻与结构不可控，出戏且可能暴露提示词写法）。
    // 独白协议随深度思考开关注入，不再排除自定义通道（issue #49）：
    // <inner> 是纯 content 流定界约定，与 thinking 扩展字段无关——第三方模型同样可遵循
    const innerProto = this.deepThinkingOn()
      ? '\n【内心独白】每次回复的最开头，先写一段内心独白，用 <inner> 和 </inner> 包起来：第一人称「我」、中文、一两句话，写你此刻心里真实的想法或情绪，贴合你的性格，像自言自语，不是对玩家说的话；不要写成分析、推理或回复草稿。写完 </inner> 换行，再开始正式回复正文。除开头这一段外，正文任何位置不要再出现 <inner> 标记。'
      : '';
    messages.push({
      role: 'system',
      content: `【运行时上下文，必须遵守】\n当前时间：${timeStr}。涉及现在几点、今天日期、星期、纪念日倒计时等一切时间表述时，以此为准；不要编造、不要根据对话间隔推测时间。\n【说话人标记】历史消息开头的【用户】/【${gfName}】标记仅供你分辨说话人，据此准确归因（谁说的、谁的喜好、谁的经历），绝不把用户说的话当成自己说的；也绝不在你的回复中复现【用户】【${gfName}】这类标记。\n【输出格式指令】检查上一条用户消息：如果你在回复中提到了自己的新喜好（喜欢的花、食物、音乐、电影、小习惯等；只报你自己的，对方消息里提到的喜好不算），在回复末尾单独一行输出：【喜好：以「她」开头的简短概括】。没有提到新的喜好就完全不输出这一行，不要输出任何其他标记。${innerProto}`,
    });
    // 当前消息：带图时改多模态 content 数组（vision 模型识别图片内容）
    const lastContent = img ? withImage(userMessage, img) : (userMessage || (img ? '[图片]' : ''));
    messages.push({ role: 'user', content: lastContent });

    const body = {
      model: cfg.model,
      messages: messages,
      stream: true,
      temperature: cfg.temperature,
      max_tokens: cfg.max_tokens,
    };
    // thinking / reasoning_effort 为 DeepSeek 系扩展参数，按通道分别组装（issue #49）：
    // - 官方通道：现状不变——关态显式 disabled，开态 enabled + reasoning_effort 现值
    // - 自定义通道：开 = enabled + effort 固定 high（owner 指定：有的模型没有 max 档）；
    //   关 = 完全不发字段（disabled 亦非标，不发是最兼容形态——严格网关对未知字段可能 400，
    //   用户出 400 后关掉深度思考即回落，pill title 有说明）
    const thinkOn = this.deepThinkingOn();
    if (useCustom) {
      if (thinkOn) {
        body.thinking = { type: 'enabled' };
        body.reasoning_effort = 'high';
      }
    } else {
      body.thinking = thinkOn ? cfg.thinking : { type: 'disabled' };
      if (thinkOn) body.reasoning_effort = cfg.reasoning_effort;
    }

    const controller = new AbortController();
    this.state.activeController = controller;   // 暴露给打断逻辑
    const timeout = setTimeout(() => controller.abort(), cfg.timeout_ms);
    try {
      const resp = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + apiKey,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      clearTimeout(timeout);
      if (!resp.ok) {
        const err = new Error('LLM error: ' + resp.status);
        err.status = resp.status;
        try { err.body = (await resp.text()).slice(0, 400); } catch (e2) { /* 忽略 */ }   // 服务端错误详情随异常上抛（issue #55 诊断）
        throw err;
      }
      // SSE 流解析（delta.content 增量；reasoning_content 忽略——issue #12 后独白走 <inner> 定界段）
      const reader = resp.body.getReader();
      const decoder = new TextDecoder('utf-8');
      let buffer = '';
      let full = '';
      let streamDone = false;
      while (!streamDone) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let nl;
        while ((nl = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 1);
          if (!line.startsWith('data:')) continue;
          const data = line.slice(5).trim();
          if (data === '[DONE]') { streamDone = true; break; }
          try {
            const json = JSON.parse(data);
            const delta = json.choices?.[0]?.delta;
            if (delta && delta.content) {
              full += delta.content;
              if (onDelta) onDelta(delta.content);
            }
          } catch (e) { /* 忽略异常行 */ }
        }
      }
      return full;
    } catch (e) {
      clearTimeout(timeout);
      throw e;
    } finally {
      if (this.state.activeController === controller) this.state.activeController = null;
    }
  },

  // ═══ API Key ═══
  checkApiKey() {
    const key = localStorage.getItem('deepseek_api_key');
    if (!key) this.openApiPanel();
    this.updateApiStatus();
  },
  // -- 自定义 LLM 供应商 · 多槽（issue #50）：与 DeepSeek 同级的供应商列表 --
  // 存储：aigf_custom_llms = JSON 数组 [{ id, name, baseUrl, apiKey, model }]（id 稳定生成，
  // 缺省名「自定义供应商 N」按数组序号展示，删除中间槽名字自然前移）；
  // aigf_custom_llm_active = 生效槽 id（空 = DeepSeek 官方）。旧单槽键首启迁移（见 migrateCustomLlms）。
  // 均只存 localStorage，与现有 key 策略一致（不进仓、不进存档导出）
  CUSTOM_LLMS_KEY: 'aigf_custom_llms',
  CUSTOM_ACTIVE_KEY: 'aigf_custom_llm_active',
  // 旧单槽 → 多槽一次性迁移（issue #50）：旧 aigf_custom_llm 读入为第一个槽，
  // 旧开关 aigf_use_custom_llm==='1' 则 active 指向它；旧键清掉
  migrateCustomLlms() {
    if (localStorage.getItem(this.CUSTOM_LLMS_KEY) !== null) return;
    let old = null;
    try { old = JSON.parse(localStorage.getItem('aigf_custom_llm') || 'null'); } catch (e) { /* 损坏当无 */ }
    const arr = [];
    let active = '';
    if (old && old.baseUrl && old.apiKey && old.model) {
      const id = this.genProviderId();
      arr.push({ id, seq: 1, name: old.name || '', baseUrl: old.baseUrl, apiKey: old.apiKey, model: old.model });
      if (localStorage.getItem('aigf_use_custom_llm') === '1') active = id;
    }
    try {
      localStorage.setItem(this.CUSTOM_LLMS_KEY, JSON.stringify(arr));
      localStorage.setItem(this.CUSTOM_ACTIVE_KEY, active);
    } catch (e) { /* 忽略 */ }
    localStorage.removeItem('aigf_custom_llm');
    localStorage.removeItem('aigf_use_custom_llm');
  },
  genProviderId() { return 'llm-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6); },
  loadCustomLlms() {
    this.migrateCustomLlms();
    try {
      const arr = JSON.parse(localStorage.getItem(this.CUSTOM_LLMS_KEY) || '[]');
      return Array.isArray(arr) ? arr.filter(s => s && s.id && s.baseUrl && s.apiKey && s.model) : [];
    } catch (e) { return []; }
  },
  saveCustomLlms(arr) {
    try { localStorage.setItem(this.CUSTOM_LLMS_KEY, JSON.stringify(arr)); } catch (e) { /* 忽略 */ }
  },
  customActiveId() { return localStorage.getItem(this.CUSTOM_ACTIVE_KEY) || ''; },
  // 语义（issue #50 改造）：生效槽存在即自定义通道
  useCustomLlm() {
    const id = this.customActiveId();
    return !!id && this.loadCustomLlms().some(s => s.id === id);
  },
  customLlmCfg() {
    const id = this.customActiveId();
    const slot = this.loadCustomLlms().find(s => s.id === id);
    return slot ? { name: slot.name, baseUrl: slot.baseUrl, apiKey: slot.apiKey, model: slot.model } : {};
  },
  // 槽显示名：备注名缺省「自定义供应商 N」。N = 创建时分配的稳定 seq（issue #50：
  // 删除中间槽不打乱后续名字——序号与 id/位置解耦）；极旧数据无 seq 时按位置兜底
  providerLabel(slot, idx) { return slot.name || '自定义供应商 ' + (slot.seq || (typeof idx === 'number' ? idx + 1 : 1)); },
  activeProviderName() {
    const id = this.customActiveId();
    const arr = this.loadCustomLlms();
    const idx = arr.findIndex(s => s.id === id);
    return idx >= 0 ? this.providerLabel(arr[idx], idx) : '';
  },
  // URL 规范化（issue #18）：根 / 带 /v1 / 带全路径三种填法归一为 <base>/v1/chat/completions，不重复拼接
  normalizeChatUrl(base) {
    let u = (base || '').trim().replace(/\/+$/, '');
    if (!u) return '';
    if (/\/chat\/completions$/.test(u)) return u;
    if (/\/v1$/.test(u)) return u + '/chat/completions';
    return u + '/v1/chat/completions';
  },
  readCustomLlmForm() {
    return {
      name: this.el.customLlmName.value.trim(),
      baseUrl: this.el.customLlmBase.value.trim(),
      apiKey: this.el.customLlmKey.value.trim(),
      model: this.el.customLlmModel.value.trim(),
    };
  },
  // 供应商列表渲染（issue #50）：DeepSeek（内置）+ 各自定义槽；点击行切换生效，点「编辑」开表单
  renderProviders() {
    const box = this.el.providerList;
    if (!box) return;
    const active = this.customActiveId();
    const arr = this.loadCustomLlms();
    const row = (id, label, sub, isActive) => `
      <div class="provider-row${isActive ? ' active' : ''}" data-id="${this.esc(id)}">
        <span class="provider-radio${isActive ? ' on' : ''}"></span>
        <span class="provider-name">${this.esc(label)}<span class="provider-sub">${this.esc(sub)}</span></span>
        ${id ? `<button class="provider-edit" data-edit="${this.esc(id)}" title="编辑该供应商">编辑</button>` : ''}
      </div>`;
    box.innerHTML = row('', 'DeepSeek', '（内置）', !active) +
      arr.map((s, i) => row(s.id, this.providerLabel(s, i), s.model || '', active === s.id)).join('');
  },
  // 编辑态：null = 收起；'new' = 新增空白；slot id = 编辑既有槽
  refreshCustomLlmUi() {
    this.renderProviders();
    const editing = this.state.editingProvider || null;
    this.el.customLlmForm.classList.toggle('hidden', !editing);
    const del = this.el.providerDel;
    if (del) del.classList.toggle('hidden', editing === 'new' || !editing);
    if (this.el.providerFormTitle) {
      this.el.providerFormTitle.textContent = editing === 'new' ? '新供应商（填好后点底部「保存」入列表）'
        : editing ? '编辑：' + this.activeOrEditingLabel(editing) : '';
    }
  },
  activeOrEditingLabel(editingId) {
    const arr = this.loadCustomLlms();
    const idx = arr.findIndex(s => s.id === editingId);
    return idx >= 0 ? this.providerLabel(arr[idx], idx) : '';
  },
  openProviderForm(editing) {   // 'new' | slot id
    this.state.editingProvider = editing || 'new';
    if (editing === 'new') {
      this.el.customLlmName.value = '';
      this.el.customLlmBase.value = '';
      this.el.customLlmKey.value = '';
      this.el.customLlmModel.value = '';
    } else {
      const slot = this.loadCustomLlms().find(s => s.id === editing);
      if (!slot) { this.state.editingProvider = null; return; }
      this.el.customLlmName.value = slot.name || '';
      this.el.customLlmBase.value = slot.baseUrl || '';
      this.el.customLlmKey.value = slot.apiKey || '';
      this.el.customLlmModel.value = slot.model || '';
    }
    this.refreshCustomLlmUi();
    this.el.customLlmBase.focus();
  },
  closeProviderForm() {
    this.state.editingProvider = null;
    this.refreshCustomLlmUi();
  },
  // 点击供应商行 = 切换生效槽（DeepSeek 行 = active 清空）
  setProviderActive(id) {
    try { localStorage.setItem(this.CUSTOM_ACTIVE_KEY, id || ''); } catch (e) { /* 忽略 */ }
    this.refreshCustomLlmUi();
    this.refreshThinkUi();
    this.updateApiStatus();
    this.toast(id ? '已切换到「' + this.activeProviderName() + '」' : '已切换到 DeepSeek 官方通道');
  },
  deleteProvider(id) {
    const arr = this.loadCustomLlms();
    const idx = arr.findIndex(s => s.id === id);
    if (idx < 0) return;
    const label = this.providerLabel(arr[idx], idx);
    arr.splice(idx, 1);
    this.saveCustomLlms(arr);
    if (this.customActiveId() === id) {
      try { localStorage.setItem(this.CUSTOM_ACTIVE_KEY, ''); } catch (e) { /* 忽略 */ }
      this.toast('已删除「' + label + '」，对话回落 DeepSeek 官方通道');
    } else {
      this.toast('已删除「' + label + '」');
    }
    this.closeProviderForm();
    this.refreshThinkUi();
    this.updateApiStatus();
  },
  // 测试连接：极小请求（max_tokens=1，非流式）验证 URL/Key/Model，失败 toast 给可读原因
  async testCustomLlm() {
    const c = this.readCustomLlmForm();
    if (!c.baseUrl || !c.apiKey || !c.model) { this.toast('Base URL、API Key、Model ID 都要填'); return; }
    const url = this.normalizeChatUrl(c.baseUrl);
    const btn = this.el.customLlmTest;
    btn.disabled = true;
    const old = btn.textContent;
    btn.textContent = '测试中…';
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 10000);
    try {
      const resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + c.apiKey },
        body: JSON.stringify({ model: c.model, messages: [{ role: 'user', content: 'ping' }], max_tokens: 1, stream: false }),
        signal: ctrl.signal,
      });
      if (resp.ok) this.toast('连接成功 ✓（' + c.model + '）');
      else if (resp.status === 401 || resp.status === 403) this.toast('Key 无效或无权限（HTTP ' + resp.status + '）');
      else if (resp.status === 404) this.toast('接口不存在（404）——检查 Base URL');
      else {
        let detail = '';
        try { const j = await resp.json(); detail = (j.error && j.error.message) || ''; } catch (e) { /* 非 JSON */ }
        this.toast('失败（HTTP ' + resp.status + '）' + (detail ? '：' + detail.slice(0, 80) : ''));
      }
    } catch (e) {
      this.toast(e.name === 'AbortError' ? '连接超时——检查网络或 Base URL' : '网络错误：' + (e.message || '无法连接'));
    } finally {
      clearTimeout(timer);
      btn.disabled = false;
      btn.textContent = old;
    }
  },
  openApiPanel() {
    const saved = localStorage.getItem('deepseek_api_key');
    if (saved) this.el.apiKeyInput.value = saved;
    const dash = localStorage.getItem('dashscope_api_key');
    if (dash) this.el.dashscopeKeyInput.value = dash;
    const step = localStorage.getItem('stepfun_api_key');
    if (step) this.el.stepKeyInput.value = step;
    this.state.editingProvider = null;   // 多槽（issue #50）：打开面板收起编辑表单，列表即入口
    this.refreshCustomLlmUi();
    this.el.apiPanel.classList.remove('hidden');
    if (!saved) this.el.apiKeyInput.focus();
  },
  closeApiPanel() {
    this.el.apiPanel.classList.add('hidden');
  },
  handleApiKeySave() {
    // 自定义供应商多槽（issue #50）：编辑态表单随「保存」持久化（新增入列表 / 更新既有槽）
    const editing = this.state.editingProvider || null;
    const custom = this.readCustomLlmForm();
    if (editing) {
      if (custom.baseUrl || custom.apiKey || custom.model || custom.name) {
        if (!custom.baseUrl || !custom.apiKey || !custom.model) {
          this.toast('Base URL、API Key、Model ID 都要填');
          const firstEmpty = [['custom-llm-base', custom.baseUrl], ['custom-llm-key', custom.apiKey], ['custom-llm-model', custom.model]].find(([, v]) => !v);
          const el = firstEmpty && document.getElementById(firstEmpty[0]);
          if (el) { el.focus(); el.scrollIntoView({ block: 'center', behavior: 'smooth' }); }
          return;
        }
        const arr = this.loadCustomLlms();
        if (editing === 'new') {
          const seq = arr.reduce((m, s) => Math.max(m, s.seq || 0), 0) + 1;   // 稳定序号：取最大 +1
          arr.push({ id: this.genProviderId(), seq, name: custom.name, baseUrl: custom.baseUrl, apiKey: custom.apiKey, model: custom.model });
        } else {
          const i = arr.findIndex(s => s.id === editing);
          if (i >= 0) arr[i] = Object.assign({}, arr[i], custom);
        }
        this.saveCustomLlms(arr);
      }
      this.state.editingProvider = null;   // 保存后收起编辑表单
    }
    this.refreshCustomLlmUi();   // 槽变更先刷列表——后续 Key 校验的提前 return 不应留下陈旧 DOM（#52 回归）
    const key = this.el.apiKeyInput.value.trim();
    if (!key && !this.useCustomLlm()) { this.toast('Key 不能为空（或改用自定义供应商）'); return; }
    const wasFirstKey = !localStorage.getItem('deepseek_api_key') && !!key;
    if (key) localStorage.setItem('deepseek_api_key', key);
    else localStorage.removeItem('deepseek_api_key');   // 自定义供应商生效时允许不填官方 Key
    // 网络搜索（可选，issue #9）：Tavily Key；留空即清除并关闭搜索开关
    // 语音转文字 key（issue #38）：DashScope——留空即清除并退出语音模式
    const dash = this.el.dashscopeKeyInput.value.trim();
    if (dash) localStorage.setItem('dashscope_api_key', dash);
    else {
      localStorage.removeItem('dashscope_api_key');
      if (this.state.voiceMode) this.toggleVoiceMode();
    }
    // 朗读 key（issue #42/#73）：阶跃 StepFun——留空即清除（#73 起为唯一朗读通道）
    const step = this.el.stepKeyInput.value.trim();
    if (step) localStorage.setItem('stepfun_api_key', step);
    else localStorage.removeItem('stepfun_api_key');
    this.refreshCustomLlmUi();
    this._ttsCache && this._ttsCache.clear();   // Key 可能变化，朗读缓存作废
    this.refreshThinkUi();
    this.closeApiPanel();
    this.updateApiStatus();
    this.toast('API Key 已保存');
    // 首次配置 API 且尚无自建角色时，询问是否创建
    if (wasFirstKey && Object.keys(this.state.customGfs).length === 0) {
      this.askCreateRole();
    }
  },
  askCreateRole() {
    if (confirm('要不要现在创建一位专属角色？\n（之后随时可点左侧栏的「+」创建）')) {
      this.openCreateModal();
    }
  },
  updateApiStatus() {
    const customName = this.useCustomLlm() ? this.activeProviderName() : '';
    const hasKey = !!localStorage.getItem('deepseek_api_key');
    const t = this.el.apiStatusText;
    if (t) t.textContent = customName ? customName + ' · 已启用 ✓' : (hasKey ? 'API Key 已配置 ✓' : 'API Key 未配置');
    const row = document.getElementById('api-status-row');
    if (row) row.style.color = (customName || hasKey) ? 'var(--ok-color)' : '';
  },

  // ═══ 创建角色（用户自建） ═══
  CUSTOM_COLORS: ['#D993B4', '#A292D9', '#E0B06C', '#8FB8C9', '#A9C0A0', '#C9A0B8', '#9AA8D0', '#D0A88F'],
  EMOJI_AVATARS: ['🌸', '🌙', '⭐', '🍓', '🎮', '🐱', '🎧', '🌊', '🍰', '☕', '📚', '🌿', '🎀', '🔥', '🌻', '🍊'],
  openCreateModal() {
    this.el.createName.value = '';
    this.el.createDesc.value = '';
    this.el.createMaterial.value = '';
    this.el.createHint.textContent = '';
    this.el.createHint.className = 'create-hint';
    this.state.createAvatar = '';
    this.state.createAvatarColor = '';
    this.renderAvatarPicker();
    this.el.createOverlay.classList.remove('hidden');
    this.el.createModal.classList.remove('hidden');
    this.el.createName.focus();
  },
  closeCreateModal() {
    this.el.createOverlay.classList.add('hidden');
    this.el.createModal.classList.add('hidden');
  },
  // 首字圆形头像：无素材依赖，用角色主题色画底 + 名字首字
  makeInitialAvatar(name, color) {
    const c = document.createElement('canvas');
    c.width = c.height = 80;
    const ctx = c.getContext('2d');
    ctx.beginPath();
    ctx.arc(40, 40, 40, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.font = '600 34px -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(name || '?').slice(0, 1), 40, 43);
    return c.toDataURL('image/png');
  },
  // emoji 头像：渐变圆底 + emoji（零版权素材，跨平台通用 emoji）
  makeEmojiAvatar(emoji, color) {
    const c = document.createElement('canvas');
    c.width = c.height = 80;
    const ctx = c.getContext('2d');
    const g = ctx.createLinearGradient(0, 0, 80, 80);
    g.addColorStop(0, color);
    g.addColorStop(1, this.shadeColor(color, -22));
    ctx.beginPath();
    ctx.arc(40, 40, 40, 0, Math.PI * 2);
    ctx.fillStyle = g;
    ctx.fill();
    ctx.font = '40px "Segoe UI Emoji", "Apple Color Emoji", "Noto Color Emoji", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(emoji, 40, 44);
    return c.toDataURL('image/png');
  },
  shadeColor(hex, amt) {
    const n = parseInt(hex.slice(1), 16);
    let r = (n >> 16) + amt, g = ((n >> 8) & 0xff) + amt, b = (n & 0xff) + amt;
    r = Math.max(0, Math.min(255, r));
    g = Math.max(0, Math.min(255, g));
    b = Math.max(0, Math.min(255, b));
    return '#' + ((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1);
  },
  // 头像选择器：emoji 预设网格 + 上传自定义图片
  renderAvatarPicker() {
    if (!this.el.avatarPicker) return;
    const items = this.EMOJI_AVATARS.map((em, i) => {
      const color = this.CUSTOM_COLORS[i % this.CUSTOM_COLORS.length];
      return `<button type="button" class="avatar-option" data-emoji="${em}" data-color="${color}" title="${em}"><img src="${this.makeEmojiAvatar(em, color)}" alt="${em}"></button>`;
    }).join('');
    this.el.avatarPicker.innerHTML = items + `
      <button type="button" class="avatar-option avatar-upload" id="avatar-upload-btn" title="上传图片">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 16V4M7 9l5-5 5 5"/><path d="M4 20h16"/></svg>
      </button>`;
  },
  // 上传自定义头像：压缩到 128px 存 dataURL（控制 localStorage 体积），
  // 同时提取主色作为角色主题色（rikkahub Material You 动态取色思路）
  handleAvatarUpload(file) {
    if (!file || !file.type.startsWith('image/')) return;
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        const c = document.createElement('canvas');
        const S = 128;
        c.width = c.height = S;
        const ctx = c.getContext('2d');
        const scale = Math.max(S / img.width, S / img.height);
        const w = img.width * scale, h = img.height * scale;
        ctx.drawImage(img, (S - w) / 2, (S - h) / 2, w, h);
        this.state.createAvatar = c.toDataURL('image/jpeg', 0.85);
        this.state.createAvatarColor = this.extractDominantColor(c);
        this.markAvatarSelected();
        const ub = document.getElementById('avatar-upload-btn');
        if (ub) ub.classList.add('selected');
        this.toast('头像已上传，主题色已自动匹配');
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  },
  // 从 canvas 提取主色：降采样统计非极端色像素，取最饱和的色相桶中心，
  // 再压低饱和/提亮到莫兰迪区间（与全局配色基调一致）
  extractDominantColor(canvas) {
    const ctx = canvas.getContext('2d');
    const d = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    const buckets = {};   // hue 24 桶
    let maxCount = 0;
    for (let i = 0; i < d.length; i += 16) {   // 采样 1/16 像素
      const r = d[i], g = d[i + 1], b = d[i + 2];
      const max = Math.max(r, g, b), min = Math.min(r, g, b);
      const sat = max - min;
      const lum = (r + g + b) / 3;
      if (sat < 24 || lum < 30 || lum > 225) continue;   // 跳过灰/近黑/近白
      let hue;
      if (max === r) hue = ((g - b) / sat * 60 + 360) % 360;
      else if (max === g) hue = (b - r) / sat * 60 + 120;
      else hue = (r - g) / sat * 60 + 240;
      const key = Math.round(hue / 15) % 24;
      buckets[key] = (buckets[key] || 0) + sat;   // 按「饱和度总量」加权，偏好鲜明区域
      maxCount = Math.max(maxCount, buckets[key]);
    }
    let hue = 330;   // 默认雾粉（无鲜明色时）
    if (maxCount > 0) {
      let best = -1;
      for (const k of Object.keys(buckets)) {
        if (buckets[k] === maxCount) { best = Number(k); break; }
      }
      hue = best * 15 + 7;
    }
    // 莫兰迪化：中低饱和、中低明度
    const s = 0.32, l = 0.62;
    const c = (1 - Math.abs(2 * l - 1)) * s;
    const x = c * (1 - Math.abs((hue / 60) % 2 - 1));
    const m = l - c / 2;
    let r = 0, g = 0, b = 0;
    if (hue < 60) [r, g, b] = [c, x, 0];
    else if (hue < 120) [r, g, b] = [x, c, 0];
    else if (hue < 180) [r, g, b] = [0, c, x];
    else if (hue < 240) [r, g, b] = [0, x, c];
    else if (hue < 300) [r, g, b] = [x, 0, c];
    else [r, g, b] = [c, 0, x];
    const hex = (v) => Math.round((v + m) * 255).toString(16).padStart(2, '0');
    return '#' + hex(r) + hex(g) + hex(b);
  },
  markAvatarSelected() {
    document.querySelectorAll('.avatar-option').forEach(o => o.classList.remove('selected'));
  },
  // 附件：读取文本类文件，追加进补充素材
  handleAttachFiles(files) {
    if (!files || !files.length) return;
    let pending = files.length;
    let total = '';
    const clipped = [];   // 被截断的附件名（issue #18：截断可见化）
    for (const f of files) {
      const reader = new FileReader();
      reader.onload = () => {
        // 章节化拼接（issue #18）：每个附件一个 md 二级标题，结构对创建师更友好
        const head = '\n\n## 附件：' + f.name + '\n';
        const body = String(reader.result || '');
        if (body.length > 8000) { total += head + body.slice(0, 8000); clipped.push(f.name); }
        else total += head + body;
        pending--;
        if (pending === 0) {
          this.el.createMaterial.value = (this.el.createMaterial.value + total).trim();
          this.toast('已添加 ' + files.length + ' 个附件到素材'
            + (clipped.length ? '；「' + clipped.join('」「') + '」较长，已截取前 8000 字' : ''));
        }
      };
      reader.onerror = () => { pending--; };
      reader.readAsText(f);
    }
  },
  parseRoleJson(text) {
    let t = String(text || '').trim();
    t = t.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
    const start = t.indexOf('{');
    const end = t.lastIndexOf('}');
    if (start < 0 || end <= start) return null;
    try { return JSON.parse(t.slice(start, end + 1)); }
    catch (e) { return null; }
  },
  async createCharacter() {
    const name = this.el.createName.value.trim();
    const desc = this.el.createDesc.value.trim();
    const material = this.el.createMaterial.value.trim();
    if (!name) { this.toast('请先填写角色名'); return; }
    if (!desc && !material) { this.toast('请至少写一句描述或粘贴素材'); return; }
    if (!localStorage.getItem('deepseek_api_key')) {
      this.closeCreateModal();
      this.toast('请先配置 DeepSeek API Key');
      this.openApiPanel();
      return;
    }

    const btn = this.el.createSubmitBtn;
    btn.disabled = true;
    btn.style.opacity = '.55';
    btn.textContent = '正在生成…';
    this.el.createHint.textContent = '正在为 TA 生成人格，通常需要 20~40 秒，请稍候…';
    this.el.createHint.className = 'create-hint';

    const sys = '你是角色创建师。根据用户提供的角色名、描述与素材，创建一位情感陪伴角色，输出严格 JSON（不要 markdown 代码块）：\n{"name":"角色名","tag":"一句话标签（身份·性格）","gender":"male 或 female（按描述与素材推断，无法判断时 female）","mbti":"MBTI 类型（16 型之一；描述中已写明则照用，否则按描述与素材推断最贴合的）","greeting":"开场白（第一人称，符合角色，一句）","signature":"个性签名（一句）","bio":"角色简介（2-3句）","prompt":"完整人格 prompt"}\n\nprompt 字段必须包含这些章节（中文，结构参考）：\n# {name} — 记忆与人格\n你是{name}。{身份背景，自然交代}。\n## Layer 0：核心性格（最高优先级，2-4 条性格底色；开头一行注明 MBTI 及其四维度倾向，措辞要求：作为底层言行倾向自然体现，不主动自报，除非被直接问到）\n## Layer 1：身份\n## Layer 2：表达风格（口头禅、说话方式；消息模式：像发微信纯文字，一次 1-3 条短消息换行分隔；句尾不用句号，逗号偶尔可换空格（其余标点与颜文字照角色习惯）；非见面剧情禁止动作/神态/旁白描写，线下明确见面的剧情才可有克制的动作描写）\n## Layer 3：情感逻辑（开心/不开心/被冷落时分别怎么表现）\n## Layer 4：关系行为（对正在聊天的人）\n## Layer 5：边界与雷区\n## 记忆协议\n当这轮对话让你了解到对方的新偏好时，在回复最后一行追加【喜好：以「他」开头简短概括】。\n\n硬约束：全程无任何成人/性内容；说话自然、有辨识度、不 AI 腔、不总结。';
    // 用户消息章节化（issue #18）：md 结构让创建师按章节理解素材的主次；
    // 素材区中附件已是「## 附件：xx」章节，与手写素材天然分层
    const user = '# 角色创建请求\n\n## 角色名\n' + name + '\n\n## 描述\n' + (desc || '（无）') + '\n\n## 补充素材\n' + (material || '（无）');

    try {
      const out = await this.smallLLMCall([{ role: 'system', content: sys }, { role: 'user', content: user }], 2500, 90000);
      const data = this.parseRoleJson(out);
      if (!data || !data.name || !data.prompt) throw new Error('bad parse');

      const id = 'custom_' + Date.now().toString(36);
      // 优先用上传头像提取的主色（Material You 思路），否则轮换预设色
      const color = this.state.createAvatarColor || this.CUSTOM_COLORS[Object.keys(this.state.customGfs).length % this.CUSTOM_COLORS.length];
      const gf = {
        id: id,
        name: data.name,
        tag: data.tag || '自定义角色',
        mbti: data.mbti || '',        // 创建师推断（issue #65）；主页展示 + 已在 prompt Layer 0 注入
        color: color,
        avatar: this.state.createAvatar || this.makeInitialAvatar(data.name, color),
        status: '在线',
        greeting: data.greeting || ('你好呀，我是' + data.name + '。'),
        profile: {
          signature: data.signature || '',
          basic: [],
          bio: data.bio || '',
          cards: [],
        },
        prompt: data.prompt,
      };
      // 素材随角色保存（issue #18）：保留人格生成的原始依据，存档导出自动携带
      if (material) gf.sourceMaterial = material;
      // 补齐会话/记忆状态（新建角色不在启动时的遍历范围内）
      if (!this.state.histories[id]) this.state.histories[id] = [];
      if (!this.state.favs[id]) this.state.favs[id] = [];
      if (!this.state.memories[id]) this.state.memories[id] = [];

      this.state.customGfs[id] = gf;
      this.saveCustomGfs();
      this.state.enabledGfs.add(id);   // 自建角色创建即启用（issue #7：用户主动创建，直接进聊天栏）
      this.saveEnabledGfs();
      this.closeCreateModal();
      this.renderGfList();
      this.switchGf(id);
      this.toast('角色「' + gf.name + '」创建成功');
    } catch (e) {
      console.error('[createCharacter]', e);
      this.el.createHint.textContent = e.message === 'bad parse'
        ? '生成结果格式异常，已保留你的输入，点「生成角色」重试一次即可'
        : '网络似乎不太稳定，输入已保留，请再点一次「生成角色」';
      this.el.createHint.className = 'create-hint error';
    } finally {
      btn.disabled = false;
      btn.style.opacity = '';
      btn.textContent = '✨ 生成角色';
    }
  },

  // ═══ 输入框自动伸缩 + IME 处理 ═══
  autoResizeInput() {
    const ta = this.el.playerInput;
    ta.style.height = 'auto';
    // 上限 = 2.5 行 + 上下 padding（issue #17）：实时读计算样式——双端 padding 差异与
    // 字体档（#5）切换后的行高变化自动适配，不写死 px；「露半行」是微信式的还有内容暗示
    const cs = getComputedStyle(ta);
    const lineH = parseFloat(cs.lineHeight);
    const padV = (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0);
    const cap = Number.isFinite(lineH) ? Math.round(lineH * 2.5 + padV) : 120;   // 行高取值异常回落旧上限
    ta.style.height = Math.min(ta.scrollHeight, cap) + 'px';
  },

  // ═══ 音效（WebAudio，首次交互后初始化） ═══
  playSound() {
    try {
      if (!this._audioCtx) {
        this._audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      }
      if (this._audioCtx.state === 'suspended') this._audioCtx.resume();
      const ctx = this._audioCtx;
      fetch('assets/send.mp3')
        .then(r => r.arrayBuffer())
        .then(buf => ctx.decodeAudioData(buf))
        .then(decoded => {
          const src = ctx.createBufferSource();
          src.buffer = decoded;
          src.connect(ctx.destination);
          src.start();
        })
        .catch(() => {});
    } catch (e) { /* 音效失败不影响主流程 */ }
  },

  // ═══ 键盘钩子（原生 insets 注入时调用） ═══
  setupKeyboardHook() {
    window.__onKbChange = (imeCss, navCss, kbCss) => {
      this.el.body.classList.toggle('keyboard-open', kbCss > 0);
      this.reanchorOnKb(kbCss);
    };
  },
  // ═══ 键盘开合贴底重锚定（issue #4 R2）═══
  // padding 撑出/收起会改变 #dialogue-area 的 max scrollTop：贴底状态下开键盘
  // 若不重锚，最后一段内容被输入区压住。仅当用户本就贴底时跟随（80px 阈值，
  // 与 toggleScrollBottomBtn 同源）；上翻阅读中开键盘不劫持滚动位置。
  reanchorOnKb(kbCss) {
    const kb = Number(kbCss) || 0;
    if (Math.abs(kb - (this._lastKbCss || 0)) < 20) return;   // 防 ime 抖动重复触发
    this._lastKbCss = kb;
    // 方案 b 下 keyboard-open 方向 padding 瞬贴（无过渡），scrollTo 读
    // scrollHeight 会强制同步布局，直接重锚即精确到位，无需等 rAF
    this.reanchorIfPinned();
  },
  reanchorIfPinned() {
    // _bottomIntent：点「回到底部」的入口必然在上翻态（pinned=false），
    // 若不强制重锚，键盘撑出的 Δ 会压住最后的女友回复——视野停在用户消息上
    if (!this._pinnedToBottom && !this._bottomIntent) return;
    this._bottomIntent = false;   // 消费一次；此后键盘收弹回到贴底跟踪语义
    const area = this.el.dialogueArea;
    area.scrollTo({ top: area.scrollHeight, behavior: 'instant' });
  },

  // ═══ 键盘兜底（原生注入失败时） ═══
  // 原生 MainActivity 注入 --kb-height 后本兜底自动失效（优先原生值）；
  // 浏览器或注入失败场景下，用 visualViewport 高度差估算键盘高度。
  setupKeyboardFallback() {
    const el = document.documentElement;
    const apply = () => {
      // 原生已注入则跳过
      if (el.style.getPropertyValue('--kb-height')) return;
      if (!window.visualViewport) return;
      const kb = window.innerHeight - window.visualViewport.height;
      if (kb > 0) {
        el.style.setProperty('--kb-height', kb + 'px');
        this.el.body.classList.add('keyboard-open');
      } else {
        el.style.setProperty('--kb-height', '0px');
        this.el.body.classList.remove('keyboard-open');
      }
      this.reanchorOnKb(kb);   // 浏览器兜底路径同样做贴底重锚定（issue #4）
    };
    if (window.visualViewport) {
      window.visualViewport.addEventListener('resize', apply);
      window.visualViewport.addEventListener('scroll', apply);
    }
  },

  // ═══ 清空当前对话 ═══
  clearCurrentHistory() {
    const gfId = this.state.currentGf;
    const name = this.allGfs()[gfId].name;
    if (!confirm('确定清空与「' + name + '」的聊天记录吗？')) return;
    this.state.histories[gfId] = [];
    this.saveHistory(gfId);
    this.renderHistory();
    this.toast('已清空聊天记录');
  },

  // ═══ 个人主页 ═══
  // 个人主页顶部卡片渐进收起（issue #85）：body 下滑 → --pc 0→1（阈值 110px）。
  // scroll 事件本身已按帧率合并，直接赋值即可——曾用 rAF 节流，但面板被遮挡时
  // rAF 不触发会卡死收起状态（IAB 实测），去掉后无此问题
  updateProfileCollapse() {
    const body = this.el.profileBody;
    if (!body) return;
    const p = Math.min(1, Math.max(0, body.scrollTop / 110));
    this.el.profilePanel.style.setProperty('--pc', p.toFixed(3));
  },
  // Android 返回手势/按键（issue #95）：按关闭优先级栈逐层关浮层，一次返回关一层；
  // 无浮层时沿用 Android 惯例——历史可退则退，否则退出 App（不改退出语义）。
  // 栈顺序 = 视觉叠放顺序：预览/抽屉/菜单 → 弹窗 → 主页 → 侧栏（侧栏是 .open 语义，单独判）
  handleAndroidBack() {
    const hidden = (el) => !el || el.classList.contains('hidden');
    const stack = [
      [this.el.lightboxOverlay, () => this.closeLightbox()],
      [this.el.voiceMenu, () => this.closeVoiceMenu()],
      [this.el.inputPlusMenu, () => this.closeInputPlusMenu()],
      [this.el.msgMenu, () => this.closeMsgMenu()],
      [this.el.memoryMenu, () => this.closeMemMenu()],
      [this.el.apiPanel, () => this.closeApiPanel()],
      [this.el.createOverlay, () => this.closeCreateModal()],
      [this.el.libraryOverlay, () => this.closeLibraryModal()],
      [this.el.wallOverlay, () => this.closeWallModal()],
      [this.el.fontOverlay, () => this.closeFontModal()],
      [this.el.backupOverlay, () => this.closeBackup()],
      [this.el.updateOverlay, () => this.closeUpdate()],
      [this.el.profilePanel, () => this.closeProfile()],
    ];
    for (const [el, close] of stack) {
      if (!hidden(el)) { close(); return; }
    }
    if (this.el.sidebar && this.el.sidebar.classList.contains('open')) { this.toggleSidebar(false); return; }
    if (window.history.length > 1) history.back();
    else window.Capacitor.Plugins.App.exitApp();
  },
  // 主页/文案人称（issue #53）：male=他 / female=她 / 无性别信息（自建角色）=中性 TA
  pronoun(gfId) {
    const gf = this.allGfs()[gfId || this.state.currentGf];
    return gf && gf.gender === 'male' ? '他' : gf && gf.gender === 'female' ? '她' : 'TA';
  },
  openProfile() {
    const gf = this.allGfs()[this.state.currentGf];
    if (!gf || !gf.profile) return;
    const p = gf.profile;
    // 主页回归纯白样式（issue #65）：立绘已转作聊天壁纸，主页不再有立绘背景
    //（has-hero 门控与 #10/#11/#53/#60 一族立绘特调全部退役）
    document.body.classList.add('profile-open');   // #55：主页打开时隐藏聊天区 top-bar（防状态栏区透出灰条）
    this.el.profilePanel.style.setProperty('--pc', 0);   // 收起状态复位（issue #85）
    this.el.profileBody.scrollTop = 0;
    this.el.profileAvatar.src = gf.avatar;
    this.el.profileName.textContent = gf.name;
    this.el.profileTag.textContent = gf.tag;
    this.el.profileSignature.textContent = p.signature || '';

    // 基本信息网格（自定义角色可能为空）+ MBTI（issue #65）+ 她的状态（jiwen 状态机合成）
    const drive = this.drivesText(this.state.currentGf);
    const mbtiItem = gf.mbti ? `
      <div class="profile-basic-item">
        <div class="pb-label">MBTI</div>
        <div class="pb-value">${this.esc(gf.mbti)}</div>
      </div>` : '';
    const basicHtml = (p.basic || []).map(b => `
      <div class="profile-basic-item">
        <div class="pb-label">${this.esc(b.label)}</div>
        <div class="pb-value">${this.esc(b.value)}</div>
      </div>`).join('') + mbtiItem + `
      <div class="profile-basic-item">
        <div class="pb-label">${this.pronoun()}的状态</div>
        <div class="pb-value profile-drive drive-${drive.cls}">${this.esc(drive.label)}</div>
      </div>`;
    // 关于她/他/TA（issue #53：按角色性别，自建角色中性 TA）
    const bio = p.bio ? `
      <div class="profile-section">
        <div class="profile-section-title"><span>关于${this.pronoun()}</span></div>
        <div class="profile-bio">${p.bio}</div>
      </div>` : '';
    // 回忆卡 + 喜好卡 + 相处习惯卡（可操作：置顶/删除/手动添加，issue #1 第一层）
    const gfId = this.state.currentGf;
    const favs = this.state.favs[gfId] || [];
    const mems = this.state.memories[gfId] || [];
    const corrs = this.state.corrections[gfId] || [];

    // 统计条（个人主页化 issue #27）：回忆 / 喜好 / 相伴天数（首条消息距今天数，无历史则不显示该项）
    const firstTs = ((this.state.histories[gfId] || [])[0] || {}).ts;
    const stats = [
      { n: mems.length, label: '回忆' },
      { n: favs.length, label: '喜好' },
    ];
    if (firstTs) stats.push({ n: Math.max(1, Math.floor((Date.now() - firstTs) / 864e5) + 1), label: '相伴天数' });
    if (this.el.profileStats) {
      this.el.profileStats.innerHTML = stats.map(s => `
        <div class="profile-stat"><span class="ps-num">${s.n}</span><span class="ps-label">${this.esc(s.label)}</span></div>`).join('');
    }
    // 置顶条目在卡片最上（组内也按时间倒序），未置顶按时间倒序随后
    const memSorted = [...mems.filter(m => m.pinned).reverse(), ...mems.filter(m => !m.pinned).reverse()];
    // 折叠（issue #27 终轮）：回忆默认只展示最近 5 条、喜好 10 条，其余「展开」；
    // 展开状态是会话级瞬态——主页内操作（置顶/删除/添加）触发重渲染时不回折
    if (typeof this._profileMemOpen !== 'boolean') this._profileMemOpen = false;
    if (typeof this._profileFavOpen !== 'boolean') this._profileFavOpen = false;
    const MEM_VISIBLE = 5, FAV_VISIBLE = 10;
    const memShown = this._profileMemOpen ? memSorted : memSorted.slice(0, MEM_VISIBLE);
    // 折叠按钮看总数超阈值（展开后仍要显示「收起」），文案看展开态
    const memExpandBtn = memSorted.length > MEM_VISIBLE
      ? `<button class="profile-expand-btn" data-expand="mem">${this._profileMemOpen ? '收起回忆' : '展开其余 ' + (memSorted.length - MEM_VISIBLE) + ' 条回忆'}</button>` : '';
    const memCard = mems.length ? `
      <div class="profile-section">
        <div class="profile-section-title"><span>我们的回忆</span><button class="card-add-btn" id="mem-add-btn" title="手动添加回忆" aria-label="手动添加回忆">＋</button></div>
        <div id="mem-add-slot"></div>
        <div class="profile-memory-list">
          ${memShown.map(m => `
          <div class="profile-memory-item ${m.pinned ? 'pinned' : ''}" data-mid="${this.esc(m.id)}">
            <span class="pm-dot mood-${this.esc(m.mood || '感动')}"></span>
            <span class="pm-text">${this.esc(m.text)}${m.mood ? `<span class="pm-mood">${this.esc(m.mood)}</span>` : ''}${m.source === 'manual' ? '<span class="pm-mood pm-src">手记</span>' : ''}</span>
            <span class="pm-date">${this.fmtDate(m.ts)}</span>
            ${m.pinned ? '<span class="pm-pin">置顶</span>' : ''}
          </div>`).join('')}
        </div>
        ${memExpandBtn}
      </div>` : `
      <div class="profile-section">
        <div class="profile-section-title"><span>我们的回忆</span><button class="card-add-btn" id="mem-add-btn" title="手动添加回忆" aria-label="手动添加回忆">＋</button></div>
        <div id="mem-add-slot"></div>
        <div class="profile-placeholder">·  ·  ·<br>还没有值得记住的回忆<br>说过的真心话、纪念的日子，会在这里亮起来</div>
      </div>`;
    const favSorted = favs.slice().reverse();
    const favShown = this._profileFavOpen ? favSorted : favSorted.slice(0, FAV_VISIBLE);
    const favExpandBtn = favSorted.length > FAV_VISIBLE
      ? `<button class="profile-expand-btn" data-expand="fav">${this._profileFavOpen ? '收起喜好' : '展开其余 ' + (favSorted.length - FAV_VISIBLE) + ' 条喜好'}</button>` : '';
    const favCard = favs.length ? `
      <div class="profile-section">
        <div class="profile-section-title"><span>她的喜好</span></div>
        <div class="profile-fav-chips">
          ${favShown.map(f => `<span class="pf-chip" data-fid="${this.esc(f.id)}">${this.esc(f.text)}<button class="pf-chip-x" data-x="${this.esc(f.id)}" title="删除这条喜好" aria-label="删除">×</button></span>`).join('')}
        </div>
        ${favExpandBtn}
      </div>` : `
      <div class="profile-section">
        <div class="profile-section-title"><span>她的喜好</span></div>
        <div class="profile-placeholder">（ ᐛ ）<br>她还没透露过喜欢什么<br>多陪她聊聊，这里会慢慢长出小标签</div>
      </div>`;
    // 「她的相处习惯」：Correction 隐形学习的可见化（有数据才展示）
    const corrCard = corrs.length ? `
      <div class="profile-section">
        <div class="profile-section-title"><span>她的相处习惯</span></div>
        <div class="corr-hint">她从你们的相处中学会的事 · 长按可删除</div>
        <div class="corr-list">
          ${corrs.slice().reverse().map(c => `
          <div class="corr-item" data-cid="${this.esc(c.id)}">
            <span class="corr-text">${this.esc(c.text)}</span>
            <span class="corr-date">${this.fmtDate(c.ts)}</span>
          </div>`).join('')}
        </div>
      </div>` : '';

    this.el.profileBody.innerHTML = `
      <div class="profile-section profile-basic-list">${basicHtml}</div>
      ${bio}
      ${memCard}
      ${favCard}
      ${corrCard}`;
    this.el.profilePanel.classList.remove('hidden');
    this.el.profileOverlay.classList.remove('hidden');
  },
  closeProfile() {
    document.body.classList.remove('profile-open');   // #55：恢复聊天区 top-bar
    this.el.profilePanel.classList.add('hidden');
    this.el.profileOverlay.classList.add('hidden');
    this.el.profilePanel.style.backgroundImage = '';
    this.closeMemMenu();
  },

  // ═══ 记忆条目菜单与操作（issue #1 第一层：置顶 / 删除 / 手动添加） ═══
  // 主页卡片条目长按/右键 → ActionSheet（复用 .msg-menu 样式与触觉反馈）
  openMemMenu(type, gfId, entry, x, y) {
    this._memTarget = { type, gfId, e: entry };
    const menu = this.el.memoryMenu;
    const svgChat = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.4 8.4 0 0 1-9 8.4 9 9 0 0 1-3.8-.8L3 21l1.9-5.2a8.4 8.4 0 1 1 16.1-4.3z"/></svg>';
    const svgPin = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 17v5M9 3h6l1 7 3 3H5l3-3z"/></svg>';
    const svgCopy = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>';
    const svgDel = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2M19 6v14a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V6"/></svg>';
    let html = '';
    html += `<button class="msg-menu-item" data-act="chat">${svgChat}聊这个</button>`;
    if (type === 'mem') {
      html += `<button class="msg-menu-item" data-act="pin">${svgPin}${entry.pinned ? '取消置顶' : '置顶'}</button>`;
    }
    html += `<button class="msg-menu-item" data-act="copy">${svgCopy}复制</button>`;
    html += `<button class="msg-menu-item danger" data-act="del">${svgDel}删除</button>`;
    menu.innerHTML = html;
    menu.classList.remove('hidden');
    const mobile = window.matchMedia('(max-width: 768px)').matches;
    if (mobile) {
      menu.classList.add('sheet');
      menu.style.left = '';
      menu.style.top = '';
    } else {
      menu.classList.remove('sheet');
      const mw = menu.offsetWidth, mh = menu.offsetHeight;
      menu.style.left = Math.max(8, Math.min(x, window.innerWidth - mw - 8)) + 'px';
      menu.style.top = Math.max(8, Math.min(y, window.innerHeight - mh - 8)) + 'px';
    }
  },
  // 从点击/长按目标解析记忆条目并打开菜单
  openMemMenuFor(el, x, y) {
    const gfId = this.state.currentGf;
    const memEl = el.closest('.profile-memory-item');
    const chipEl = el.closest('.pf-chip');
    const corrEl = el.closest('.corr-item');
    if (memEl) {
      const e = (this.state.memories[gfId] || []).find(m => m.id === memEl.dataset.mid);
      if (e) this.openMemMenu('mem', gfId, e, x, y);
    } else if (chipEl) {
      const e = (this.state.favs[gfId] || []).find(f => f.id === chipEl.dataset.fid);
      if (e) this.openMemMenu('fav', gfId, e, x, y);
    } else if (corrEl) {
      const e = (this.state.corrections[gfId] || []).find(c => c.id === corrEl.dataset.cid);
      if (e) this.openMemMenu('corr', gfId, e, x, y);
    }
  },
  closeMemMenu() {
    this._memTarget = null;
    this.el.memoryMenu.classList.add('hidden');
    this.el.memoryMenu.classList.remove('sheet');
  },
  onMemMenuAct(act) {
    const t = this._memTarget;
    if (!t) return;
    const store = t.type === 'mem' ? 'memories' : t.type === 'fav' ? 'favs' : 'corrections';
    const arr = this.state[store][t.gfId] || [];
    const idx = arr.findIndex(e => e.id === t.e.id);
    if (idx < 0) { this.closeMemMenu(); return; }
    if (act === 'chat') {
      // 引用记忆进对话（issue #2 ①）：关主页 → 输入框上方引用条 → 聚焦输入框
      const titles = { mem: '我们的回忆', fav: '她的喜好', corr: '她的相处习惯' };
      this.state.quote = { type: t.type, gfId: t.gfId, id: t.e.id, title: titles[t.type], text: arr[idx].text, ts: arr[idx].ts };
      this.closeMemMenu();
      this.closeProfile();
      this.showQuoteBar();
      setTimeout(() => { try { this.el.playerInput.focus(); } catch (e) { /* 忽略 */ } }, 150);
      return;
    }
    if (act === 'copy') {
      const text = arr[idx].text;
      const done = () => this.toast('已复制');
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(done).catch(() => this.toast('复制失败，请手动选择文本'));
      } else {
        this.toast('复制失败，请手动选择文本');
      }
      this.closeMemMenu();
      return;
    }
    if (act === 'pin') {
      arr[idx].pinned = !arr[idx].pinned;
      this.saveMemories(t.gfId);
      this.closeMemMenu();
      this.openProfile();
      this.toast(arr[idx].pinned ? '已置顶，不会再被新回忆挤掉' : '已取消置顶');
      return;
    }
    if (act === 'del') {
      if (!confirm('删除这条记忆？不可恢复。')) { this.closeMemMenu(); return; }
      arr.splice(idx, 1);
      if (t.type === 'mem') this.saveMemories(t.gfId);
      else if (t.type === 'fav') this.saveFavs(t.gfId);
      else this.saveCorrections(t.gfId, arr);
      this.closeMemMenu();
      this.openProfile();
      this.toast('已删除');
    }
  },
  deleteFavChip(fid) {
    const gfId = this.state.currentGf;
    const favs = this.state.favs[gfId] || [];
    const idx = favs.findIndex(f => f.id === fid);
    if (idx < 0) return;
    favs.splice(idx, 1);
    this.saveFavs(gfId);
    this.openProfile();
    this.toast('已删除该喜好');
  },
  // 手动添加回忆：回忆卡内联小表单（文本 + 日期可改 + 情绪可选）
  toggleMemForm(force) {
    const slot = document.getElementById('mem-add-slot');
    if (!slot) return;
    const existing = document.getElementById('mem-add-form');
    const show = force !== undefined ? force : !existing;
    if (!show) { if (existing) existing.remove(); return; }
    if (existing) { existing.querySelector('#mem-add-text').focus(); return; }
    const d = new Date(), p = n => String(n).padStart(2, '0');
    slot.innerHTML = `
      <div class="mem-add-form" id="mem-add-form">
        <textarea id="mem-add-text" rows="2" maxlength="80" placeholder="记下这条回忆…（2~80 字）"></textarea>
        <div class="mem-add-row">
          <input type="date" id="mem-add-date" value="${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}">
          <div class="mem-add-moods">
            ${['开心', '感动', '难过', '心动'].map((m, i) => `<button type="button" class="mem-mood-chip ${i === 1 ? 'sel' : ''}" data-mood="${m}">${m}</button>`).join('')}
          </div>
        </div>
        <div class="mem-add-actions">
          <button type="button" class="btn secondary" id="mem-add-cancel">取消</button>
          <button type="button" class="btn primary" id="mem-add-save">记下</button>
        </div>
      </div>`;
    document.getElementById('mem-add-text').focus();
  },
  addManualMem() {
    const gfId = this.state.currentGf;
    const textEl = document.getElementById('mem-add-text');
    if (!textEl) return;
    const text = textEl.value.trim();
    if (text.length < 2 || text.length > 80) { this.toast('回忆内容请写在 2~80 字之间'); return; }
    const dateVal = document.getElementById('mem-add-date').value;
    const ts = dateVal ? new Date(dateVal + 'T12:00:00').getTime() : Date.now();
    const moodSel = document.querySelector('.mem-mood-chip.sel');
    const mems = this.state.memories[gfId] || (this.state.memories[gfId] = []);
    mems.push({ id: this.genMemId(), ts, text, mood: moodSel ? moodSel.dataset.mood : '感动', pinned: false, source: 'manual' });
    this.evictOldest(mems, this.MAX_MEMS);
    this.saveMemories(gfId);
    this.openProfile();   // 重渲染卡片（会重建表单区）
    this.toast('已记下这条回忆');
  },

  // ═══ 消息右键菜单（复制 / 删除单条） ═══
  openMsgMenu(x, y, bubbleEl) {
    this._msgTarget = bubbleEl;
    const menu = this.el.msgMenu;
    menu.classList.remove('hidden');
    const mobile = window.matchMedia('(max-width: 768px)').matches;
    if (mobile) {
      // 移动端：底部 ActionSheet（全宽圆角，贴合底部导航上方）
      menu.classList.add('sheet');
      menu.style.left = '';
      menu.style.top = '';
    } else {
      // 桌面端：跟随鼠标坐标
      menu.classList.remove('sheet');
      const mw = menu.offsetWidth, mh = menu.offsetHeight;
      const left = Math.min(x, window.innerWidth - mw - 8);
      const top = Math.min(y, window.innerHeight - mh - 8);
      menu.style.left = Math.max(8, left) + 'px';
      menu.style.top = Math.max(8, top) + 'px';
    }
  },
  closeMsgMenu() {
    this._msgTarget = null;
    this.el.msgMenu.classList.add('hidden');
    this.el.msgMenu.classList.remove('sheet');
  },
  copyMsg() {
    const bubble = this._msgTarget;
    if (!bubble) return;
    const text = bubble.querySelector('.msg-text').textContent;
    const done = () => this.toast('已复制');
    const fail = () => this.toast('复制失败，请手动选择文本');
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done).catch(fail);
    } else if (document.execCommand) {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
      done();
    } else {
      fail();
    }
    this.closeMsgMenu();
  },
  deleteMsg() {
    const bubble = this._msgTarget;
    const mid = bubble && bubble.dataset.mid;
    this.closeMsgMenu();
    if (!mid) return;
    if (!confirm('删除这条消息？')) return;
    const gfId = this.state.currentGf;
    const hist = this.state.histories[gfId] || [];
    const idx = hist.findIndex(m => m.id === mid);
    if (idx < 0) return;
    hist.splice(idx, 1);
    this.saveHistory(gfId);
    this.renderHistory();
    this.toast('已删除');
  },

  // ═══ Toast ═══
  toast(msg, onClick) {
    const t = this.el.toast;
    t.textContent = msg;
    t.classList.remove('hidden');
    t.classList.toggle('toast-action', !!onClick);   // 可点击形态（issue #26：更新提示点进弹窗）
    if (onClick) {
      t.onclick = () => { this.toast(); onClick(); };   // 先收起再执行动作
    } else if (t.onclick) {
      t.onclick = null;
    }
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => { t.classList.add('hidden'); t.classList.remove('toast-action'); }, onClick ? 4200 : 2200);
  },

  // ═══ 菜单面板 ═══
  toggleSidebar(show) {
    // 移动端抽屉开合（桌面端侧栏常驻，open 态样式对常驻布局无副作用）
    const sidebar = document.getElementById('sidebar');
    sidebar.classList.toggle('open', !!show);
    if (this.el.sidebarOverlay) {
      this.el.sidebarOverlay.classList.toggle('hidden', !show);
    }
  },

  // ═══ 事件绑定 ═══
  bindEvents() {
    const self = this;

    // 发送
    this.el.sendBtn.addEventListener('click', () => this.sendMessage());

    // 语音输入（issue #38）：微信式切换键 + 按住说话（pointer 事件；滑出=取消）
    this.el.voiceModeBtn.addEventListener('click', () => this.toggleVoiceMode());
    this.el.holdTalkBtn.addEventListener('pointerdown', (e) => this.startHoldTalk(e));
    this.el.holdTalkBtn.addEventListener('pointerup', () => this.endHoldTalk(false));
    this.el.holdTalkBtn.addEventListener('pointerleave', () => this.endHoldTalk(true));
    this.el.holdTalkBtn.addEventListener('pointercancel', () => this.endHoldTalk(true));
    this.el.holdTalkBtn.addEventListener('contextmenu', (e) => e.preventDefault());

    // 聊天图片（issue #8）+ 联网搜索（issue #9）入口收进「+」聚合菜单（issue #23）
    this.el.inputPlusBtn.addEventListener('click', () => this.toggleInputPlusMenu());
    // 三瓦片（issue #74）：拍照 / 相册 / 音色
    this.el.plusPhoto.addEventListener('click', () => {
      this.closeInputPlusMenu();
      this.pickChatPhoto();
    });
    this.el.plusAlbum.addEventListener('click', () => {
      this.closeInputPlusMenu();
      this.pickChatImage();
    });
    // 输入卡 pill（issue #74）：深度思考 / 智能搜索
    this.el.thinkPill.addEventListener('click', () => this.toggleThinking());
    this.el.searchPill.addEventListener('click', () => this.toggleSearch());
    this.el.clearInputBtn.addEventListener('click', () => this.clearInput());
    // 朗读音色（issue #73）：抽屉项 → 音色列表，点选即生效并持久化
    this.el.plusVoice.addEventListener('click', () => this.openVoiceMenu());
    this.el.voiceMenu.addEventListener('click', (e) => {
      const item = e.target.closest('.voice-item');
      if (!item) return;
      const v = this.TTS_VOICES.find(x => x.id === item.dataset.voice);
      if (v) {
        this.setTtsVoice(v.id);
        this.refreshVoiceUi();   // 立即同步瓦片状态字，不等下次展开
        this.toast('朗读音色：' + v.name);
      }
      this.closeVoiceMenu();
    });
    this.refreshVoiceUi();   // 启动同步持久化的音色到瓦片状态字
    this.refreshThinkUi();   // 启动同步深度思考开关（issue #74）
    this.refreshSearchUi();  // 启动同步智能搜索 pill 状态（issue #74）
    this.el.imgFileInput.addEventListener('change', () => {
      const f = this.el.imgFileInput.files && this.el.imgFileInput.files[0];
      this.handleChatImageFile(f);
    });
    this.el.imgPreviewRemove.addEventListener('click', () => this.clearPendingImg());
    this.el.lightboxOverlay.addEventListener('click', (e) => {
      // 放大预览整层可点（图片本身也是关闭热区），但滚动/误触不传播
      if (e.target === this.el.lightboxOverlay || e.target === this.el.lightboxImg) this.closeLightbox();
    });

    // 消息右键菜单（桌面端 contextmenu / 移动端长按 500ms）
    this.el.dialogueArea.addEventListener('contextmenu', (e) => {
      const msg = e.target.closest('.msg');
      if (!msg || msg.classList.contains('time-divider') || msg.id === 'typing-indicator' || !msg.dataset.mid) return;
      e.preventDefault();
      this.openMsgMenu(e.clientX, e.clientY, msg);
    });
    // 移动端长按：touchstart 启动 500ms 定时器，touchmove/touchend 取消
    let lpTimer = null, lpTarget = null;
    this.el.dialogueArea.addEventListener('touchstart', (e) => {
      const msg = e.target.closest('.msg');
      if (!msg || msg.classList.contains('time-divider') || msg.id === 'typing-indicator' || !msg.dataset.mid) return;
      const t = e.touches[0];
      lpTarget = { msg, x: t.clientX, y: t.clientY };
      lpTimer = setTimeout(() => {
        if (lpTarget) {
          if (navigator.vibrate) navigator.vibrate(12);   // 轻触觉反馈
          this.openMsgMenu(lpTarget.x, lpTarget.y, lpTarget.msg);
          lpTarget = null;
        }
      }, 500);
    }, { passive: true });
    this.el.dialogueArea.addEventListener('touchmove', () => { clearTimeout(lpTimer); lpTarget = null; }, { passive: true });
    this.el.dialogueArea.addEventListener('touchend', () => { clearTimeout(lpTimer); lpTarget = null; }, { passive: true });
    this.el.msgCopy.addEventListener('click', () => this.copyMsg());
    this.el.msgDelete.addEventListener('click', () => this.deleteMsg());
    this.el.dialogueArea.addEventListener('scroll', () => this.closeMsgMenu());
    // 桌面端 hover 行内操作按钮（复用右键菜单的复制/删除逻辑）
    this.el.dialogueArea.addEventListener('click', (e) => {
      const op = e.target.closest('.msg-op');
      if (!op) return;
      const msg = op.closest('.msg');
      if (!msg || !msg.dataset.mid) return;
      this._msgTarget = msg;
      if (op.dataset.op === 'copy') this.copyMsg();
      else if (op.dataset.op === 'delete') this.deleteMsg();
    });

    this.el.playerInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !this.state.isComposing) {
        e.preventDefault();
        this.sendMessage();
      }
    });
    // 中文输入法组合态（防回车误发送）
    this.el.playerInput.addEventListener('compositionstart', () => { this.state.isComposing = true; });
    this.el.playerInput.addEventListener('compositionend', () => { this.state.isComposing = false; });
    this.el.playerInput.addEventListener('input', () => this.autoResizeInput());

    // 角色切换（侧栏 + 底部导航）+ 角色库入口（issue #7：原「创建角色」卡改为库面板，创建入口收进库内）
    document.addEventListener('click', (e) => {
      const libBtn = e.target.closest('#gf-library-btn');
      if (libBtn) { this.openLibraryModal(); this.toggleSidebar(false); return; }
      // 消息右键菜单外部点击关闭
      if (!this.el.msgMenu.classList.contains('hidden') &&
          !this.el.msgMenu.contains(e.target)) {
        this.closeMsgMenu();
      }
      // 记忆条目菜单（主页 ActionSheet）外部点击关闭
      if (!this.el.memoryMenu.classList.contains('hidden') &&
          !this.el.memoryMenu.contains(e.target)) {
        this.closeMemMenu();
      }
      // 「+」聚合菜单外部点击关闭（issue #23）
      if (!this.el.inputPlusMenu.classList.contains('hidden') &&
          !this.el.inputPlusMenu.contains(e.target) &&
          !this.el.inputPlusBtn.contains(e.target)) {
        this.closeInputPlusMenu();
      }
      // 音色列表外部点击关闭（issue #73）；排除「朗读音色」瓦片本身——点它刚展开列表
      if (!this.el.voiceMenu.classList.contains('hidden') &&
          !this.el.voiceMenu.contains(e.target) &&
          !this.el.plusVoice.contains(e.target)) {
        this.closeVoiceMenu();
      }
      const card = e.target.closest('.gf-card');
      if (card) { this.switchGf(card.dataset.gf); this.toggleSidebar(false); return; }
    });

    // 创建角色
    this.el.createCancelBtn.addEventListener('click', () => this.closeCreateModal());
    this.el.createOverlay.addEventListener('click', (e) => {
      if (e.target === this.el.createOverlay) this.closeCreateModal();  // 仅点遮罩关闭，点弹窗内容不关
    });
    this.el.createSubmitBtn.addEventListener('click', () => this.createCharacter());
    // 角色库（issue #7）：启停切换 / 删除自建 / 创建入口 / 完成关闭
    this.el.libraryOverlay.addEventListener('click', (e) => {
      if (e.target === this.el.libraryOverlay) { this.closeLibraryModal(); return; }   // 仅点遮罩关闭
      const del = e.target.closest('[data-lib-del]');
      if (del) { this.removeCustomGf(del.dataset.libDel); return; }
      const tog = e.target.closest('[data-lib-toggle]');
      if (tog) {
        const id = tog.dataset.libToggle;
        const on = !this.state.enabledGfs.has(id);
        if (this.setGfEnabled(id, on)) {
          if (!on && this.state.currentGf === id) {
            const fallback = this.firstEnabledGfId();
            if (fallback) this.switchGf(fallback, true);   // 停用当前会话角色：静默回落，无切换编排
          }
          this.renderGfList();
          this.renderLibraryList();
        }
      }
    });
    this.el.libraryCreateBtn.addEventListener('click', () => {
      this.closeLibraryModal();
      this.openCreateModal();
    });
    this.el.libraryCloseBtn.addEventListener('click', () => this.closeLibraryModal());
    // 头像选择：emoji 点击选中 / 上传按钮
    this.el.avatarPicker.addEventListener('click', (e) => {
      const opt = e.target.closest('.avatar-option');
      if (!opt) return;
      if (opt.id === 'avatar-upload-btn') { this.el.createAvatarInput.click(); return; }
      this.state.createAvatar = this.makeEmojiAvatar(opt.dataset.emoji, opt.dataset.color);
      this.markAvatarSelected();
      opt.classList.add('selected');
    });
    this.el.createAvatarInput.addEventListener('change', (e) => {
      if (e.target.files && e.target.files[0]) this.handleAvatarUpload(e.target.files[0]);
      e.target.value = '';
    });
    // 附件：文本类文件追加进素材
    this.el.createAttachBtn.addEventListener('click', () => this.el.createAttachInput.click());
    this.el.createAttachInput.addEventListener('change', (e) => {
      this.handleAttachFiles(e.target.files);
      e.target.value = '';
    });
    // 快捷示例：点击填入描述
    document.addEventListener('click', (e) => {
      const chip = e.target.closest('.preset-chip');
      if (chip) {
        this.el.createDesc.value = chip.dataset.preset;
        this.el.createDesc.focus();
      }
    });

    // API Key
    this.el.apiSaveBtn.addEventListener('click', () => this.handleApiKeySave());
    this.el.apiBackBtn.addEventListener('click', () => this.closeApiPanel());
    // 供应商多槽（issue #50）：行点击切换生效、编辑按钮开表单、增删入口
    this.el.providerList.addEventListener('click', (e) => {
      const editBtn = e.target.closest('.provider-edit');
      if (editBtn) { this.openProviderForm(editBtn.dataset.edit); return; }
      const row = e.target.closest('.provider-row');
      if (row) this.setProviderActive(row.dataset.id || '');
    });
    this.el.providerAdd.addEventListener('click', () => this.openProviderForm('new'));
    this.el.providerDel.addEventListener('click', () => {
      if (this.state.editingProvider && this.state.editingProvider !== 'new') this.deleteProvider(this.state.editingProvider);
    });
    this.el.customLlmTest.addEventListener('click', () => this.testCustomLlm());
    // 开放平台跳转链接（issue #90）：裸 <a> 依赖 Capacitor 默认行为——
    // 主 WebView 导航到 allowNavigation 外的 https 域名自动转系统浏览器（模拟器实测 ✓）。
    // ⚠ 原生端勿拦勿加 target=_blank：AAR 无 onCreateWindow，_blank 事件会被丢弃；
    //   @capacitor/app 6 已移除 openUrl。仅 Web 端拦截改新开标签
    if (!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform())) {
      document.querySelectorAll('.key-link').forEach(a => {
        a.addEventListener('click', (e) => {
          e.preventDefault();
          window.open(a.href, '_blank', 'noopener');
        });
      });
    }
    // Android 返回手势/按键（issue #95）：浮层逐层关闭，避免浮层开着时一按直接退出 App。
    // 仅原生环境注册（Web 端无 backButton 概念）
    if (window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform()) {
      window.Capacitor.Plugins.App.addListener('backButton', () => this.handleAndroidBack());
    }
    this.el.apiKeyInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') this.handleApiKeySave();
    });

    // 主题
    this.el.themeToggle.addEventListener('click', () => this.toggleTheme());

    // 回到底部按钮：离开对话底部浮现，点击平滑滚回 + 联动弹键盘（issue #4 ②）
    // 近顶部时兜底触发历史懒加载（issue #26：IO 在后台 WebView 可能被节流，scroll 事件永远可靠）
    this.el.dialogueArea.addEventListener('scroll', () => {
      this.toggleScrollBottomBtn();
      if (this.el.dialogueArea.scrollTop < 60) this.loadOlderBatch();
    }, { passive: true });
    this.el.scrollBottomBtn.addEventListener('click', () => {
      this.el.scrollBottomBtn.classList.remove('show');
      // 瞬时回底：smooth 与随后键盘弹起的重锚竞态会互相打断
      this._bottomIntent = true;   // 回底意图：点箭头 = 要去底部发消息，键盘弹起后强制重锚一次
      this.el.dialogueArea.scrollTo({ top: this.el.dialogueArea.scrollHeight, behavior: 'instant' });
      // 滚动到位后聚焦输入框弹键盘
      setTimeout(() => { try { this.el.playerInput.focus(); } catch (e) { /* 忽略 */ } }, 200);
    });

    // 侧栏抽屉（移动端）+ 功能区（双端）
    this.el.sidebarToggle.addEventListener('click', () => this.toggleSidebar(true));
    this.el.sidebarOverlay.addEventListener('click', () => this.toggleSidebar(false));
    this.el.sbBackup.addEventListener('click', () => { this.toggleSidebar(false); this.openBackup(); });
    // 自定义壁纸（issue #15）
    this.el.sbWall.addEventListener('click', () => { this.toggleSidebar(false); this.openWallModal(); });
    this.el.wallPickBtn.addEventListener('click', () => this.el.wallFileInput.click());
    this.el.wallFileInput.addEventListener('change', (e) => {
      const f = e.target.files && e.target.files[0];
      if (f) this.loadWallFile(f);
      e.target.value = '';
    });
    this.el.wallApplyBtn.addEventListener('click', () => this.applyWall());
    this.el.wallResetBtn.addEventListener('click', () => this.resetWall());
    this.el.wallOverlay.addEventListener('click', (e) => {
      if (e.target === this.el.wallOverlay) this.closeWallModal();   // 仅点遮罩关闭，点弹窗内容不关（弹窗铁律守卫）
    });
    this.bindWallCropDrag();
    // 引用记忆条（issue #2 ①）
    this.el.quoteClose.addEventListener('click', () => this.clearQuote());
    // 字体选择（issue #5）
    this.el.sbFont.addEventListener('click', () => { this.toggleSidebar(false); this.openFontModal(); });
    // 语音回复模式（issue #13）：文字 / 语音气泡二选一（全局持久化）
    this.el.sbVoiceReply.addEventListener('click', () => this.toggleVoiceReply());
    this.el.sbProactive.addEventListener('click', () => this.toggleProactive());
    this.el.sbNotify.addEventListener('click', () => this.toggleNotify());
    this.syncVoiceReplyUi();
    this.refreshProactiveUi();
    // 本地通知初始化（issue #41 期二）：渠道 + 点通知深链监听 + 冷启 pending 兜底 + 初始预排
    this.initNotify().finally(() => { this.state.ready = true; });
    // 主动消息心跳（issue #27 期一）：每分钟节律检查 + 回前台立即补检（错过窗口不补发）
    setInterval(() => this.proactiveCheck(), 60e3);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) this.proactiveCheck(); });
    // 自动检查更新（issue #26）：启动 10s 一次 + 24h 节流，每会话至多提示一次
    this.scheduleAutoUpdate();
    this.el.fontOptions.addEventListener('click', (e) => {
      const btn = e.target.closest('.font-option');
      if (btn) this.setFont(btn.dataset.fontKey);
    });
    this.el.fontOverlay.addEventListener('click', (e) => {
      if (e.target === this.el.fontOverlay) this.closeFontModal();   // 同款守卫：点字体选项/按钮不误关
    });
    this.el.sbUpdate.addEventListener('click', () => { this.toggleSidebar(false); this.checkUpdate(); });
    this.el.sbApi.addEventListener('click', () => { this.toggleSidebar(false); this.openApiPanel(); });
    this.el.sbClear.addEventListener('click', () => { this.toggleSidebar(false); this.clearCurrentHistory(); });

    // 存档管理
    this.el.backupExportBtn.addEventListener('click', () => this.exportBackup());
    this.el.backupImportBtn.addEventListener('click', () => this.el.backupFileInput.click());
    // 跨设备迁移区折叠开关
    const migBtn = document.getElementById('migrate-toggle-btn');
    if (migBtn) {
      migBtn.addEventListener('click', () => {
        const sec = document.getElementById('migrate-section');
        const open = sec.classList.toggle('hidden') === false;
        migBtn.textContent = open ? '跨设备迁移 / 备份文件 ▴' : '跨设备迁移 / 备份文件 ▾';
      });
    }
    this.el.backupFileInput.addEventListener('change', (e) => {
      const f = e.target.files && e.target.files[0];
      if (f) this.importBackup(f);
      e.target.value = '';   // 允许重复选择同一文件
    });
    this.el.backupOverlay.addEventListener('click', (e) => {
      if (e.target === this.el.backupOverlay) this.closeBackup();   // 仅点遮罩关闭
    });

    // 检查更新弹窗
    this.el.updateCopyBtn.addEventListener('click', () => this.copyUpdateUrl());
    this.el.updateCancelBtn.addEventListener('click', () => this.closeUpdate());
    this.el.updateOverlay.addEventListener('click', (e) => {
      if (e.target === this.el.updateOverlay) this.closeUpdate();   // 仅点遮罩关闭
    });
    this.el.updateDownloadBtn.addEventListener('click', () => {
      const url = this.el.updateDownloadBtn.dataset.url;
      this.performUpdate(url);   // 应用内下载（带进度）→ 原生拉起安装器 / Web 触发下载
    });

    // 个人主页
    this.el.gfInfo.addEventListener('click', () => this.openProfile());
    this.el.profileClose.addEventListener('click', () => this.closeProfile());
    this.el.profileOverlay.addEventListener('click', () => this.closeProfile());
    // 主页记忆卡操作（issue #1 第一层）：右键 / 长按出 ActionSheet；chip × 删除；＋ 手动添加
    this.el.profileBody.addEventListener('contextmenu', (e) => {
      const item = e.target.closest('.profile-memory-item, .pf-chip, .corr-item');
      if (!item) return;
      e.preventDefault();
      this.openMemMenuFor(item, e.clientX, e.clientY);
    });
    let memLpTimer = null, memLp = null;
    this.el.profileBody.addEventListener('touchstart', (e) => {
      const item = e.target.closest('.profile-memory-item, .pf-chip, .corr-item');
      if (!item || e.target.closest('.pf-chip-x')) return;   // × 直接删，不进长按
      const t = e.touches[0];
      memLp = { item, x: t.clientX, y: t.clientY };
      memLpTimer = setTimeout(() => {
        if (memLp) {
          if (navigator.vibrate) navigator.vibrate(12);
          this.openMemMenuFor(memLp.item, memLp.x, memLp.y);
          memLp = null;
        }
      }, 500);
    }, { passive: true });
    this.el.profileBody.addEventListener('touchmove', () => { clearTimeout(memLpTimer); memLp = null; }, { passive: true });
    this.el.profileBody.addEventListener('touchend', () => { clearTimeout(memLpTimer); memLp = null; }, { passive: true });
    this.el.memoryMenu.addEventListener('click', (e) => {
      const item = e.target.closest('.msg-menu-item');
      if (item) this.onMemMenuAct(item.dataset.act);
      else this.closeMemMenu();
    });
    this.el.profileBody.addEventListener('click', (e) => {
      const x = e.target.closest('.pf-chip-x');
      if (x) { this.deleteFavChip(x.dataset.x); return; }
      // 回忆/喜好折叠展开（issue #27 终轮）：重渲染后保持滚动位置
      const exp = e.target.closest('.profile-expand-btn');
      if (exp) {
        if (exp.dataset.expand === 'mem') this._profileMemOpen = !this._profileMemOpen;
        else this._profileFavOpen = !this._profileFavOpen;
        const st = this.el.profileBody.scrollTop;
        this.openProfile();
        this.el.profileBody.scrollTop = st;
        return;
      }
      if (e.target.closest('#mem-add-btn')) { this.toggleMemForm(); return; }
      if (e.target.closest('#mem-add-cancel')) { this.toggleMemForm(false); return; }
      if (e.target.closest('#mem-add-save')) { this.addManualMem(); return; }
      const mood = e.target.closest('.mem-mood-chip');
      if (mood) {
        mood.parentElement.querySelectorAll('.mem-mood-chip').forEach(c => c.classList.remove('sel'));
        mood.classList.add('sel');
      }
    });
    this.el.profileBody.addEventListener('scroll', () => this.closeMemMenu(), { passive: true });
    this.el.profileBody.addEventListener('scroll', () => this.updateProfileCollapse(), { passive: true });   // 顶部卡片渐进收起（issue #85）
  },
};

// 启动
document.addEventListener('DOMContentLoaded', () => {
  App.init();
});
