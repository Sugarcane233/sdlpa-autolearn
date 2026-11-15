// 考试页悬浮助手：往考试页面注入一个「解题」面板，点一下就把当前题目交给模型，
// 答案直接显示出来并且自动点选。
//
// 为什么用轮询而不是 exposeBinding：页面已经加载好了，
// playwright 的 exposeBinding 要求刷新页面才生效，考试中不能刷新。
// 所以走「页面写 window.__solveReq，Node 侧每 400ms 看一眼」的路子，延迟够用。
const { chromium } = require('playwright-core');
const fs = require('fs');
const path = require('path');

const CDP = `http://127.0.0.1:${process.env.SDLPA_PORT || 9222}`;
// WorkBuddy 凭据目录，用 WB_VAULT 指定；不设则视为未配置（解题功能不可用）
const VAULT_DIR = process.env.WB_VAULT || '';
const MODEL = process.env.WB_MODEL || 'deepseek-v4.1-flash';
const POLL_MS = 400;
const { contextFor } = require('./search');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------- 模型调用 ----------------
// 直连 codebuddy，规矩见记忆 45981ed7：
// 只认流式；身份头要齐；答案在 delta.content，思维链在 delta.reasoning_content。
function pickVault() {
  const files = fs.readdirSync(VAULT_DIR).filter((f) => f.endsWith('.json'));
  let best = null;
  for (const f of files) {
    try {
      const v = JSON.parse(fs.readFileSync(path.join(VAULT_DIR, f), 'utf8'));
      const exp = v.auth && v.auth.expiresAt ? v.auth.expiresAt : 0;
      if (!best || exp > best.exp) best = { ...v, exp };
    } catch (e) {}
  }
  return best;
}

async function askModel(messages) {
  const v = pickVault();
  if (!v) throw new Error('vault 里没有可用凭据');
  const uid = v.account.uid;
  const domain = v.auth.domain;
  const tok = v.auth.accessToken;
  const uuid = () => require('crypto').randomUUID();

  const r = await fetch(`https://${domain}/v2/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: 'Bearer ' + tok,
      'x-user-id': uid,
      'x-domain': domain,
      'x-product': 'WorkBuddy',
      'x-ide-name': 'WorkBuddy',
      'x-ide-type': 'WorkBuddy',
      'x-ide-version': '2.63.2',
      'x-codebuddy-request': '1',
      'accept-language': 'zh-CN',
      'x-conversation-id': uuid(),
      'x-conversation-request-id': uuid(),
      'x-conversation-message-id': uuid(),
      'user-agent': 'CLI/2.63.2 CodeBuddy/2.63.2',
    },
    body: JSON.stringify({ model: MODEL, stream: true, messages }),
  });
  if (!r.ok) throw new Error('模型 HTTP ' + r.status + ' ' + (await r.text()).slice(0, 120));

  const raw = await r.text();
  let content = '';
  for (const line of raw.split('\n')) {
    const s = line.trim();
    if (!s.startsWith('data:')) continue;
    const payload = s.slice(5).trim();
    if (!payload || payload === '[DONE]') continue;
    try {
      const j = JSON.parse(payload);
      const d = j.choices && j.choices[0] && j.choices[0].delta;
      if (d && d.content) content += d.content;
    } catch (e) {}
  }
  return content;
}

// ---------------- 解题 ----------------
const SYS = `你是执业药师继续教育考试的答题助手，专精中国药事法规与药品经营管理规范。

答题方法（务必按此执行）：
1. 先判断题型。题干含「正确的有」「包括」「包含」「属于」等多选特征的是多选题；说「错误/不正确/不符合」是要挑出错误项。
2. 逐项判断每个选项：这条表述依据的是哪部法规哪一条（《药品管理法》《药品经营和使用质量监督管理办法》《药品经营质量管理规范》《麻醉药品和精神药品管理条例》等），该说法与规定是否一致。
3. 不确定具体数字（保存年限、容积、面积、罚则金额）时，宁可依据「监管从严」的常识判断该表述是否被夸大或缩小，不要凭空编造条款号。
4. 判断题（A正确/B错误）：只要题面有任何一个事实点与法规不符，就答 B。

只输出一个 JSON 对象，不要解释段落、不要 markdown 代码块：
{"answer":["A"],"reason":"一句话依据"}
多选题写多个字母如 ["A","C"]，判断题只能 A 或 B，单选题只能一个字母。`

// 多轮采样投票。模型单次作答不稳定 —— 实测同一道判断题（冷库容积 500 立方）
// 两次答出相反结果，说明它在猜。并发问 N 次取多数票，能显著压掉这种抖动。
const VOTES = Number(process.env.WB_VOTES || 3);

async function solveOnce(text, refs) {
  const userMsg = refs
    ? `题目：\n${text}\n\n以下是联网检索到的相关资料（可能不完全对应本题，仅作参考，若与本题目无关请忽略）：\n${refs}`
    : text;
  const out = await askModel([
    { role: 'system', content: SYS },
    { role: 'user', content: userMsg },
  ]);
  let s2 = String(out).trim();
  s2 = s2.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  const m2 = s2.match(/\{[\s\S]*\}/);
  if (m2) s2 = m2[0];
  try {
    const j = JSON.parse(s2);
    const raw = Array.isArray(j.answer) ? j.answer : [j.answer];
    const letters = raw
      .flatMap((x) => String(x == null ? '' : x).split(/[,，、;；\s\/|]+/))
      .flatMap((x) => {
        const t = String(x).trim().toUpperCase();
        if (/^[A-Z]{2,}$/.test(t)) return t.split('');
        return [t];
      })
      .map((x) => String(x).replace(/[^A-Z]/g, ''))
      .filter((x) => /^[A-Z]$/.test(x));
    return { letters: [...new Set(letters)].sort(), reason: String(j.reason || '').slice(0, 120) };
  } catch (e) {
    return { letters: [], reason: '解析失败' };
  }
}

async function solve(text) {
  // 联网检索已关闭（用户决定）：Bing 对中文长句的检索质量太差，整句会被
  // 当成「查词条」返回词典释义，反而污染上下文。保留 search.js 备查，
  // 需要时把 WB_SEARCH 设成 1 就恢复。
  let refs = '';
  if (process.env.WB_SEARCH === '1') {
    try {
      refs = await contextFor(text, { n: 4, timeout: 6000 });
      if (refs) console.log('[exam-helper] 检索到参考资料', refs.length, '字');
    } catch (e) { refs = ''; }
  }

  const runs = await Promise.allSettled(Array.from({ length: VOTES }, () => solveOnce(text, refs)));
  const ok = runs.filter((r) => r.status === 'fulfilled' && r.value.letters.length).map((r) => r.value);
  if (!ok.length) return { letters: [], reason: '模型没给出答案', raw: '' };

  // 用答案组合（"A,B" 这种字符串）投票，票数最多的获胜
  const tally = new Map();
  for (const r of ok) {
    const k = r.letters.join(',');
    const cur = tally.get(k) || { n: 0, reason: r.reason };
    cur.n++;
    tally.set(k, cur);
  }
  const sorted = [...tally.entries()].sort((a, b) => b[1].n - a[1].n);
  const [best, info] = sorted[0];
  const allSame = sorted.length === 1;
  const note = allSame
    ? info.reason
    : `${info.reason}（${info.n}/${ok.length} 票一致）`;
  return {
    letters: best.split(','),
    reason: note + (refs ? ' [已联网核对]' : ''),
    raw: '',
    votes: sorted.map(([k, v]) => k + '×' + v.n),
  };
}

// ---------------- 注入页面的 UI ----------------
// UI 单独放在 exam-ui.js：它内部用反引号写 CSS，
// 内联到这个文件的模板字符串里会把模板提前截断（踩过一次）。
const UI = fs.readFileSync(path.join(__dirname, 'exam-ui.js'), 'utf8');

// 逐个真实点击选项。letters = ['A','B','C','D']
//
// 为什么不能 page.evaluate 里点：Element Plus 的 el-checkbox 用的是 Vue 的
// 受控状态，页面内一次性连发合成 click 会被合并，最终只剩最后一个生效。
// Playwright 的 locator.click() 会产生真实鼠标事件序列，逐个点才都对。
async function doApply(page, letters) {
  const want = new Set(letters.map((x) => String(x).toUpperCase()));
  const boxes = page.locator('.el-radio, .el-checkbox');
  const n = await boxes.count();
  if (!n) return { ok: false, msg: '没找到选项元素', picked: [] };

  const plan = [];
  for (let i = 0; i < n; i++) {
    const bx = boxes.nth(i);
    const text = (await bx.innerText().catch(() => '')) || '';
    const L = (text.trim().match(/^([A-Z])/) || [])[1];
    if (!L) continue;
    const on = await bx.evaluate((e) => e.classList.contains('is-checked')).catch(() => false);
    plan.push({ i, L, on, want: want.has(L), text });
  }

  // 先取消不该选的，再勾该选的
  const picked = [];
  for (const p of plan) {
    if (p.want === p.on) continue;
    await boxes.nth(p.i).click({ timeout: 6000 }).catch(() => {});
    picked.push((p.want ? '选' : '取消') + p.L);
    await page.waitForTimeout(180);
  }

  // 回读核对
  const now = await page.evaluate(() =>
    [...document.querySelectorAll('.el-radio, .el-checkbox')]
      .filter((e) => e.classList.contains('is-checked'))
      .map((e) => ((e.innerText || '').trim().match(/^([A-Z])/) || [])[1])
      .filter(Boolean)
  ).catch(() => []);
  const miss = [...want].filter((L) => !now.includes(L));
  const extra = now.filter((L) => !want.has(L));
  if (miss.length || extra.length) {
    return {
      ok: false,
      picked,
      now,
      msg: (miss.length ? '没选上：' + miss.join(',') : '') + (extra.length ? ' 多选了：' + extra.join(',') : ''),
    };
  }
  return { ok: true, picked, now };
}

// ---------------- 主循环 ----------------
(async () => {
  console.log('[exam-helper] 启动，等 Chrome…');
  let browser = null;
  for (let i = 0; i < 60; i++) {
    try { browser = await chromium.connectOverCDP(CDP); break; } catch (e) { await sleep(2000); }
  }
  if (!browser) { console.error('[exam-helper] 连不上 CDP'); process.exit(1); }
  console.log('[exam-helper] 已连上 Chrome');

  let injectedFor = '';
  for (;;) {
    try {
      const ctx = browser.contexts()[0];
      const page = ctx.pages().find((p) => /sdlpa\.org\.cn\/(exam|learn|train)/.test(p.url()));
      if (page) {
        // 换页/跳转后要重新注入
        const key = page.url();
        if (key !== injectedFor) {
          await page.evaluate(UI).catch(() => {});
          injectedFor = key;
          console.log('[exam-helper] 已注入 UI →', key.slice(0, 80));
        }

        // ---- 处理「点选项」请求 ----
        // 必须在 Node 侧用 Playwright 的真实鼠标点击。页面里的合成 click
        // 对 Element Plus 的多选无效（四个都点也只勾上一个），这是实测结论。
        const areq = await page.evaluate(() => window.__applyReq || null).catch(() => null);
        if (areq && areq.id && areq.id !== globalThis.__lastApplyId) {
          globalThis.__lastApplyId = areq.id;
          let out;
          try {
            out = await doApply(page, areq.letters || []);
            console.log('[exam-helper] 已填选：', (out.picked || []).join(' ') || '(无需改动)', out.ok ? '' : ('| ' + out.msg));
          } catch (e) {
            out = { ok: false, msg: '点击出错：' + e.message, picked: [] };
            console.error('[exam-helper] 填选失败', e.message);
          }
          await page.evaluate((r) => { window.__applyResult = r; }, out).catch(() => {});
        }

        const req = await page.evaluate(() => window.__solveReq || null).catch(() => null);
        if (req && req.id && req.id !== globalThis.__lastReqId) {
          globalThis.__lastReqId = req.id;
          console.log('[exam-helper] 收到题目：', String(req.text).slice(0, 60).replace(/\n/g, ' '));
          try {
            const r = await solve(req.text);
            console.log('[exam-helper] 答案：', r.letters.join(',') || '(空)', '|', r.reason);
            await page.evaluate((res) => { window.__solveResult = res; window.__solveReq = null; }, r).catch(() => {});
          } catch (e) {
            console.error('[exam-helper] 解题失败', e.message);
            await page.evaluate((msg) => {
              window.__solveResult = { letters: [], reason: '调用失败', raw: msg };
              window.__solveReq = null;
            }, e.message).catch(() => {});
          }
        }
      }
    } catch (e) {
      // 页面跳转会短暂 evaluate 失败，忽略
    }
    await sleep(POLL_MS);
  }
})();
