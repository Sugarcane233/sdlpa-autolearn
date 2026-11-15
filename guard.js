// 注入到页面上下文（document start）的抗干扰层。
// 原则：不改任何上报数值，只消除"人不在场"带来的中断。
(() => {
  if (window.__SDLPA_GUARD__) return;
  window.__SDLPA_GUARD__ = true;

  const rec = (m) => {
    try {
      window.__sdlpaLog = window.__sdlpaLog || [];
      window.__sdlpaLog.push(new Date().toTimeString().slice(0, 8) + ' ' + m);
      if (window.__sdlpaLog.length > 500) window.__sdlpaLog.splice(0, 250);
    } catch (e) {}
  };

  // ---------- 1. 伪造页面可见性 ----------
  // 窗口最小化 / 被遮挡时 Chrome 会把 visibilityState 置为 hidden，
  // 站点和播放器都会据此暂停。这里统一钉死成 visible。
  try {
    Object.defineProperty(document, 'visibilityState', { get: () => 'visible', configurable: true });
    Object.defineProperty(document, 'hidden', { get: () => false, configurable: true });
    Object.defineProperty(document, 'webkitVisibilityState', { get: () => 'visible', configurable: true });
    Object.defineProperty(document, 'webkitHidden', { get: () => false, configurable: true });
  } catch (e) { rec('visibility patch failed: ' + e.message); }

  // ---------- 2. 屏蔽 blur / visibilitychange 监听 ----------
  const rawAdd = window.addEventListener.bind(window);
  const rawRemove = window.removeEventListener.bind(window);
  const BLOCK = new Set(['blur', 'visibilitychange', 'webkitvisibilitychange', 'pagehide', 'freeze']);
  window.addEventListener = function (type, fn, opts) {
    if (BLOCK.has(String(type).toLowerCase())) { rec('blocked listener: ' + type); return; }
    return rawAdd(type, fn, opts);
  };
  window.removeEventListener = function (type, fn, opts) {
    if (BLOCK.has(String(type).toLowerCase())) return;
    return rawRemove(type, fn, opts);
  };
  // document 上的同名监听一并拦（播放器插件常挂在 document 上）
  const docAdd = document.addEventListener.bind(document);
  const docRemove = document.removeEventListener.bind(document);
  document.addEventListener = function (type, fn, opts) {
    if (BLOCK.has(String(type).toLowerCase())) { rec('blocked doc listener: ' + type); return; }
    return docAdd(type, fn, opts);
  };
  document.removeEventListener = function (type, fn, opts) {
    if (BLOCK.has(String(type).toLowerCase())) return;
    return docRemove(type, fn, opts);
  };

  // 焦点类 API 一律返回"在前台"
  try { document.hasFocus = () => true; } catch (e) {}
  try { Object.defineProperty(document, 'onvisibilitychange', { set() {}, get() { return null; }, configurable: true }); } catch (e) {}

  // 补发一次 visible 事件，把已经处于暂停状态的播放器唤醒
  window.__sdlpaNudge = () => {
    try { document.dispatchEvent(new Event('visibilitychange')); } catch (e) {}
    try { rawAdd('focus', () => {}); } catch (e) {}
  };

  // ---------- 3. 答题数据表（由 runner 注入） ----------
  window.__cwAnswers = window.__cwAnswers || {};

  function parseItems(content) {
    const out = [];
    const re = /<item id="([^"]+)">([^<]+)<\/item>/g;
    let m;
    while ((m = re.exec(String(content || ''))) !== null) out.push({ id: m[1], content: m[2].trim() });
    return out;
  }

  function currentCoursewareID() {
    const v = document.querySelector('video');
    const src = (v && (v.currentSrc || v.src)) || '';
    const m = src.match(/\/kj(\d+)\//);
    return m ? Number(m[1]) : null;
  }

  // ---------- 4. 自动点掉 el-message-box ----------
  const clickedBoxes = new WeakSet();
  function autoConfirm() {
    document.querySelectorAll('.el-message-box').forEach((box) => {
      if (clickedBoxes.has(box)) return;
      const title = (box.querySelector('.el-message-box__title')?.innerText || '').trim();
      const msg = (box.querySelector('.el-message-box__message')?.innerText || '').trim().slice(0, 70);
      const btn =
        box.querySelector('.el-message-box__btns .el-button--primary') ||
        [...box.querySelectorAll('.el-message-box__btns button')].pop();
      if (!btn) return;
      clickedBoxes.add(box);
      rec(`confirm: ${title} | ${msg}`);
      setTimeout(() => { try { btn.click(); } catch (e) {} }, 300);
    });
  }

  // ---------- 5. 自动答题 ----------
  const handledDialogs = new WeakSet();
  function answerDialogs() {
    const cwID = currentCoursewareID();
    const qs = (cwID && window.__cwAnswers[cwID]) || [];
    document.querySelectorAll('.el-dialog').forEach((dlg) => {
      if (handledDialogs.has(dlg)) return;
      const text = dlg.innerText || '';
      if (!/单选题|多选题|判断题/.test(text)) return;
      if (!(dlg.offsetParent !== null || dlg.getBoundingClientRect().height > 0)) return;

      const body = text.replace(/\s+/g, ' ');
      let hit = null;
      for (const q of qs) {
        const items = parseItems(q.questionContent);
        if (items.length && body.includes(items[0].content.slice(0, 12))) { hit = q; break; }
      }
      if (!hit) { rec('dialog unmatched, pick first option'); }

      handledDialogs.add(dlg);
      const optEls = [...dlg.querySelectorAll('.el-radio, .el-checkbox')];

      if (hit) {
        const items = hit.options && hit.options.length ? hit.options : parseItems(hit.questionContent);
        const wantIDs = String(hit.answer || '').toUpperCase().split(',').map((s) => s.trim()).filter(Boolean);
        const wants = items.filter((it) => wantIDs.includes(String(it.id).toUpperCase())).map((it) => it.content);
        rec(`answer: ${wants.join('/')} (type ${hit.questionType})`);
        for (const el of optEls) {
          const t = (el.innerText || '').trim();
          if (wants.some((w) => t.includes(w) || w.includes(t))) { try { el.click(); } catch (e) {} }
        }
      } else if (optEls.length) {
        try { optEls[0].click(); } catch (e) {}
      }

      setTimeout(() => {
        const submit = [...dlg.querySelectorAll('button')].find((b) => /提交|确定|确认/.test(b.innerText || ''));
        if (submit) { rec('submit answer'); try { submit.click(); } catch (e) {} }
        else handledDialogs.delete(dlg);
      }, 600);
    });
  }

  // ---------- 5.5 媒体错误侦测 ----------
  // HLS 偶发断流会让 <video> 进入 error 状态，并永久停在 paused。
  // 这里只记录，不自行 reload，交给 runner 决定。
  window.__SDLPA_MEDIA_ERR__ = null;
  const watchMedia = () => {
    const v = document.querySelector('video');
    if (!v || v.__sdlpaWatched) return;
    v.__sdlpaWatched = true;
    const mark = (why) => {
      const info = {
        code: v.error ? v.error.code : null,
        msg: v.error ? v.error.message : '',
        src: (v.currentSrc || '').slice(-70),
        at: new Date().toTimeString().slice(0, 8),
        why,
      };
      window.__SDLPA_MEDIA_ERR__ = info;
      rec(`media error ${why} code=${info.code}`);
    };
    v.addEventListener('error', () => mark('event'));
    v.addEventListener('stalled', () => { /* 缓冲停顿不算错误 */ });
  };

  // ---------- 6. 保活：卡住就 play ----------
  let lastCT = -1;
  let lastMove = Date.now();
  function keepAlive() {
    watchMedia();
    const v = document.querySelector('video');
    if (!v) return;
    // 看板点了「暂停」：不抢回播放，也不重播
    if (window.__SDLPA_PAUSED__) {
      if (!v.paused) { try { v.pause(); } catch (e) {} }
      return;
    }
    // 已经是媒体错误态，play() 必然失败，别刷屏
    if (v.error) {
      if (!window.__SDLPA_MEDIA_ERR__) {
        window.__SDLPA_MEDIA_ERR__ = { code: v.error.code, msg: v.error.message, src: (v.currentSrc || '').slice(-70), at: new Date().toTimeString().slice(0, 8), why: 'poll' };
        rec(`media error poll code=${v.error.code}`);
      }
      return;
    }
    // 有弹窗时不干预，交给 autoConfirm / answerDialogs
    const busy = document.querySelector('.el-message-box, .el-dialog');
    if (busy && busy.getBoundingClientRect().height > 0) { lastMove = Date.now(); return; }

    if (Math.abs(v.currentTime - lastCT) > 0.15) {
      lastCT = v.currentTime;
      lastMove = Date.now();
      return;
    }
    if (v.paused) {
      rec('resume (paused)');
      v.muted = v.muted; // noop
      try { v.play().catch(() => {}); } catch (e) {}
      lastMove = Date.now();
      return;
    }
    if (Date.now() - lastMove > 15000) {
      rec('stalled 15s, re-kick');
      try { v.currentTime = v.currentTime; } catch (e) {}
      try { v.play().catch(() => {}); } catch (e) {}
      lastMove = Date.now();
    }
    if (v.playbackRate > 1.001) {
      rec('rate forced back to 1');
      try { v.playbackRate = 1; } catch (e) {}
    }
  }

  setInterval(() => {
    try { autoConfirm(); } catch (e) {}
    try { answerDialogs(); } catch (e) {}
    try { keepAlive(); } catch (e) {}
  }, 700);

  rec('guard installed');
})();
