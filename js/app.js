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
  MAX_FAVS: 20,        // 喜好条目上限（超出淘汰最旧）
  MAX_MEMS: 15,        // 回忆条目上限（超出淘汰最旧）
  REVIEW_INTERVAL: 12, // 回忆盘点周期：累计玩家消息达此数触发
  REVIEW_COOLDOWN: 6,  // 信号词盘点冷却：距上次盘点最少消息数

  state: {
    currentGf: null,
    histories: {},       // { gfId: [{role:'player'|'gf', text}] }
    favs: {},            // { gfId: [{ts, text}] } 喜好（低门槛，随回复提取）
    memories: {},        // { gfId: [{ts, text}] } 回忆（严格，低频盘点）
    review: {},          // { gfId: { since, lastTs } } 盘点计数与冷却
    unread: {},          // { gfId: count }
    typingActive: false,
    isComposing: false,  // 中文输入法组合态
    bubbleQueue: [],     // 待上屏的气泡队列（逐条延迟发送，微信连发感）
    queueTimer: null,    // 气泡队列发送定时器
    activeController: null, // 当前 LLM 流的 AbortController（发送新消息时打断）
    interrupted: false,  // 当前流是否被用户打断
    activeStreamGf: null,  // 正在流式回复的女友 id（无则 null；切女友时据此清理队列）
    streamSkips: 0,      // 本次流中被跨女友守卫跳过上屏的气泡数
    extracting: false,   // 喜好提取调用进行中（防并发重复提取）
  },

  el: {},

  // ═══ 初始化（独立 try/catch，防单步失败拖垮整体） ═══
  init() {
    try { this.cacheElements(); } catch (e) { console.error('[init] cacheElements', e); }
    try { this.applyTheme(); } catch (e) { console.error('[init] applyTheme', e); }
    try { this.loadAllHistories(); } catch (e) { console.error('[init] loadAllHistories', e); }
    try { this.renderGfList(); } catch (e) { console.error('[init] renderGfList', e); }
    try { this.switchGf(Object.keys(GIRLFRIENDS)[0]); } catch (e) { console.error('[init] switchGf', e); }
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
      bottomNav: document.getElementById('mobile-bottom-nav'),
      dialogueArea: document.getElementById('dialogue-area'),
      playerInput: document.getElementById('player-input'),
      sendBtn: document.getElementById('send-btn'),
      apiStatusText: document.getElementById('api-status-text'),
      apiModal: document.getElementById('api-modal'),
      apiKeyInput: document.getElementById('api-key-input'),
      memoryBackendInput: document.getElementById('memory-backend-input'),
      apiSaveBtn: document.getElementById('api-save-btn'),
      apiSkipBtn: document.getElementById('api-skip-btn'),
      apiBtn: document.getElementById('api-btn'),
      menuBtn: document.getElementById('menu-btn'),
      themeToggle: document.getElementById('theme-toggle'),
      menuPanel: document.getElementById('menu-panel'),
      menuOverlay: document.getElementById('menu-overlay'),
      menuTheme: document.getElementById('menu-theme'),
      menuApi: document.getElementById('menu-api'),
      menuClear: document.getElementById('menu-clear'),
      menuUpdate: document.getElementById('menu-update'),
      updateOverlay: document.getElementById('update-overlay'),
      updateModal: document.getElementById('update-modal'),
      updateDesc: document.getElementById('update-desc'),
      updateCopyBtn: document.getElementById('update-copy-btn'),
      updateCancelBtn: document.getElementById('update-cancel-btn'),
      updateDownloadBtn: document.getElementById('update-download-btn'),
      menuBackup: document.getElementById('menu-backup'),
      backupOverlay: document.getElementById('backup-overlay'),
      backupModal: document.getElementById('backup-modal'),
      backupExportBtn: document.getElementById('backup-export-btn'),
      backupImportBtn: document.getElementById('backup-import-btn'),
      backupFileInput: document.getElementById('backup-file-input'),
      backupOutput: document.getElementById('backup-output'),
      backupCopyBtn: document.getElementById('backup-copy-btn'),
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
      profileBody: document.getElementById('profile-body'),
    };
  },

  // ═══ 主题 ═══
  // 三主题循环：珍珠潮汐(light) → 海港(harbor) → 星河(moon)
  THEMES: {
    light: '珍珠潮汐',
    harbor: '海港',
    moon: '星河',
  },
  THEME_ORDER: ['light', 'harbor', 'moon'],
  applyTheme() {
    let saved = localStorage.getItem('aigf_theme') || 'light';
    if (!this.THEMES[saved]) saved = 'light';   // 兼容旧值/未知值
    document.documentElement.setAttribute('data-theme', saved);
    const name = this.THEMES[saved];
    this.el.menuTheme.textContent = '🌓 主题：' + name;
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
  // 更新源：chemmy-11/moonveil-updates（只含 latest.json + APK，匿名可读）
  // 发布流程：更新 latest.json 版本号/说明 → 覆盖上传新 APK → 手机上点「检查更新」
  // 注意：fetch 必须带超时——raw CDN 在部分网络（含 VPN）下会挂起连接，
  // 无超时会导致按钮一直禁用、「卡住」无法恢复。
  checkUpdate() {
    const btn = this.el.menuUpdate;
    btn.disabled = true;
    btn.style.opacity = '.55';
    const UPDATER_URL = 'https://raw.githubusercontent.com/chemmy-11/moonveil-updates/master/latest.json';
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);   // 15s 超时兜底
    fetch(UPDATER_URL, { cache: 'no-store', signal: controller.signal })
      .then(async (resp) => {
        if (!resp.ok) throw new Error('HTTP ' + resp.status);
        const meta = await resp.json();
        const latest = String(meta.version || '').replace(/^v/i, '');
        const cur = String(APP_VERSION || '1.0.0');
        if (!latest || this.compareVersions(latest, cur) <= 0) {
          this.toast('已是最新版本 v' + cur);
          return;
        }
        // 有新版 → 弹窗（更新说明截取前几行）
        const notes = String(meta.notes || '').trim().split('\n').slice(0, 6).join('\n');
        this.el.updateDesc.textContent =
          '当前版本 v' + cur + '，发现新版本 v' + latest + '。' +
          (notes ? '\n\n' + notes : '');
        this.el.updateDownloadBtn.dataset.url = meta.apk_url || '';
        this.el.updateOverlay.classList.remove('hidden');
        this.el.updateModal.classList.remove('hidden');
      })
      .catch((e) => {
        console.error('[checkUpdate]', e);
        this.toast(e.name === 'AbortError'
          ? '检查更新超时（网络到更新源不通），请稍后再试'
          : '检查更新失败，请稍后再试');
      })
      .finally(() => {
        clearTimeout(timeout);
        btn.disabled = false;
        btn.style.opacity = '';
      });
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
    this.el.backupOverlay.classList.remove('hidden');
    this.el.backupModal.classList.remove('hidden');
  },
  closeBackup() {
    this.el.backupOverlay.classList.add('hidden');
    this.el.backupModal.classList.add('hidden');
  },
  exportBackup() {
    const data = {
      app: 'moonveil',
      exportedAt: new Date().toISOString(),
      version: APP_VERSION,
      histories: this.state.histories,
      favs: this.state.favs,
      memories: this.state.memories,
    };
    this.el.backupOutput.value = JSON.stringify(data);
    this.el.backupOutput.classList.remove('hidden');
    this.el.backupCopyBtn.style.display = '';
    this.el.backupOutput.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    this.toast('存档已生成，点「复制存档」保存到微信/备忘录');
  },
  copyBackup() {
    const text = this.el.backupOutput.value;
    if (!text) return;
    const done = () => this.toast('存档已复制到剪贴板');
    const fail = () => this.toast('复制失败，长按文本框手动复制');
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done).catch(fail);
    } else if (this.el.backupOutput.select && document.execCommand) {
      this.el.backupOutput.select();
      document.execCommand('copy');
      done();
    } else {
      fail();
    }
  },
  importBackup(file) {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const data = JSON.parse(reader.result);
        if (data.app !== 'moonveil' || !data.histories || typeof data.histories !== 'object') {
          throw new Error('bad format');
        }
        if (!confirm('导入将覆盖当前全部聊天记录，确定继续？')) return;
        this.state.histories = {};
        this.state.favs = {};
        this.state.memories = {};
        for (const id of Object.keys(GIRLFRIENDS)) {
          this.state.histories[id] = Array.isArray(data.histories[id]) ? data.histories[id] : [];
          this.state.favs[id] = Array.isArray(data.favs && data.favs[id]) ? data.favs[id] : [];
          this.state.memories[id] = Array.isArray(data.memories && data.memories[id]) ? data.memories[id] : [];
          this.saveHistory(id);
          this.saveFavs(id);
          this.saveMemories(id);
        }
        this.renderHistory();
        this.toast('存档已导入');
      } catch (e) {
        console.error('[importBackup]', e);
        this.toast('存档文件无效，请检查');
      }
    };
    reader.readAsText(file);
  },

  // ═══ 持久化 ═══
  histKey(id) { return 'aigf_hist_' + id; },
  favsKey(id) { return 'aigf_favs_' + id; },
  memsKey(id) { return 'aigf_mem_' + id; },
  loadAllHistories() {
    for (const id of Object.keys(GIRLFRIENDS)) {
      try {
        const raw = localStorage.getItem(this.histKey(id));
        this.state.histories[id] = raw ? JSON.parse(raw) : [];
      } catch (e) {
        this.state.histories[id] = [];
      }
      // 喜好与回忆（自动提取的卡片数据）
      for (const kind of ['favs', 'memories']) {
        const key = kind === 'favs' ? this.favsKey(id) : this.memsKey(id);
        try {
          const raw = localStorage.getItem(key);
          const arr = raw ? JSON.parse(raw) : [];
          this.state[kind][id] = Array.isArray(arr) ? arr : [];
        } catch (e) {
          this.state[kind][id] = [];
        }
      }
    }
  },
  saveHistory(id) {
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

  // ═══ 角色列表渲染（侧栏 + 底部导航） ═══
  renderGfList() {
    const listHtml = Object.values(GIRLFRIENDS).map(gf => `
      <div class="gf-card" data-gf="${gf.id}">
        <img class="gf-card-avatar" src="${gf.avatar}" alt="">
        <div>
          <div class="gf-card-name">${gf.name}</div>
          <div class="gf-card-tag">${gf.tag}</div>
        </div>
      </div>`).join('');
    this.el.gfList.innerHTML = listHtml;

    const navHtml = Object.values(GIRLFRIENDS).map(gf => `
      <button class="bottom-nav-item" data-gf="${gf.id}">
        <span class="bn-icon" style="background-image:url('${gf.avatar}')"><span class="bn-dot"></span></span>
        <span class="bn-label">${gf.name}</span>
      </button>`).join('');
    this.el.bottomNav.innerHTML = navHtml;
  },

  // ═══ 切换女友 ═══
  switchGf(id) {
    const gf = GIRLFRIENDS[id];
    if (!gf) return;
    this.state.currentGf = id;
    this.state.unread[id] = 0;

    // 主题色随角色切换
    this.el.body.setAttribute('data-gf', id);
    document.title = gf.name + ' · 月见';

    // 顶栏
    this.el.topAvatar.src = gf.avatar;
    this.el.topName.textContent = gf.name;
    this.el.topStatusText.textContent = gf.status;

    // 侧栏高亮
    document.querySelectorAll('.gf-card').forEach(c => {
      c.classList.toggle('active', c.dataset.gf === id);
    });
    // 底部导航高亮 + 未读
    document.querySelectorAll('.bottom-nav-item').forEach(b => {
      b.classList.toggle('active', b.dataset.gf === id);
    });
    this.refreshNavUnread();

    // 该女友的流已结束（历史已保存）时，清掉其队列残留，避免与 renderHistory 重复渲染
    if (this.state.activeStreamGf !== id) {
      this.state.bubbleQueue = this.state.bubbleQueue.filter(i => i.gfId !== id);
    }

    this.renderHistory();
    this.updateApiStatus();
    this.el.playerInput.focus();
  },

  // ═══ 刷新底部导航未读点（跨女友到达气泡时调用） ═══
  refreshNavUnread() {
    document.querySelectorAll('.bottom-nav-item').forEach(b => {
      b.classList.toggle('unread', (this.state.unread[b.dataset.gf] || 0) > 0);
    });
  },

  // ═══ 渲染对话历史 ═══
  renderHistory() {
    const area = this.el.dialogueArea;
    area.innerHTML = '';
    const hist = this.state.histories[this.state.currentGf] || [];

    if (hist.length === 0) {
      // 首次进入：女友发来开场白
      const gf = GIRLFRIENDS[this.state.currentGf];
      hist.push({ role: 'gf', text: gf.greeting });
      this.state.histories[this.state.currentGf] = hist;
      this.saveHistory(this.state.currentGf);
      this.appendMessage('gf', gf.greeting);
      this.updateApiStatus();
      return;
    }
    for (const m of hist) {
      if (m.role === 'gf') {
        // 同一次回复的多个气泡（\n 分隔）拆成多条渲染
        for (const seg of m.text.split('\n')) {
          if (seg.trim()) this.appendMessage('gf', seg, true);
        }
      } else {
        this.appendMessage(m.role, m.text, true);
      }
    }
    this.scrollToBottom(false);
  },

  // ═══ 追加消息气泡 ═══
  // gfId 指定气泡归属（流式回复跨女友时用），缺省为当前女友
  appendMessage(role, text, noScroll, gfId) {
    const targetGf = gfId || this.state.currentGf;

    // 跨女友守卫：气泡属于别的女友且当前没在看她 → 不上屏，计入未读
    if (role === 'gf' && targetGf !== this.state.currentGf) {
      this.state.unread[targetGf] = (this.state.unread[targetGf] || 0) + 1;
      this.state.streamSkips++;      // 记录被跳过的气泡，流结束后按历史补渲染
      this.refreshNavUnread();
      return;
    }

    const area = this.el.dialogueArea;
    const wrap = document.createElement('div');
    wrap.className = 'msg ' + (role === 'player' ? 'player' : 'gf');

    if (role === 'gf') {
      const gf = GIRLFRIENDS[targetGf];
      const img = document.createElement('img');
      img.className = 'msg-avatar';
      img.src = gf.avatar;
      img.alt = gf.name;
      wrap.appendChild(img);
    }

    const bubble = document.createElement('div');
    bubble.className = 'msg-text';
    bubble.textContent = text;
    wrap.appendChild(bubble);
    area.appendChild(wrap);

    if (!noScroll) this.scrollToBottom();
  },

  scrollToBottom(smooth = true) {
    const area = this.el.dialogueArea;
    area.scrollTo({ top: area.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
  },

  // ═══ 打字指示器 ═══
  showTyping(gfId) {
    if (this.state.typingActive) return;
    const gf = GIRLFRIENDS[gfId || this.state.currentGf];
    if (!gf || gf.id !== this.state.currentGf) return;   // 已切走：不显示指示器
    this.state.typingActive = true;
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
  },

  // ═══ 发送（流式：智能拆条 + 逐条延迟上屏，像真人微信聊天） ═══
  async sendMessage() {
    const text = this.el.playerInput.value.trim();
    if (!text) return;

    // 打断上一轮未完成的回复：中止进行中的流 + 丢弃待发送气泡队列
    if (this.state.activeController || this.state.bubbleQueue.length > 0) {
      this.interruptPending();
    }

    const gfId = this.state.currentGf;
    this.state.activeStreamGf = gfId;
    this.state.streamSkips = 0;
    this.el.playerInput.value = '';
    this.autoResizeInput();

    // 乐观上屏
    this.state.histories[gfId].push({ role: 'player', text });
    this.saveHistory(gfId);
    this.appendMessage('player', text);
    this.playSound();

    // 流式回复：智能拆条（微信连续多条消息感）
    // - \n 始终切（prompt 消息模式约定：每条消息用换行分隔）
    // - 强标点 。！？!? 处记录可切点，但**延迟到下一个文字字符到达才切**
    //   → 连续标点（！！）、句末 emoji/颜文字（！✨）整体并入同一条，不再产生碎片
    // - ～…；; 等弱标点不切（语气词与颜文字的组成部分）
    // - ≥50 字强切兜底；单次回复最多 10 条，超出并入最后一条（内容不丢）
    const gf = GIRLFRIENDS[gfId];
    const bubbles = [];       // 本次回复的所有气泡文本（历史用）
    const MAX_BUBBLES = 10;
    let curSentence = '';     // 当前句子缓冲
    let cutPos = -1;          // 缓冲中的可切分位置（最后一个强标点之后）
    let gotContent = false;
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
      this.queueBubble(gfId, seg, bubbles.length === 1);  // 入队延迟上屏；首条气泡带提示音
    };

    this.showTyping(gfId);
    try {
      await this.callLLM(gf.prompt, gfId, text, (delta) => {
        gotContent = true;
        if (this.state.typingActive) this.removeTyping();  // 首个 token 到达 → 移除打字指示器
        for (const ch of delta) {
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
      });
      // 流结束：剩余缓冲提交
      if (curSentence.trim()) flushAt(0);
      if (!gotContent || bubbles.length === 0) {
        const fallback = '……（她好像走神了，再说一次？）';
        bubbles.push(fallback);
        this.queueBubble(gfId, fallback, false);
      }
      // 同一次回复的多个气泡合并为一条历史消息（\n 分隔），渲染时拆条
      // （commitReply 内会剥离【喜好】标记并入库）
      this.commitReply(gfId, bubbles);
      this.settleStream(gfId);
      // 记忆提取（均后台静默）：喜好每轮小调用；回忆按周期/信号词盘点
      this.extractFavs(gfId);
      this.maybeReviewMemories(gfId, text);
    } catch (e) {
      // 被打断：静默放弃残句（用户已发新消息）
      if (this.state.interrupted) {
        this.state.interrupted = false;
        this.removeTyping();
        return;
      }
      // 断流：已收到的内容保留上屏（入队）
      if (curSentence.trim()) flushAt(0);
      this.commitReply(gfId, bubbles);
      this.removeTyping();
      this.settleStream(gfId);
      console.error('[sendMessage]', e);
      if (e.message === 'NO_API_KEY') {
        this.toast('请先配置 API Key');
        this.openApiModal();
      } else if (e.status === 401 || e.status === 403) {
        this.toast('API Key 无效，请检查后重试');
        this.openApiModal();
      } else if (e.status === 429) {
        this.toast('请求太频繁了，稍等一下再发');
      } else {
        this.toast('网络似乎不太稳定，稍后再试试');
      }
    }
    this.removeTyping();
    this.state.activeStreamGf = null;
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
  commitReply(gfId, bubbles) {
    const clean = bubbles
      .map(b => this.stripFavTags(gfId, b))
      .filter(b => b.trim());
    if (clean.length) {
      this.state.histories[gfId].push({ role: 'gf', text: clean.join('\n') });
      this.saveHistory(gfId);
    }
  },

  // ═══ 喜好标记提取（低门槛 · 零额外调用） ═══
  // 「【喜好：xxx】」从回复文本中剥离（用户不可见）并入库去重，返回干净文本。
  // 上屏（pumpQueue）与历史保存（commitReply）都会调用，相同条目去重保证幂等。
  stripFavTags(gfId, text) {
    const re = /【喜好[:：]\s*([^【】]{2,40}?)】/g;
    const favs = this.state.favs[gfId] || (this.state.favs[gfId] = []);
    let added = false;
    let m;
    while ((m = re.exec(text)) !== null) {
      const item = m[1].trim().replace(/^她(喜欢|爱|讨厌|不喜欢|爱吃|爱喝|爱听)/, '').trim();
      if (item && !favs.some(f => f.text === item)) {
        favs.push({ ts: Date.now(), text: item });
        if (favs.length > this.MAX_FAVS) favs.shift();
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
    const gf = GIRLFRIENDS[gfId];
    if (!gf) return;
    const hist = this.state.histories[gfId] || [];
    const existing = (this.state.favs[gfId] || []).map(f => f.text).join('\n');
    const recent = hist.slice(-8)
      .map(m => (m.role === 'player' ? '他：' : gf.name + '：') + m.text)
      .join('\n');
    if (!recent.trim()) return;

    this.state.extracting = true;
    try {
      const out = await this.smallLLMCall([
        {
          role: 'system',
          content: `你是偏好记录员。从对话中提取关于「她」（${gf.name}）的新喜好：她喜欢或讨厌的事物、口味、习惯、爱好（花、食物、音乐、电影、小习惯等）。标准宽松：她提到或展现出来的都算，宁多勿漏。\n已记录（不要重复，也不要换种说法重复）：\n${existing || '（暂无）'}\n没有新的喜好就只输出「无」；有则每行一条，格式：- 简短条目（2~8个字，直接写事物本身，不要「她喜欢」前缀，如「洋桔梗」「安静的吉他曲」）`,
        },
        { role: 'user', content: recent + '\n\n请输出新发现的她的喜好（没有就输出「无」）。' },
      ], 800, 15000);
      if (!out || out.includes('无')) return;

      const favs = this.state.favs[gfId] || (this.state.favs[gfId] = []);
      let added = 0;
      for (let line of out.split('\n')) {
        line = line.replace(/^[-*•\d.、\s]+/, '').replace(/^她(喜欢|爱|讨厌|不喜欢|爱吃|爱喝|爱听)/, '').trim();
        if (line.length < 2 || line.length > 16) continue;   // chips 保持短标签
        if (favs.some(f => f.text === line)) continue;
        favs.push({ ts: Date.now(), text: line });
        if (favs.length > this.MAX_FAVS) favs.shift();
        added++;
      }
      if (added) this.saveFavs(gfId);
    } finally {
      this.state.extracting = false;
    }
  },

  // ═══ 回忆盘点触发（严格 · 低频 · 后台静默） ═══
  // 双通道：① 累计玩家消息达 REVIEW_INTERVAL 条；② 信号词立即触发（受冷却约束）
  maybeReviewMemories(gfId, playerText) {
    const r = this.state.review[gfId] || (this.state.review[gfId] = { since: 0, lastTs: 0 });
    r.since += 1;
    const SIGNAL = /告白|表白|在一起|和好|复合|纪念日|生日|求婚|见家长|结婚|同居/;
    const due = r.since >= this.REVIEW_INTERVAL ||
                (SIGNAL.test(playerText) && r.since >= this.REVIEW_COOLDOWN);
    if (!due) return;
    r.since = 0;
    r.lastTs = Date.now();
    this.reviewMemories(gfId);   // fire-and-forget，不阻塞聊天
  },

  // ═══ 回忆盘点（独立小调用 · 严格标准）═══
  // 让 LLM 回顾最近对话，只挑「值得永远记住」的重要回忆。
  // 注意：盘点员是独立任务角色，system 不挂女友人设 prompt——
  // 否则模型会以角色口吻「回忆」并逐字摘抄日常对话，而不是做严格筛选。
  // 失败静默（网络/额度），绝不影响聊天；下次触发自动重试。
  async reviewMemories(gfId) {
    const gf = GIRLFRIENDS[gfId];
    if (!gf) return;
    const hist = this.state.histories[gfId] || [];
    const existing = (this.state.memories[gfId] || []).map(m => m.text).join('\n');
    const recent = hist.slice(-24)
      .map(m => (m.role === 'player' ? '他：' : gf.name + '：') + m.text)
      .join('\n');

    const out = await this.smallLLMCall([
      {
        role: 'system',
        content: `你是「${gf.name}」与用户之间关系的记忆盘点员。回顾对话材料，只挑出「值得永远记住」的重要回忆：
- 关系里程碑：初遇、告白、在一起、纪念日、求婚
- 感情有实质进展的时刻：吵架和好、重大承诺、重要的第一次约定
- 他的人生大事或强烈情感时刻

普通日常、玩笑、一般约会不算。宁可空手而归，不记流水账。

已记录的回忆（不要重复，也不要换种说法重复）：
${existing || '（暂无）'}

没有新的重要回忆就只输出「无」；有则每行一条，格式：- 回忆内容（简洁一句话，不用对话原句）`,
      },
      { role: 'user', content: '最近的对话材料：\n\n' + recent + '\n\n请输出值得记住的重要回忆（没有就输出「无」）。' },
    ], 800, 20000);
    if (!out || out.includes('无')) return;

    const mems = this.state.memories[gfId] || (this.state.memories[gfId] = []);
    let added = 0;
    for (let line of out.split('\n')) {
      line = line.replace(/^[-*•\d.、\s]+/, '').trim();
      if (line.length < 4 || line.length > 80) continue;
      if (mems.some(m => m.text === line)) continue;
      mems.push({ ts: Date.now(), text: line });
      if (mems.length > this.MAX_MEMS) mems.shift();
      added++;
    }
    if (added) this.saveMemories(gfId);
  },

  // ═══ 工具 ═══
  esc(s) {
    return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  },
  fmtDate(ts) {
    const d = new Date(ts);
    return d.getFullYear() + '年' + (d.getMonth() + 1) + '月' + d.getDate() + '日';
  },

  // ═══ 气泡队列：逐条延迟上屏（微信连发感） ═══
  // 首条延迟 300ms：让同一 tick 内连续入队的气泡聚合成队列，再逐条 450ms 播放
  // 气泡携带 gfId 归属；同一回复仅首条播提示音（避免连发轰炸）
  queueBubble(gfId, text, withSound) {
    this.state.bubbleQueue.push({ gfId, text, sound: !!withSound });
    this.pumpQueue();
  },
  pumpQueue() {
    if (this.state.queueTimer || this.state.bubbleQueue.length === 0) return;
    const sendNext = () => {
      this.state.queueTimer = null;
      const item = this.state.bubbleQueue.shift();
      if (item) {
        // 上屏前剥离【喜好】标记（用户不可见），剥空则跳过该气泡
        const clean = this.stripFavTags(item.gfId, item.text);
        if (clean) this.appendMessage('gf', clean, false, item.gfId);
        if (item.sound) this.playSound();
      }
      if (this.state.bubbleQueue.length > 0) {
        this.state.queueTimer = setTimeout(sendNext, 450);
      }
    };
    this.state.queueTimer = setTimeout(sendNext, 300);
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
  // 可选记忆后端（EbbingFlow）：配置 ebbingflow_endpoint 后，
  // 主聊天改走 EbbingFlow 的 OpenAI 兼容接口（user 字段区分三位女友的独立记忆库）；
  // 记忆提取类辅助调用（smallLLMCall）始终直连 DeepSeek，避免污染后端记忆。
  async callLLM(systemPrompt, gfId, userMessage, onDelta) {
    const cfg = LLM_CONFIG;
    const backend = (localStorage.getItem('ebbingflow_endpoint') || '').trim().replace(/\/+$/, '');
    const apiKey = backend ? 'local' : localStorage.getItem('deepseek_api_key');
    if (!apiKey) throw new Error('NO_API_KEY');

    // system prompt + 最近 10 轮对话 + 当前消息
    // 注意：sendMessage 乐观上屏时已把当前消息推入 history，
    // 组装上下文先剔除它再取最近 10 轮，末尾显式追加一次，避免重复发送
    const history = this.state.histories[gfId] || [];
    const messages = [{ role: 'system', content: systemPrompt }];
    const recent = history.slice(0, -1).slice(-10);
    for (const m of recent) {
      if (m.role === 'player') messages.push({ role: 'user', content: m.text });
      else if (m.role === 'gf') messages.push({ role: 'assistant', content: m.text });
    }
    // 输出检查指令：紧贴当前消息放置（高注意力位），保证【喜好】标记协议被遵守
    messages.push({
      role: 'system',
      content: '【输出格式指令，必须遵守】检查上一条用户消息：如果你在回复中提到了自己的新喜好（喜欢的花、食物、音乐、电影、小习惯等），在回复末尾单独一行输出：【喜好：以「她」开头的简短概括】。没有提到新的喜好就完全不输出这一行，不要输出任何其他标记。',
    });
    messages.push({ role: 'user', content: userMessage });

    const endpoint = backend ? backend + '/v1/chat/completions' : cfg.endpoint;
    const body = {
      model: backend ? 'ebbingflow' : cfg.model,
      messages: messages,
      stream: true,
    };
    if (backend) {
      body.user = 'moonveil_' + gfId;   // EbbingFlow 按 user 隔离会话与记忆
    } else {
      body.reasoning_effort = cfg.reasoning_effort;
      body.temperature = cfg.temperature;
      body.max_tokens = cfg.max_tokens;
    }

    const controller = new AbortController();
    this.state.activeController = controller;   // 暴露给打断逻辑
    // 记忆后端内部含检索+生成，超时放宽到 90s
    const timeout = setTimeout(() => controller.abort(), backend ? 90000 : cfg.timeout_ms);
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
        throw err;
      }
      // SSE 流解析（delta.content 增量；思考模式的 reasoning_content 忽略）
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
            if (delta) {
              full += delta;
              if (onDelta) onDelta(delta);
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
    const backend = localStorage.getItem('ebbingflow_endpoint');
    if (!key && !backend) this.openApiModal();
    this.updateApiStatus();
  },
  openApiModal() {
    const saved = localStorage.getItem('deepseek_api_key');
    if (saved) this.el.apiKeyInput.value = saved;
    const backend = localStorage.getItem('ebbingflow_endpoint');
    if (backend) this.el.memoryBackendInput.value = backend;
    this.el.apiModal.classList.remove('hidden');
    this.el.apiKeyInput.focus();
  },
  closeApiModal() {
    this.el.apiModal.classList.add('hidden');
  },
  handleApiKeySave() {
    const key = this.el.apiKeyInput.value.trim();
    const backend = this.el.memoryBackendInput.value.trim().replace(/\/+$/, '');
    if (!key && !backend) { this.toast('Key 不能为空'); return; }
    if (key) localStorage.setItem('deepseek_api_key', key);
    // 记忆后端（可选）：EbbingFlow 地址；留空则恢复内置记忆（localStorage 提取）
    if (backend !== localStorage.getItem('ebbingflow_endpoint')) {
      if (backend) localStorage.setItem('ebbingflow_endpoint', backend);
      else localStorage.removeItem('ebbingflow_endpoint');
    }
    this.closeApiModal();
    this.updateApiStatus();
    this.toast(backend ? 'API Key 已保存（记忆后端：' + backend + '）' : 'API Key 已保存');
  },
  updateApiStatus() {
    const hasKey = !!localStorage.getItem('deepseek_api_key');
    const hasBackend = !!localStorage.getItem('ebbingflow_endpoint');
    const t = this.el.apiStatusText;
    if (t) t.textContent = hasKey ? 'API Key 已配置 ✓' : (hasBackend ? '记忆后端已配置 ✓' : 'API Key 未配置');
    const row = document.getElementById('api-status-row');
    if (row) row.style.color = (hasKey || hasBackend) ? 'var(--ok-color)' : '';
  },

  // ═══ 输入框自动伸缩 + IME 处理 ═══
  autoResizeInput() {
    const ta = this.el.playerInput;
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight, 120) + 'px';
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
    };
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
    };
    if (window.visualViewport) {
      window.visualViewport.addEventListener('resize', apply);
      window.visualViewport.addEventListener('scroll', apply);
    }
  },

  // ═══ 清空当前对话 ═══
  clearCurrentHistory() {
    const gfId = this.state.currentGf;
    const name = GIRLFRIENDS[gfId].name;
    if (!confirm('确定清空与「' + name + '」的聊天记录吗？')) return;
    this.state.histories[gfId] = [];
    this.saveHistory(gfId);
    this.renderHistory();
    this.toast('已清空聊天记录');
  },

  // ═══ 个人主页 ═══
  openProfile() {
    const gf = GIRLFRIENDS[this.state.currentGf];
    if (!gf || !gf.profile) return;
    const p = gf.profile;
    this.el.profileAvatar.src = gf.avatar;
    this.el.profileName.textContent = gf.name;
    this.el.profileTag.textContent = gf.tag;
    this.el.profileSignature.textContent = p.signature || '';

    // 基本信息网格
    const basic = (p.basic || []).map(b => `
      <div class="profile-basic-item">
        <div class="pb-label">${b.label}</div>
        <div class="pb-value">${b.value}</div>
      </div>`).join('');
    // 关于她
    const bio = p.bio ? `
      <div class="profile-card">
        <div class="profile-card-title">关于她</div>
        <div class="profile-bio">${p.bio}</div>
      </div>` : '';
    // 回忆卡 + 喜好卡：来自自动提取（LLM 低门槛喜好标记 + 低频严格回忆盘点）
    const favs = this.state.favs[this.state.currentGf] || [];
    const mems = this.state.memories[this.state.currentGf] || [];
    const memCard = mems.length ? `
      <div class="profile-card">
        <div class="profile-card-title">我们的回忆</div>
        <div class="profile-memory-list">
          ${mems.slice().reverse().map(m => `
          <div class="profile-memory-item">
            <span class="pm-dot"></span>
            <span class="pm-text">${this.esc(m.text)}</span>
            <span class="pm-date">${this.fmtDate(m.ts)}</span>
          </div>`).join('')}
        </div>
      </div>` : `
      <div class="profile-card">
        <div class="profile-card-title">我们的回忆</div>
        <div class="profile-placeholder">还没有值得记住的回忆，一起创造吧…</div>
      </div>`;
    const favCard = favs.length ? `
      <div class="profile-card">
        <div class="profile-card-title">她的喜好</div>
        <div class="profile-fav-chips">
          ${favs.slice().reverse().map(f => `<span class="pf-chip">${this.esc(f.text)}</span>`).join('')}
        </div>
      </div>` : `
      <div class="profile-card">
        <div class="profile-card-title">她的喜好</div>
        <div class="profile-placeholder">还没发现你的小癖好，聊着聊着就有了…</div>
      </div>`;

    this.el.profileBody.innerHTML = `
      <div class="profile-card"><div class="profile-basic-grid">${basic}</div></div>
      ${bio}
      ${memCard}
      ${favCard}`;
    this.el.profilePanel.classList.remove('hidden');
    this.el.profileOverlay.classList.remove('hidden');
  },
  closeProfile() {
    this.el.profilePanel.classList.add('hidden');
    this.el.profileOverlay.classList.add('hidden');
  },

  // ═══ Toast ═══
  toast(msg) {
    const t = this.el.toast;
    t.textContent = msg;
    t.classList.remove('hidden');
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => t.classList.add('hidden'), 2200);
  },

  // ═══ 菜单面板 ═══
  toggleMenu(show) {
    this.el.menuPanel.classList.toggle('hidden', !show);
    this.el.menuOverlay.classList.toggle('hidden', !show);
  },

  // ═══ 事件绑定 ═══
  bindEvents() {
    const self = this;

    // 发送
    this.el.sendBtn.addEventListener('click', () => this.sendMessage());
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

    // 角色切换（侧栏 + 底部导航）
    document.addEventListener('click', (e) => {
      const card = e.target.closest('.gf-card');
      if (card) { this.switchGf(card.dataset.gf); return; }
      const nav = e.target.closest('.bottom-nav-item');
      if (nav) { this.switchGf(nav.dataset.gf); return; }
    });

    // API Key
    this.el.apiBtn.addEventListener('click', () => this.openApiModal());
    this.el.apiSaveBtn.addEventListener('click', () => this.handleApiKeySave());
    this.el.apiSkipBtn.addEventListener('click', () => this.closeApiModal());
    this.el.apiKeyInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') this.handleApiKeySave();
    });

    // 主题
    this.el.themeToggle.addEventListener('click', () => this.toggleTheme());

    // 菜单
    this.el.menuBtn.addEventListener('click', () => this.toggleMenu(true));
    this.el.menuOverlay.addEventListener('click', () => this.toggleMenu(false));
    this.el.menuTheme.addEventListener('click', () => { this.toggleTheme(); this.toggleMenu(false); });
    this.el.menuUpdate.addEventListener('click', () => { this.toggleMenu(false); this.checkUpdate(); });
    this.el.menuBackup.addEventListener('click', () => { this.toggleMenu(false); this.openBackup(); });
    this.el.menuApi.addEventListener('click', () => { this.toggleMenu(false); this.openApiModal(); });
    this.el.menuClear.addEventListener('click', () => { this.toggleMenu(false); this.clearCurrentHistory(); });

    // 存档管理
    this.el.backupExportBtn.addEventListener('click', () => this.exportBackup());
    this.el.backupCopyBtn.addEventListener('click', () => this.copyBackup());
    this.el.backupImportBtn.addEventListener('click', () => this.el.backupFileInput.click());
    this.el.backupFileInput.addEventListener('change', (e) => {
      const f = e.target.files && e.target.files[0];
      if (f) this.importBackup(f);
      e.target.value = '';   // 允许重复选择同一文件
    });
    this.el.backupOverlay.addEventListener('click', () => this.closeBackup());

    // 检查更新弹窗
    this.el.updateCopyBtn.addEventListener('click', () => this.copyUpdateUrl());
    this.el.updateCancelBtn.addEventListener('click', () => this.closeUpdate());
    this.el.updateOverlay.addEventListener('click', () => this.closeUpdate());
    this.el.updateDownloadBtn.addEventListener('click', () => {
      const url = this.el.updateDownloadBtn.dataset.url;
      if (url) {
        // Capacitor 内用 _system 唤起系统浏览器；纯 Web 端回退 _blank
        window.open(url, typeof window.Capacitor !== 'undefined' ? '_system' : '_blank');
      }
      this.closeUpdate();
    });

    // 个人主页
    this.el.gfInfo.addEventListener('click', () => this.openProfile());
    this.el.profileClose.addEventListener('click', () => this.closeProfile());
    this.el.profileOverlay.addEventListener('click', () => this.closeProfile());
  },
};

// 启动
document.addEventListener('DOMContentLoaded', () => {
  App.init();
});
