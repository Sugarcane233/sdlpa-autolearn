/**
 * 汇总后台状态，写成 data/status.json 给 peek.html 读。
 *
 * 每 10 秒跑一轮，汇总这些来源：
 *  - data/stat.json      服务端学时真相（runner 在启动和每节结算后写）
 *  - data/now.json       watch.js 的实时画面信息（15 秒一轮）
 *  - data/run.log        runner 日志（异常计数、最近完成、日志尾部）
 *  - data/daemon.log     守护日志（看门狗次数、Chrome 滚动重启）
 *  - 进程表              四个 node 进程是否活着
 *  - data/history.json   自己存的学时采样，用来算速率和 ETA
 *
 * 只读，不改任何运行中的文件。
 */
const fs = require('fs');
const path = require('path');
const net = require('net');
const http = require('http');
// execFile 已不再使用：进程枚举改由 platform.js 统一处理

const ROOT = __dirname;
const DATA = path.join(ROOT, 'data');
const OUT = path.join(DATA, 'status.json');
const HIST = path.join(DATA, 'history.json');
const PORT = Number(process.env.SDLPA_PORT || 9222);
const EVERY = Number(process.env.SDLPA_STATUS_MS || 10000);

const readJSON = (p, fb) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return fb; } };
const readText = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch (e) { return ''; } };
const mtime = (p) => { try { return fs.statSync(p).mtimeMs; } catch (e) { return 0; } };
const ageOf = (t) => (t ? Math.round((Date.now() - t) / 1000) : null);

function pidAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

function readPid(name) {
  const s = readText(path.join(DATA, name)).trim();
  const n = Number(s);
  return n > 0 ? n : null;
}

function portOpen(port) {
  return new Promise((resolve) => {
    const s = new net.Socket();
    const done = (v) => { try { s.destroy(); } catch (e) {} resolve(v); };
    s.setTimeout(900);
    s.once('connect', () => done(true));
    s.once('timeout', () => done(false));
    s.once('error', () => done(false));
    s.connect(port, '127.0.0.1');
  });
}

// 只认本项目起的 node 进程（dsh 自己也跑 node，不能算进来）
// 注意 watch.js / mirror-server.js 是用 Start-Process + WorkingDirectory 起的，
// 命令行里只有裸文件名没有目录，所以不能只靠 sdlpa 关键字。
function nodeProcs() {
  // 平台差异收在 platform.js：Windows 走 Get-CimInstance，Linux 读 /proc
  const plat = require('./platform');
  const list = plat.listNodeProcs('sdlpa');
  // 兜底：有些进程命令行里只有裸文件名（早期 Start-Process + WorkingDirectory 起的），
  // 再按文件名补一遍，避免看板上进程灯误报
  for (const name of ['watch.js', 'mirror-server.js', 'status.js', 'runner.js', 'daemon.js', 'tunnel.js']) {
    for (const x of plat.listNodeProcs(name)) {
      if (!list.some((y) => y.pid === x.pid)) list.push(x);
    }
  }
  return Promise.resolve(list);
}

// ---------- 进度 ----------
function progress() {
  const stat = readJSON(path.join(DATA, 'stat.json'), null);
  const courses = readJSON(path.join(DATA, 'courses.json'), null);
  if (!stat || !courses) return null;

  const stats = (stat.data && stat.data.courseStats) || {};
  const PUBLIC = [674, 675];              // 公需课：学时满即通过，不用考试
  let doneCw = 0, totalCw = 0, learned = 0, total = 0, remainSec = 0;
  let pubDone = 0, pubTotal = 0, proDone = 0, proTotal = 0;
  const residual = [];
  const courseDone = {};                  // cid -> {done, total, name, learned, totalSec}

  for (const co of courses.data || []) {
    const cid = co.courseID;
    const cs = stats[String(cid)] || {};
    const ws = cs.coursewareStats || {};
    const bucket = { done: 0, total: 0, name: co.course.courseName, learned: 0, totalSec: 0, isPublic: PUBLIC.includes(cid) };
    for (const w of co.course.coursewares || []) {
      if (!w.timeLen) continue;           // PDF 讲义不计学时
      const st = ws[String(w.coursewareID)] || { learnDuration: 0, totalDuration: w.timeLen };
      const l = st.learnDuration, t = st.totalDuration;
      const complete = t > 0 && l >= t - 3;
      totalCw++; bucket.total++; learned += l; total += t; bucket.learned += l; bucket.totalSec += t;
      remainSec += Math.max(t - l, 0);
      if (complete) { doneCw++; bucket.done++; } else {
        if (l > 0) residual.push({ cid, wid: w.coursewareID, l, t });
      }
    }
    courseDone[cid] = bucket;
    if (PUBLIC.includes(cid)) { pubDone += bucket.done; pubTotal += bucket.total; }
    else { proDone += bucket.done; proTotal += bucket.total; }
  }

  const passedPublic = (stat.data.publicCourseCount_Pass || 0);
  const passedPro = (stat.data.specializedCourseCount_Pass || 0);
  const fullCourses = Object.entries(courseDone)
    .filter(([, b]) => b.total > 0 && b.done === b.total)
    .map(([cid, b]) => ({ cid: Number(cid), name: b.name }));

  return {
    doneCw, totalCw,
    learnedH: +(learned / 3600).toFixed(2),
    totalH: +(total / 3600).toFixed(2),
    pct: total ? +(learned / total * 100).toFixed(2) : 0,
    remainH: +(remainSec / 3600).toFixed(1),
    pub: { done: pubDone, total: pubTotal },
    pro: { done: proDone, total: proTotal },
    passed: { pub: passedPublic, pro: passedPro, total: passedPublic + passedPro },
    fullCourses,
    residual,
    courseDone,
  };
}

// ---------- 速率与 ETA ----------
// 两套算法：历史采样（准，但要攒时间）和日志反推（立刻就有，粗糙）。
// 采样不够时用日志版兜底，等采样够了自己接管。
function rateFromHistory(learnedH) {
  const hist = readJSON(HIST, []);
  const now = Date.now();
  if (typeof learnedH !== 'number') return { samples: hist.length, speed: null };

  const last = hist[hist.length - 1];
  if (!last) hist.push({ t: now, h: learnedH });
  else if (learnedH > last.h + 0.005 && now - last.t > 60 * 1000) hist.push({ t: now, h: learnedH });

  const keep = hist.filter((x) => now - x.t < 12 * 3600 * 1000).slice(-600);
  try { fs.writeFileSync(HIST, JSON.stringify(keep)); } catch (e) {}

  if (keep.length < 2) return { samples: keep.length, speed: null };
  const win = keep.filter((x) => now - x.t < 3600 * 1000);
  const a = win[0] || keep[0];
  const b = win[win.length - 1];
  const dt = (b.t - a.t) / 3600000;
  const dh = b.h - a.h;
  if (dt < 0.08 || dh <= 0) return { samples: keep.length, speed: null };
  return { samples: keep.length, speed: +(dh / dt).toFixed(2), spanH: +dt.toFixed(2), gainH: +dh.toFixed(2), src: 'history' };
}

// 从 run.log 里的「服务端确认」行反推：相邻两次完成之间的时长 / 墙上时间。
// 注意要把卡死、重启这类超长间隔剔掉，否则速率会被拖得极低。
function rateFromLog() {
  const txt = readText(path.join(DATA, 'run.log'));
  if (!txt) return null;
  const lines = txt.split(/\r?\n/);
  const pts = [];
  lines.forEach((l) => {
    const m = l.match(/^\[(.+?)\]\s+服务端确认\s+(\d+):\s*(\d+)\/(\d+)\s*✅/);
    if (!m) return;
    const t = new Date(m[1].replace(/\//g, '-')).getTime();
    if (isFinite(t)) pts.push({ t, sec: Number(m[3]) });
  });
  if (pts.length < 4) return null;

  const recent = pts.slice(-12);
  const gaps = [];
  for (let i = 1; i < recent.length; i++) {
    const d = recent[i].t - recent[i - 1].t;
    if (d > 60 * 1000 && d < 4 * 3600 * 1000) gaps.push({ d, sec: recent[i].sec });
  }
  if (gaps.length < 3) return null;

  // 中位数剔除法：间隔超过中位数 2.2 倍的多半是卡死/重启，不采信
  const sorted = gaps.map((g) => g.d).slice().sort((a, b) => a - b);
  const med = sorted[Math.floor(sorted.length / 2)];
  const good = gaps.filter((g) => g.d <= med * 2.2);
  const use = good.length >= 3 ? good : gaps;

  let sumSec = 0, sumMs = 0;
  use.forEach((g) => { sumMs += g.d; sumSec += g.sec; });
  if (sumMs <= 0 || sumSec <= 0) return null;
  const speed = (sumSec / 3600) / (sumMs / 3600000);
  return {
    speed: +speed.toFixed(2),
    spanH: +(sumMs / 3600000).toFixed(2),
    gainH: +(sumSec / 3600).toFixed(2),
    src: 'log',
    used: use.length,
    dropped: gaps.length - use.length,
  };
}

// ---------- 异常与最近完成 ----------
function scanRunLog() {
  const txt = readText(path.join(DATA, 'run.log'));
  if (!txt) return { counts: {}, recent: [], tail: [] };
  const lines = txt.split(/\r?\n/);
  const counts = {
    mediaErr: 0, checkin: 0, relogin: 0, notfound: 0, resume: 0, rate: 0, answer: 0,
  };
  const recent = [];
  lines.forEach((l) => {
    if (l.includes('媒体错误')) counts.mediaErr++;
    if (l.includes('签到')) counts.checkin++;
    if (l.includes('登录失效')) counts.relogin++;
    if (l.includes('列表里找不到')) counts.notfound++;
    if (l.includes('[guard] resume')) counts.resume++;
    if (l.includes('[guard] rate')) counts.rate++;
    if (l.includes('[guard] answer')) counts.answer++;
    const m = l.match(/^\[(.+?)\]\s+服务端确认\s+(\d+):\s*(\d+)\/(\d+)\s*✅/);
    if (m) recent.push({ at: m[1], wid: Number(m[2]), l: Number(m[3]), t: Number(m[4]) });
  });
  return { counts, recent: recent.slice(-8).reverse(), tail: lines.filter(Boolean).slice(-14) };
}

function scanDaemonLog() {
  const txt = readText(path.join(DATA, 'daemon.log'));
  const lines = txt.split(/\r?\n/).filter(Boolean);
  let watchdog = 0, restarts = 0;
  lines.forEach((l) => {
    if (l.includes('看门狗触发')) watchdog++;
    if (l.includes('滚动重启')) restarts++;
  });
  return { watchdog, restarts, tail: lines.slice(-8) };
}

async function build() {
  const [chromeUp, procs] = await Promise.all([portOpen(PORT), nodeProcs()]);
  const daemonPid = readPid('daemon.pid');
  const runnerPid = readPid('runner.lock');
  const prog = progress();
  const now = readJSON(path.join(DATA, 'now.json'), null);
  const run = scanRunLog();
  const dae = scanDaemonLog();

  // 速率：优先用历史采样，不够就用日志反推
  const hist = prog ? rateFromHistory(prog.learnedH) : { samples: 0, speed: null };
  let rt = hist.speed ? hist : null;
  if (!rt) {
    const lg = rateFromLog();
    if (lg) rt = { ...lg, samples: hist.samples };
  }
  if (rt && !rt.speed) rt = null;

  // watch 活着 = now.json 60 秒内更新过
  const watchAge = ageOf(mtime(path.join(DATA, 'now.json')));
  const watchAlive = watchAge !== null && watchAge < 70;

  const findPid = (kw) => {
    const hit = procs.find((p) => p.cmd.includes(kw));
    return hit ? hit.pid : null;
  };
  const watchPid = findPid('watch.js');
  const mirrorPid = findPid('mirror-server.js');

  const etaAt = (() => {
    if (!prog || !rt || !rt.speed) return null;
    const hours = prog.remainH / rt.speed;
    if (!isFinite(hours) || hours <= 0) return null;
    const d = new Date(Date.now() + hours * 3600 * 1000);
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getMonth() + 1}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  })();

  return {
    at: new Date().toLocaleString('zh-CN', { hour12: false }),
    procs: {
      daemon: { pid: daemonPid, alive: pidAlive(daemonPid) },
      runner: { pid: runnerPid, alive: pidAlive(runnerPid) },
      chrome: { alive: chromeUp },
      watch: { pid: watchPid, alive: !!watchPid && watchAlive, ageSec: watchAge },
      mirror: { pid: mirrorPid, alive: !!mirrorPid },
      nodeCount: procs.length,
    },
    progress: prog,
    current: now,
    rate: rt,
    etaAt,
    anomalies: { ...run.counts, watchdog: dae.watchdog, chromeRestart: dae.restarts },
    recent: run.recent,
    logs: { run: run.tail, daemon: dae.tail },
    flags: {
      needManual: fs.existsSync(path.join(DATA, 'NEED_MANUAL')),
      needLogin: fs.existsSync(path.join(DATA, 'NEED_LOGIN')),
      allDone: fs.existsSync(path.join(DATA, 'ALL_DONE')),
      paused: fs.existsSync(path.join(DATA, 'PAUSED')),
    },
    stallSec: ageOf(mtime(path.join(DATA, 'run.log'))),
    shotAgeSec: watchAge,
  };
}

(async () => {
  const one = process.argv.includes('--once');
  do {
    let out;
    try {
      out = await build();
    } catch (e) {
      out = { at: new Date().toLocaleString('zh-CN', { hour12: false }), error: e.message };
    }
    const tmp = path.join(DATA, 'status.tmp.json');
    try { fs.writeFileSync(tmp, JSON.stringify(out, null, 1)); fs.renameSync(tmp, OUT); } catch (e) {}
    if (one) { console.log(JSON.stringify(out, null, 1)); break; }
    await new Promise((r) => setTimeout(r, EVERY));
  } while (true);
  process.exit(0);
})();
