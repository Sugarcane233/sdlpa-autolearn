/**
 * 山东省药师协会继续教育 —— 学时自动推进器（服务端真相版）
 *
 * 核心设计：
 *  1. **以服务端进度为唯一真相**。每次启动先拉 /learning/getTraineeLearnStat，
 *     只有 learnDuration < totalDuration 的课件才会去播，杜绝重复刷已完成课件。
 *  2. 不伪造任何上报数据。学时来自平台自己的 1 秒墙钟计数器，
 *     本程序只负责让视频真的在播、弹窗自动处理、课件自动切换。
 *  3. 断点续跑：崩溃/重启后自动从服务端进度接着走。
 *
 * 用法：
 *   node runner.js            正常跑
 *   node runner.js --once     跑完一个课件就退出（调试）
 *   node runner.js --dry      只打印计划
 */
const { chromium } = require('playwright-core');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const DATA = path.join(ROOT, 'data');
const STATE_FILE = path.join(DATA, 'state.json');
const COURSES_FILE = path.join(DATA, 'courses.json');
const STAT_FILE = path.join(DATA, 'stat.json');
const LOG_FILE = path.join(DATA, 'run.log');
const LOCK_FILE = path.join(DATA, 'runner.lock');
// 看板点了「暂停」时，mirror-server 会建这个文件；runner 见它就原地等。
const PAUSE_FLAG = path.join(DATA, 'PAUSED');
const CDP = `http://127.0.0.1:${process.env.SDLPA_PORT || 9222}`;
// 学员号请用环境变量 SDLPA_TRAINEE 指定；这里留 0 表示未配置
const TRAINEE = Number(process.env.SDLPA_TRAINEE || 0);
const BASE = 'https://sdu.sdlpa.org.cn';

const ARGS = process.argv.slice(2);
const ONCE = ARGS.includes('--once');
const DRY = ARGS.includes('--dry');

const GUARD_SRC = fs.readFileSync(path.join(ROOT, 'guard.js'), 'utf8');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------- 日志 ----------------
function log(...a) {
  const line = `[${new Date().toLocaleString('zh-CN', { hour12: false })}] ${a.join(' ')}`;
  console.log(line);
  try {
    fs.mkdirSync(DATA, { recursive: true });
    if (fs.existsSync(LOG_FILE) && fs.statSync(LOG_FILE).size > 4 * 1024 * 1024) {
      fs.writeFileSync(LOG_FILE, fs.readFileSync(LOG_FILE, 'utf8').slice(-1.5 * 1024 * 1024));
    }
    fs.appendFileSync(LOG_FILE, line + '\n');
  } catch (e) {}
}

function fmt(s) {
  s = Math.max(0, Math.round(s || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const x = s % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(x).padStart(2, '0')}` : `${m}:${String(x).padStart(2, '0')}`;
}

// ---------------- 单实例锁 ----------------
function acquireLock() {
  try {
    if (fs.existsSync(LOCK_FILE)) {
      const pid = Number(fs.readFileSync(LOCK_FILE, 'utf8').trim());
      if (pid && pid !== process.pid) {
        try { process.kill(pid, 0); log(`已有实例在跑 (pid=${pid})`); process.exit(0); } catch (e) {}
      }
    }
  } catch (e) {}
  fs.mkdirSync(DATA, { recursive: true });
  fs.writeFileSync(LOCK_FILE, String(process.pid));
}
function releaseLock() {
  try {
    if (fs.existsSync(LOCK_FILE) && Number(fs.readFileSync(LOCK_FILE, 'utf8')) === process.pid) fs.unlinkSync(LOCK_FILE);
  } catch (e) {}
}
process.on('exit', releaseLock);
['SIGINT', 'SIGTERM'].forEach((s) => process.on(s, () => { releaseLock(); process.exit(0); }));

// ---------------- 浏览器 ----------------
async function connect(retries = 45) {
  for (let i = 0; i < retries; i++) {
    try { return await chromium.connectOverCDP(CDP); } catch (e) { await sleep(2000); }
  }
  throw new Error('CDP 连不上：Chrome 没启动');
}

async function ensurePage(browser) {
  const ctx = browser.contexts()[0];
  await ctx.addInitScript({ content: GUARD_SRC }).catch(() => {});
  let page = ctx.pages().find((p) => /sdlpa\.org\.cn\/learn/.test(p.url()));
  if (!page) page = ctx.pages().find((p) => /sdlpa\.org\.cn/.test(p.url()));
  if (!page) page = await ctx.newPage();
  page.setDefaultTimeout(45000);
  return page;
}

async function isLoggedOut(page) {
  const u = page.url();
  if (/user\.sdlpa\.org\.cn\/login/.test(u)) return true;
  const t = await page.evaluate(() => document.body.innerText.slice(0, 400)).catch(() => '');
  return /学员登录|请输入身份证号/.test(t || '');
}

// ---------------- 抓服务端真相 ----------------
// /train 页只发 getTraineeCourseListQuick（不带课件），
// 完整课件表 + 学时明细都要在 /learn 页里才会请求。
async function pullServerTruth(page, courseIDs) {
  let courses = null;
  let stat = null;

  const grabCourse = async (res) => {
    const u = res.url();
    if (u.includes('/training/getTraineeCourseList') && !courses) {
      try {
        const j = JSON.parse(await res.text());
        if (j?.data?.some((c) => (c.course?.coursewares || []).length > 0)) courses = j;
      } catch (e) {}
    }
  };
  const grabStat = async (res) => {
    if (res.url().includes('/learning/getTraineeLearnStat') && !stat) {
      try {
        const j = JSON.parse(await res.text());
        if (j?.data?.courseStats) stat = j;
      } catch (e) {}
    }
  };
  page.on('response', grabCourse);
  page.on('response', grabStat);

  const tries = courseIDs && courseIDs.length ? courseIDs : [674];
  for (const cid of tries) {
    if (courses && stat) break;
    await page.goto(`${BASE}/learn?traineeid=${TRAINEE}&courseid=${cid}`, { waitUntil: 'domcontentloaded' }).catch(() => {});
    for (let i = 0; i < 30 && !(courses && stat); i++) await sleep(800);
    if (!courses && !stat) {
      await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
      for (let i = 0; i < 30 && !(courses && stat); i++) await sleep(800);
    }
  }

  page.off('response', grabCourse);
  page.off('response', grabStat);

  if (courses) fs.writeFileSync(COURSES_FILE, JSON.stringify(courses, null, 2));
  if (stat) fs.writeFileSync(STAT_FILE, JSON.stringify(stat, null, 2));
  return { courses, stat };
}

// 把课程结构 + 服务端进度合成待办队列
function buildQueue(courses, stat) {
  const courseStats = (stat && stat.data && stat.data.courseStats) || {};
  const queue = [];
  for (const c of courses.data) {
    const cs = courseStats[String(c.courseID)] || courseStats[c.courseID] || {};
    const ws = cs.coursewareStats || {};
    const cws = (c.course.coursewares || []).slice().sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0));
    for (const w of cws) {
      if (!w.timeLen || w.timeLen <= 0) continue;
      const svr = ws[String(w.coursewareID)] || {};
      const learned = Number(svr.learnDuration || 0);
      const total = Number(svr.totalDuration || w.timeLen);
      const complete = total > 0 && learned >= total - 3;
      queue.push({
        courseID: c.courseID,
        courseName: c.course.courseName,
        courseType: c.course.courseType,
        needExam: c.needExam,
        creditHour: c.courseCreditHour,
        coursewareID: w.coursewareID,
        coursewareName: w.coursewareName,
        timeLen: w.timeLen,
        learned,
        complete,
        questions: w.questions || [],
      });
    }
  }
  return queue;
}

// ---------------- 页面动作 ----------------
async function readLive(page) {
  return page.evaluate(() => {
    const v = document.querySelector('video');
    const src = (v && (v.currentSrc || v.src)) || '';
    const m = src.match(/\/kj(\d+)\//);
    return {
      url: location.href,
      coursewareID: m ? Number(m[1]) : null,
      selected: document.querySelector('.cw-title.cw-selected')?.innerText?.replace(/\n/g, ' ') || null,
      ct: v ? +v.currentTime.toFixed(1) : null,
      dur: v ? +(v.duration || 0).toFixed(1) : null,
      paused: v ? v.paused : null,
      rate: v ? v.playbackRate : null,
      guard: window.__SDLPA_GUARD__ === true,
      dialog: document.querySelector('.el-message-box__message')?.innerText?.slice(0, 80) || null,
      checkin: !!document.querySelector('.checkin-dialog'),
      ended: !!v && v.ended,
      mediaErr: window.__SDLPA_MEDIA_ERR__ || null,
      cwCount: document.querySelectorAll('.cw-title').length,
      logs: (window.__sdlpaLog || []).slice(-4),
    };
  }).catch(() => null);
}

async function clickCourseware(page, name) {
  let r;
  try {
    r = await page.evaluate((target) => {
      const btns = [...document.querySelectorAll('.cw-title')];
      const norm = (s) => String(s || '').replace(/\s+/g, '').trim();
      const t = norm(target);
      const labels = [];
      for (const b of btns) {
        const label = norm(b.querySelector('.cw-name-label')?.innerText || '');
        labels.push(label);
        if (label && (label === t || label.includes(t) || t.includes(label))) {
          b.click();
          return { ok: label, n: btns.length };
        }
      }
      return { ok: null, n: btns.length, labels: labels.slice(0, 60), want: t, url: location.href };
    }, name);
  } catch (e) {
    return { ok: null, err: e.message };
  }
  return r;
}

async function injectAnswers(page, table) {
  await page.evaluate((t) => { window.__cwAnswers = Object.assign(window.__cwAnswers || {}, t); }, table).catch(() => {});
}

// 点到"下一个未完成课件"：播完后主动找列表中下一个灰色/未完成的课件
async function goNextPending(page, doneIDs) {
  return page.evaluate((done) => {
    const btns = [...document.querySelectorAll('.cw-title')];
    for (const b of btns) {
      const tag = (b.parentElement?.querySelector('.el-tag')?.innerText || '').trim();
      const label = (b.querySelector('.cw-name-label')?.innerText || '').trim();
      const finished = /100%|已完成/.test(tag);
      if (!finished) { b.click(); return label; }
    }
    return null;
  }, [...doneIDs]).catch(() => null);
}


// 到结尾后回查服务端，确认这一节真的记满了
async function verifyOne(page, it) {
  const cid = it.courseID;
  try {
    let stat = null;
    const grab = async (res) => {
      if (res.url().includes('/learning/getTraineeLearnStat') && !stat) {
        try { stat = JSON.parse(await res.text()); } catch (e) {}
      }
    };
    page.on('response', grab);
    await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
    for (let i = 0; i < 25 && !stat; i++) await sleep(700);
    page.off('response', grab);
    if (!stat || !stat.data) return null;
    fs.writeFileSync(STAT_FILE, JSON.stringify(stat, null, 2));
    const cs = stat.data.courseStats?.[String(cid)];
    const w = cs?.coursewareStats?.[String(it.coursewareID)];
    if (!w) return null;
    const done = w.totalDuration > 0 && w.learnDuration >= w.totalDuration - 3;
    log(`   服务端确认 ${it.coursewareID}: ${w.learnDuration}/${w.totalDuration} ${done ? '✅' : '未满'}`);
    return done;
  } catch (e) { return null; }
}

// ---------------- 单课件推进 ----------------
async function runCourseware(page, it) {
  log(`--- ${it.courseName} / ${it.coursewareName}  ${fmt(it.learned)}/${fmt(it.timeLen)}`);

  let clicked = await clickCourseware(page, it.coursewareName);
  if (!clicked || !clicked.ok) {
    // 页面可能已经崩了/白屏，重载一次再试
    log('  .. 列表里没找到，重载页面重试');
    await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
    await sleep(7000);
    clicked = await clickCourseware(page, it.coursewareName);
  }
  if (!clicked || !clicked.ok) {
    log('  !! 重试后仍找不到，跳过 ' + JSON.stringify(clicked || {}).slice(0, 300));
    return 'notfound';
  }
  await sleep(4500);

  let openedAt = Date.now();
  let lastReport = 0;
  let stuckRounds = 0;
  let lastCt = -1;
  let ctStuckSince = Date.now();
  let maxCt = 0;
  let checkinSince = 0;
  let checkinAnnounced = false;
  let pauseLogged = false;
  let pausedAt = 0;
  let lastPauseTick = 0;
  const seenGuardLogs = new Set();
  const maxWait = Math.max((it.timeLen - it.learned), 0) * 1000 + 1800 * 1000;

  while (Date.now() - openedAt < maxWait) {
    await sleep(5000);

    // 看板点了「暂停」：原地停住，不切课件也不推进
    if (fs.existsSync(PAUSE_FLAG)) {
      if (!pauseLogged) {
        log('  || 已暂停（看板点了暂停），等待继续');
        pauseLogged = true;
        pausedAt = Date.now();
        lastPauseTick = Date.now();
        await page.evaluate(() => {
          window.__SDLPA_PAUSED__ = true;
          const v = document.querySelector('video');
          if (v) { try { v.pause(); } catch (e) {} }
        }).catch(() => {});
      }
      // 暂停期间墙上时间照走，会把 openedAt 拖过 maxWait 导致误判超时。
      // 每轮把实际流逝的时间补回 openedAt，等于暂停不计入时限。
      const nowMs = Date.now();
      openedAt += nowMs - lastPauseTick;
      lastPauseTick = nowMs;
      continue;
    }
    if (pauseLogged) {
      log(`  || 恢复播放（暂停了 ${Math.round((Date.now() - pausedAt) / 60000)} 分钟）`);
      openedAt += Date.now() - lastPauseTick;
      pausedAt = 0;
      pauseLogged = false;
      ctStuckSince = Date.now();
      lastCt = -1;
      // 页面偶尔会在忙碌时吃掉 evaluate，所以设完要读回来确认，没生效就重试
      for (let k = 0; k < 6; k++) {
        const ok = await page.evaluate(() => {
          window.__SDLPA_PAUSED__ = false;
          const v = document.querySelector('video');
          if (v) {
            try { v.play().catch(() => {}); } catch (e) {}
            return !v.paused || window.__SDLPA_PAUSED__ === false;
          }
          return window.__SDLPA_PAUSED__ === false;
        }).catch(() => false);
        if (ok) break;
        await sleep(1500);
      }
      const still = await page.evaluate(() => window.__SDLPA_PAUSED__ === true).catch(() => false);
      if (still) log('  !! 恢复标记没清掉，下一轮再试');
    }

    const st = await readLive(page);
    if (!st) continue;

    if (/login/.test(st.url)) { log('  !! 登录失效'); return 'relogin'; }

    // 当前页已经被切到别的课件 —— 说明平台自己跳了
    if (st.coursewareID && st.coursewareID !== it.coursewareID) {
      // 判断是不是平台自动播下一个：如果是，等它播完再继续
      log(`  -> 页面已切到 ${st.coursewareID}，重新定位`);
      return 'switched';
    }

    // 播放位置不再前进 —— 超过 90 秒判定卡死
    if (st.ct !== null && Math.abs(st.ct - lastCt) > 0.4) {
      lastCt = st.ct;
      ctStuckSince = Date.now();
    }
    if (Date.now() - ctStuckSince > 90000) {
      log('  !! 位置 90 秒未推进，重载本课件');
      await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
      await sleep(6000);
      await clickCourseware(page, it.coursewareName);
      await sleep(4000);
      ctStuckSince = Date.now();
      openedAt = Date.now();
      continue;
    }

    // guard 的拦截日志同步落盘（签到提示、恢复播放都能看到）
    if (Array.isArray(st.logs) && st.logs.length) {
      const fresh = st.logs.filter((l) => !seenGuardLogs.has(l));
      fresh.forEach((l) => seenGuardLogs.add(l));
      if (seenGuardLogs.size > 400) seenGuardLogs.clear();
      fresh.forEach((l) => { if (/confirm|media|resume|answer|rate/.test(l)) log('   [guard] ' + l); });
    }

    if (Date.now() - lastReport > 240000) {
      lastReport = Date.now();
      log(`   ${fmt(st.ct || 0)} / ${fmt(st.dur || it.timeLen)}  paused=${st.paused} rate=${st.rate} dialog=${st.dialog || '-'}`);
    }

    // 记录播到过的最远位置（用于判断"是否已播完"）
    if (st.ct !== null && st.ct > maxCt) maxCt = st.ct;

    // 播放到结尾。轮询间隔 5 秒，结尾只停一瞬间，所以窗口要给够，
    // 同时用 maxCt 兜住"播完立刻回滚到 0"的情况。
    const nearEnd = st.dur && st.ct >= st.dur - 12;
    const endedThenReset =
      st.dur && maxCt >= st.dur * 0.92 && st.ct !== null && st.ct < Math.max(st.dur * 0.1, 90);
    const endedFlag = st.ended === true;

    if (nearEnd || endedThenReset || endedFlag) {
      log(`  -> 到结尾（本次 ${fmt(st.ct)} / 最远 ${fmt(maxCt)} / 总 ${fmt(st.dur)}），等平台结算`);
      await sleep(20000);
      const ok = await verifyOne(page, it);
      if (!ok) log('  ?? 服务端尚未记满，后续轮次会补');
      return 'done';
    }

    // 媒体流断了（HLS 偶发 206 断流会让 video 进入 error 且永久暂停）
    if (st.mediaErr && st.mediaErr.code) {
      log(`  !! 媒体错误 code=${st.mediaErr.code} ${st.mediaErr.msg || ''}，重载本节`);
      await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
      await sleep(7000);
      await clickCourseware(page, it.coursewareName);
      await sleep(4000);
      ctStuckSince = Date.now();
      openedAt = Date.now();
      lastCt = -1;
      continue;
    }

    // 图形点选签到：服务器下发图片要求按序点选，本程序不做图像识别。
    // 先等一段时间看是否有人工处理；超时就把这节延后，继续推进别的课件。
    if (st.checkin) {
      if (!checkinSince) {
        checkinSince = Date.now();
        checkinAnnounced = true;
        log('  !! 出现图形点选签到（需要人眼识别图片）');
        try {
          fs.writeFileSync(path.join(DATA, 'NEED_MANUAL'),
            `图形点选签到
时间: ${new Date().toLocaleString('zh-CN')}
课程: ${it.courseName}
课件: ${it.coursewareID} ${it.coursewareName}
` +
            `浏览器的调试端口: 127.0.0.1:9222
完成后弹窗会自动消失，程序继续。
`);
        } catch (e) {}
        await page.screenshot({ path: path.join(DATA, 'checkin.png') }).catch(() => {});
        log('  .. 已把签到截图存到 data/checkin.png');
      }
      if (Date.now() - checkinSince > 180000) {
        log('  !! 签到 3 分钟未处理，本节延后，先推进其他课件');
        try { fs.rmSync(path.join(DATA, 'NEED_MANUAL'), { force: true }); } catch (e) {}
        return 'deferred';
      }
      continue;
    }
    if (checkinSince) {
      checkinSince = 0;
      log('  -> 签到已通过，继续播放');
      try { fs.rmSync(path.join(DATA, 'NEED_MANUAL'), { force: true }); } catch (e) {}
    }

    if (st.paused) {
      stuckRounds++;
      if (stuckRounds >= 3) {
        log('  !! 持续暂停，主动 resume');
        await page.evaluate(() => {
          const v = document.querySelector('video');
          if (!v) return;
          v.playbackRate = 1;
          if (v.error) { v.load(); }
          v.play().catch(() => {});
        }).catch(() => {});
        stuckRounds = 0;
      }
    } else {
      stuckRounds = 0;
    }
  }

  log('  !! 超时，留给下一轮');
  return 'timeout';
}

// ---------------- 主流程 ----------------
async function main() {
  acquireLock();
  log('================ runner 启动 ================');

  let cachedIDs = [];
  try { cachedIDs = JSON.parse(fs.readFileSync(COURSES_FILE, 'utf8')).data.map((c) => c.courseID); } catch (e) {}

  const browser = await connect();

  // 先把上次登录导出的 cookie 注回去。
  // jwtToken 没有过期时间（会话 cookie），Chrome 不会写进 Cookies 库，
  // 换进程就丢，只能靠 data/session.json 自己带过来。
  let injected = 0;
  try {
    injected = await require('./session-store').importInto(browser.contexts()[0]);
  } catch (e) { injected = 0; }
  if (injected) log(`已注入登录态 ${injected} 条 cookie`);

  const page = await ensurePage(browser);
  if (injected) {
    await page.goto(`${BASE}/train?traineeid=${TRAINEE}`, { waitUntil: 'domcontentloaded' }).catch(() => {});
    await sleep(3000);
  }

  if (await isLoggedOut(page)) {
    const store = require('./session-store');
    const left = store.expiresIn();
    const why = store.isDead()
      ? `登录态已过期 ${left === null ? '' : Math.round(-left / 3600000) + ' 小时'}`
      : (injected ? 'cookie 注入了但服务端不认（可能被踢下线）' : '本地没有可用的登录态');
    log(`!! 未登录（${why}），等待人工登录`);
    try { require('fs').writeFileSync(require('path').join(__dirname, 'data', 'NEED_LOGIN'), new Date().toISOString()); } catch (e) {}
    try { require('./platform').notify('需要重新登录', `执业药师刷课停了：${why}`); } catch (e) {}
    await page.goto(`${BASE}/train?traineeid=${TRAINEE}`, { waitUntil: 'domcontentloaded' }).catch(() => {});
    await sleep(4000);
    if (await isLoggedOut(page)) { log('!! 仍然未登录，退出'); process.exit(2); }
    try { require('fs').rmSync(require('path').join(__dirname, 'data', 'NEED_LOGIN'), { force: true }); } catch (e) {}
  }

  const { courses, stat } = await pullServerTruth(page, cachedIDs);
  if (!courses) { log('!! 取不到课程结构'); process.exit(1); }
  if (!stat) { log('!! 取不到学时明细，本轮只用本地判断'); }

  const queue = buildQueue(courses, stat);
  // 长课件（timeLen >= 2400）可能触发图形点选签到，排到最后，
  // 先把不需要人工介入的学时全部吃完。
  const RISKY = 2400;
  queue.sort((a, b) => {
    const ra = a.timeLen >= RISKY ? 1 : 0;
    const rb = b.timeLen >= RISKY ? 1 : 0;
    if (ra !== rb) return ra - rb;
    return 0;
  });
  const todo = queue.filter((x) => !x.complete);
  const doneList = queue.filter((x) => x.complete);
  const totalSec = queue.reduce((s, x) => s + x.timeLen, 0);
  const learnedSec = queue.reduce((s, x) => s + Math.min(x.learned, x.timeLen), 0);

  log(`课件 ${queue.length} 个，服务端已完成 ${doneList.length} 个，待学 ${todo.length} 个`);
  log(`总时长 ${fmt(totalSec)}，服务端已记录 ${fmt(learnedSec)}（${totalSec ? ((learnedSec / totalSec) * 100).toFixed(1) : 0}%）`);

  if (!todo.length) {
    log('全部课件已完成 ✅');
    try { fs.writeFileSync(path.join(DATA, 'ALL_DONE'), new Date().toLocaleString('zh-CN')); } catch (e) {}
    process.exit(0);
  }
  try { fs.rmSync(path.join(DATA, 'ALL_DONE'), { force: true }); } catch (e) {}

  if (DRY) {
    todo.slice(0, 25).forEach((x, i) => log(`  [${i + 1}] ${x.courseName} / ${x.coursewareName} ${fmt(x.learned)}/${fmt(x.timeLen)}`));
    log(`--dry 结束，共 ${todo.length} 个待学`);
    process.exit(0);
  }

  const answerTable = {};
  for (const x of queue) if (x.questions.length) answerTable[x.coursewareID] = x.questions;
  if (Object.keys(answerTable).length) log(`带弹题的课件 ${Object.keys(answerTable).length} 个`);

  let currentCourse = null;
  let lastCoursePageLoad = 0;
  let walkPaused = false;
  const deferredIDs = new Set();

  const deferCount = {};
  for (let i = 0; i < todo.length; i++) {
    const it = todo[i];

    // 看板点了「暂停」：在换课件之前就停住，别把正在播的切掉
    while (fs.existsSync(PAUSE_FLAG)) {
      if (!walkPaused) {
        log('|| 已暂停（看板点了暂停），等继续');
        walkPaused = true;
      }
      await sleep(5000);
    }
    if (walkPaused) {
      log('|| 恢复，继续下一个');
      walkPaused = false;
    }

    const dc = deferCount[it.coursewareID] || 0;
    if (dc >= 3) { log(`跳过（已延后 ${dc} 次）: ${it.coursewareName}`); continue; }
    log(`\n[${i + 1}/${todo.length}]`);

    // 切课程页
    if (currentCourse !== it.courseID) {
      await page.goto(`${BASE}/learn?traineeid=${TRAINEE}&courseid=${it.courseID}`, { waitUntil: 'domcontentloaded' }).catch(() => {});
      await sleep(6500);
      if (await isLoggedOut(page)) { log('!! 登录失效，退出等待重登'); process.exit(2); }
      currentCourse = it.courseID;
      lastCoursePageLoad = Date.now();
    }
    await injectAnswers(page, answerTable);

    let res = await runCourseware(page, it);

    // 如果页面被平台自动切到下一个课件，先把当前这个确认掉，然后重新扫描列表
    if (res === 'switched') {
      await page.goto(`${BASE}/learn?traineeid=${TRAINEE}&courseid=${it.courseID}`, { waitUntil: 'domcontentloaded' }).catch(() => {});
      await sleep(6000);
      await injectAnswers(page, answerTable);
      lastCoursePageLoad = Date.now();
    }
    if (res === 'relogin') process.exit(2);

    // 延后的课件推到队尾，等别处推进完再来试（可能那时已有人点了签到）
    if (res === 'deferred') {
      deferredIDs.add(it.coursewareID);
      deferCount[it.coursewareID] = (deferCount[it.coursewareID] || 0) + 1;
      todo.push(it);
    }

    if (ONCE) { log('--once 模式结束'); break; }
  }

  log('\n=========== 本轮跑完，等待下一轮 ===========');
  releaseLock();
  process.exit(0);
}

main().catch((e) => {
  log('崩了：' + (e && e.stack ? e.stack : e));
  releaseLock();
  process.exit(1);
});
