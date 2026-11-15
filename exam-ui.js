// 注入到考试页面的浮窗 + 解题按钮。
// 单独成一个文件，是因为它内部要用反引号写 CSS，
// 嵌在 exam-helper.js 的 String.raw 模板里会提前把模板截断（踩过一次）。
(() => {
  // 版本号必须检查。早先只判断「有没有注入过」，结果改了代码重启助手后，
  // 页面里跑的还是旧版（新的 evaluate 被这里直接 return 掉），
  // 表现为「修了但没效果」。版本不一致就清掉旧的重新装。
  const VER = 2;
  if (window.__sdlpaHelperVer === VER) return 'already';
  const old = document.getElementById('sdlpa-helper');
  if (old && old.parentNode) old.parentNode.removeChild(old);
  window.__sdlpaHelper = true;
  window.__sdlpaHelperVer = VER;

  const css = document.createElement('style');
  css.textContent = [
    '#sdlpa-helper{position:fixed;right:18px;bottom:18px;z-index:2147483647;',
    '  font:13px/1.5 system-ui,-apple-system,"Microsoft YaHei",sans-serif}',
    '#sdlpa-btn{display:flex;align-items:center;gap:7px;padding:11px 18px;border-radius:24px;',
    '  background:linear-gradient(135deg,#2f81f7,#58a6ff);color:#fff;border:none;cursor:pointer;',
    '  box-shadow:0 6px 22px rgba(47,129,247,.45);font-size:14px;font-weight:600}',
    '#sdlpa-btn:disabled{opacity:.6;cursor:default}',
    '#sdlpa-panel{position:absolute;right:0;bottom:56px;width:330px;max-height:60vh;overflow:auto;',
    '  background:#151b23;border:1px solid #2a3441;border-radius:12px;padding:14px;',
    '  color:#c9d1d9;box-shadow:0 12px 40px rgba(0,0,0,.55);display:none}',
    '#sdlpa-panel.on{display:block}',
    '#sdlpa-panel h4{margin:0 0 10px;font-size:12px;color:#7d8590;letter-spacing:.6px;font-weight:600}',
    '.sh-ans{font-size:26px;font-weight:700;color:#3fb950;letter-spacing:2px;margin:2px 0 6px}',
    '.sh-reason{font-size:12.5px;color:#8b949e;line-height:1.65;word-break:break-word}',
    '.sh-q{font-size:12px;color:#6e7681;margin-top:10px;padding-top:9px;border-top:1px solid #21262d;',
    '  white-space:pre-wrap;max-height:130px;overflow:auto}',
    '.sh-err{color:#ffa198;font-size:12.5px}',
    '.sh-tag{display:inline-block;font-size:11px;padding:1px 7px;border-radius:10px;',
    '  background:#1f6feb22;border:1px solid #1f6feb55;color:#58a6ff;margin-left:6px}',
  ].join('\n');
  document.head.appendChild(css);

  const wrap = document.createElement('div');
  wrap.id = 'sdlpa-helper';
  wrap.innerHTML = '<div id="sdlpa-panel"><h4>解题结果</h4><div id="sh-body">'
    + '<div class="sh-reason">点下面的按钮，读取当前题目</div></div></div>'
    + '<button id="sdlpa-btn">🎯 解题并自动填</button>';
  document.body.appendChild(wrap);

  const panel = document.getElementById('sdlpa-panel');
  const bodyEl = document.getElementById('sh-body');
  const btn = document.getElementById('sdlpa-btn');

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }

  // 抓当前题：题干 + 选项文本。题型从「(单选题)」这类标记里读。
  function readQuestion() {
    const t = document.body.innerText || '';
    const m = t.match(/(\d+)、\s*\n*\s*\((单选题|多选题|判断题)\)\s*\n*([\s\S]{0,600}?)(?:地址:|上一题|下一题|交卷|$)/);
    if (!m) return null;
    const typeMap = { 单选题: 'single', 多选题: 'multi', 判断题: 'judge' };
    return { no: m[1], type: typeMap[m[2]] || 'single', typeCN: m[2], text: m[3].trim() };
  }

  // 按字母点选。单选只能留一个；多选要保证其它已选中的被取消。
  //
  // 这里有两个坑，都踩过：
  //  1. 必须点 .el-checkbox / .el-radio 容器，点里面的 input 对多选无效。
  //  2. **不能同步连点**。同一 tick 里连发几次 click，Element Plus 的
  //     Vue 响应式状态会互相覆盖，最后只剩最后一个生效（就是「答案是
  //     A,B,C,D 却只选中一个」）。每次点击之间必须让出事件循环。
  function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

  async function applyAnswer(letters) {
    const boxes = [...document.querySelectorAll('.el-radio, .el-checkbox')];
    if (!boxes.length) return { ok: false, msg: '没找到选项元素' };

    // 先算出每个选项该处于什么状态
    const plan = [];
    for (const bx of boxes) {
      const label = (bx.innerText || '').trim();
      const L = (label.match(/^([A-Z])/) || [])[1];
      if (!L) continue;
      plan.push({ bx, L, want: letters.includes(L), on: bx.classList.contains('is-checked') });
    }

    // 先取消多余的，再逐个勾选需要的那几个
    const picked = [];
    for (const p of plan) {
      if (p.want === p.on) continue;
      await sleep(120);
      const target = p.bx.querySelector('.el-checkbox__inner, .el-radio__inner') || p.bx;
      target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
      picked.push((p.want ? '选' : '取消') + p.L);
      await sleep(120);
    }

    // 回读确认，对不上直接报出来，别让用户以为填好了
    const now = [...document.querySelectorAll('.el-radio, .el-checkbox')]
      .filter((e) => e.classList.contains('is-checked'))
      .map((e) => ((e.innerText || '').trim().match(/^([A-Z])/) || [])[1])
      .filter(Boolean);
    const miss = letters.filter((L) => !now.includes(L));
    const extra = now.filter((L) => !letters.includes(L));
    if (miss.length || extra.length) {
      return {
        ok: false,
        msg: (miss.length ? '没选上：' + miss.join(',') : '') + (extra.length ? ' 多选了：' + extra.join(',') : ''),
        picked,
        now,
      };
    }
    return { ok: true, picked, now };
  }

  btn.onclick = async () => {
    const q = readQuestion();
    panel.classList.add('on');
    if (!q) {
      bodyEl.innerHTML = '<div class="sh-err">没读到题目。确认当前在考试答题页。</div>';
      return;
    }

    btn.disabled = true;
    bodyEl.innerHTML = '<div class="sh-reason">思考中…</div>';
    window.__solveResult = null;
    window.__solveReq = { id: Date.now(), type: q.type, text: q.text };

    const t0 = Date.now();
    while (Date.now() - t0 < 60000) {
      await new Promise((r) => setTimeout(r, 250));
      if (window.__solveResult) break;
    }
    btn.disabled = false;

    const res = window.__solveResult;
    if (!res) {
      bodyEl.innerHTML = '<div class="sh-err">超时，没拿到答案（60 秒）。看 exam-helper 的日志。</div>';
      return;
    }
    if (!res.letters || !res.letters.length) {
      bodyEl.innerHTML = '<div class="sh-err">模型没给出可用答案</div><div class="sh-q">'
        + esc(res.raw || '') + '</div>';
      return;
    }

    // 关键：不在页面里点。
    // Element Plus 的多选，页面内合成 click 只会生效最后一个（试过点 input、
    // 派发 MouseEvent、加间隔，全都不行）。只有 Playwright 的真实鼠标事件
    // 才驱动得动它的内部状态。所以这里把要选的字母交给 Node 侧，
    // 由 exam-helper.js 用 locator.click() 逐个真点，再回写结果。
    window.__applyResult = null;
    window.__applyReq = { id: Date.now(), letters: res.letters };
    const t1 = Date.now();
    while (Date.now() - t1 < 20000) {
      await new Promise((r) => setTimeout(r, 200));
      if (window.__applyResult) break;
    }
    const applied = window.__applyResult
      || { ok: false, msg: '页面点击超时（Node 侧没回应）' };
    window.__applyReq = null;
    bodyEl.innerHTML =
      '<div class="sh-ans">' + esc(res.letters.join(', ')) + '<span class="sh-tag">' + esc(q.typeCN) + '</span></div>'
      + '<div class="sh-reason">' + esc(res.reason || '') + '</div>'
      + '<div class="sh-reason" style="margin-top:6px;color:' + (applied.ok ? '#3fb950' : '#ffa198') + '">'
      + (applied.ok ? ('已填入：' + esc((applied.picked || []).join(' ') || '（本来就是对的）')) : ('填入失败：' + esc(applied.msg || '')))
      + '</div>'
      + '<div class="sh-q">' + esc(q.text) + '</div>';
  };

  return 'ok';
})()
