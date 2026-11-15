/**
 * 守护进程：开机自启的唯一入口（由计划任务经 wscript 隐藏窗口拉起）。
 *
 * 职责：
 *  1. 确保无窗口 Chrome 在跑（挂了就重启）
 *  2. 确保 runner 在跑（挂了就重启，正常跑完等 3 分钟再来一轮）
 *  3. 确保系统不进入睡眠（屏幕可以关，但系统保持运行）
 *  4. 每 6 小时滚动重启一次 Chrome，防止长时间运行内存膨胀
 *  5. 全程不弹任何窗口
 */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const net = require('net');

const ROOT = __dirname;
const DATA = path.join(ROOT, 'data');
const LOG = path.join(DATA, 'daemon.log');
const PORT = Number(process.env.SDLPA_PORT || 9222);
const NODE = process.execPath;
const PS = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
const plat = require('./platform');       // 全部平台差异都在这一个模块里
const IS_WIN = plat.IS_WIN;

const CHROME_RESTART_MS = 6 * 60 * 60 * 1000;   // 6 小时滚动重启 Chrome
const RUNNER_RETRY_MS = 3 * 60 * 1000;          // runner 正常退出后 3 分钟再来

let runnerProc = null;
let sleeperProc = null;
let notifyProc = null;
let statusProc = null;
let stopping = false;
let chromeStartedAt = Date.now();
let chromeLaunching = false;
let lastRunnerExit = 0;
let lastRunnerCode = null;

function log(...a) {
  const line = `[${new Date().toLocaleString('zh-CN', { hour12: false })}] ${a.join(' ')}`;
  try {
    fs.mkdirSync(DATA, { recursive: true });
    if (fs.existsSync(LOG) && fs.statSync(LOG).size > 3 * 1024 * 1024) {
      fs.writeFileSync(LOG, fs.readFileSync(LOG, 'utf8').slice(-1.2 * 1024 * 1024));
    }
    fs.appendFileSync(LOG, line + '\n');
  } catch (e) {}
}


// ---------- 单实例锁 ----------
// wscript 拉起 node 后自身退出，计划任务的 MultipleInstances=IgnoreNew 就失效了。
// 所以必须自己守一道，否则会出现两套 daemon 各带一个 runner 互抢播放器。
const PIDFILE = path.join(DATA, 'daemon.pid');
function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}
function acquireLock() {
  try {
    const old = Number(fs.readFileSync(PIDFILE, 'utf8').trim());
    if (old && old !== process.pid && pidAlive(old)) {
      log(`!! 已有 daemon 在跑 (pid=${old})，本次退出`);
      return false;
    }
  } catch (e) {}
  try { fs.mkdirSync(DATA, { recursive: true }); fs.writeFileSync(PIDFILE, String(process.pid)); } catch (e) {}
  return true;
}
function releaseLock() {
  try {
    const cur = Number(fs.readFileSync(PIDFILE, 'utf8').trim());
    if (cur === process.pid) fs.rmSync(PIDFILE, { force: true });
  } catch (e) {}
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function portOpen(port) {
  return new Promise((resolve) => {
    const s = new net.Socket();
    const done = (v) => { try { s.destroy(); } catch (e) {} resolve(v); };
    s.setTimeout(1200);
    s.once('connect', () => done(true));
    s.once('timeout', () => done(false));
    s.once('error', () => done(false));
    s.connect(port, '127.0.0.1');
  });
}

// ---------- 防睡眠 ----------
function startSleeper() {
  if (sleeperProc) return;
  // 平台差异都收在 platform.js 里：
  // Windows 走 keepscreen.ps1（SetThreadExecutionState），
  // Linux 走 systemd-inhibit（没装 systemd 就跳过，刷课本不受影响）
  sleeperProc = plat.startSleeper();
  if (!sleeperProc) return;
  sleeperProc.on('exit', () => { log('防睡眠已退出'); sleeperProc = null; });
  sleeperProc.on('error', (e) => { log('防睡眠启动失败 ' + e.message); sleeperProc = null; });
  log('防睡眠已启动');
}

// ---------- 人工介入提醒 ----------
function startNotifier() {
  if (notifyProc) return;
  // Windows 用 notify.ps1 的 Toast；Linux 由 platform.notify 走 notify-send，
  // 没有常驻进程可托管，这里直接跳过（需要提醒时 runner 会自己调）。
  if (!IS_WIN) return;
  const ps1 = path.join(ROOT, 'notify.ps1');
  if (!fs.existsSync(ps1)) return;
  notifyProc = spawn(PS, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', ps1], {
    stdio: 'ignore',
    windowsHide: true,
  });
  notifyProc.on('exit', () => { notifyProc = null; });
  notifyProc.on('error', () => { notifyProc = null; });
}

// ---------- Chrome ----------
async function launchChrome() {
  return new Promise((resolve) => {
    const p = spawn(NODE, [path.join(ROOT, 'launch-headless.js')], {
      stdio: 'ignore',
      windowsHide: true,
      env: { ...process.env, SDLPA_PORT: String(PORT) },
    });
    p.on('exit', (code) => resolve(code === 0));
    p.on('error', () => resolve(false));
  });
}

function killChrome() {
  // Windows 用 PowerShell 精确定位「命令行含 sdlpa 和 profile 的 chrome」；
  // Linux 用 pkill -f -- "--user-data-dir=<profile>"，同样不会误杀用户自己的浏览器。
  return plat.killChrome(path.join(DATA, 'profile'));
}

// ---------- runner ----------
function launchRunner() {
  // 注意：这里绝不能再删 runner.lock。
  // 删掉就等于把 runner 自己的单实例检查关掉了，
  // 两套 daemon 会各起一个 runner 抢同一个播放器。
  const p = spawn(NODE, [path.join(ROOT, 'runner.js')], {
    stdio: 'ignore',
    windowsHide: true,
    env: { ...process.env, SDLPA_PORT: String(PORT) },
  });
  p.on('exit', (code) => {
    log(`runner 退出 code=${code}`);
    runnerProc = null;
    lastRunnerExit = Date.now();
    lastRunnerCode = code;
  });
  p.on('error', (e) => { log('runner 启动失败 ' + e.message); runnerProc = null; });
  runnerProc = p;
  log(`runner 已启动 pid=${p.pid}`);
}

async function ensureRunner() {
  if (stopping || runnerProc) return;
  // 全部课件已完成：不再空转，等人工确认后再动
  if (fs.existsSync(path.join(DATA, 'ALL_DONE'))) return;
  // 等人重新登录期间别再反复拉起 runner：
  // 之前每次拉起都要重连一次 Chrome、刷一遍课程页，纯浪费还刷日志。
  // 登录成功后 relogin.js 会把这个标记删掉。
  if (fs.existsSync(path.join(DATA, 'NEED_LOGIN'))) return;
  if (!(await portOpen(PORT))) return;
  // 刚退出过就等够时间再来。
  // 之前这里没判断，runner 一退 tick 就把 lastRunnerExit 的等待绕过去了，
  // 结果登录失效后每分钟拉起一次，一晚上刷了 266 次「未登录」。
  const wait = lastRunnerCode === 2 ? 10 * 60 * 1000 : RUNNER_RETRY_MS;
  if (lastRunnerExit && Date.now() - lastRunnerExit < wait) return;
  launchRunner();
}

// ---------- 看板状态汇总 ----------
// status.js 每 10 秒把服务端真相 + 日志 + 进程表算成 data/status.json，
// peek.html 只读那个文件。它是纯只读的，挂了不影响刷课，
// 但挂了看板就是一片空白，所以也交给 daemon 托管。
function launchStatus() {
  const p = spawn(NODE, [path.join(ROOT, 'status.js')], {
    stdio: 'ignore',
    windowsHide: true,
    env: { ...process.env, SDLPA_PORT: String(PORT) },
  });
  p.on('exit', (code) => {
    log(`status 退出 code=${code}`);
    statusProc = null;
  });
  p.on('error', (e) => { log('status 启动失败 ' + e.message); statusProc = null; });
  statusProc = p;
  log(`看板服务已启动 pid=${p.pid}`);
}

function ensureStatus() {
  if (stopping || statusProc) return;
  if (!fs.existsSync(path.join(ROOT, 'status.js'))) return;
  launchStatus();
}

// ---------- 看板网页服务 ----------
// mirror-server.js 是给 peek.html 用的静态服务（8765）。
// 它和 status.js 是两回事：status 算数据，mirror 把数据端到浏览器。
// 之前只托管了 status，mirror 一挂看板就再也打不开，所以这里也补上自愈。
const MIRROR_PORT = Number(process.env.SDLPA_MIRROR_PORT || 8765);
let mirrorProc = null;

function launchMirror() {
  const p = spawn(NODE, [path.join(ROOT, 'mirror-server.js')], {
    stdio: 'ignore',
    windowsHide: true,
    env: { ...process.env, SDLPA_MIRROR_PORT: String(MIRROR_PORT) },
  });
  p.on('exit', (code) => {
    log(`看板网页服务退出 code=${code}`);
    mirrorProc = null;
  });
  p.on('error', (e) => { log('看板网页服务启动失败 ' + e.message); mirrorProc = null; });
  mirrorProc = p;
  log(`看板网页服务已启动 pid=${p.pid}`);
}

async function ensureMirror() {
  if (stopping || mirrorProc) return;
  if (!fs.existsSync(path.join(ROOT, 'mirror-server.js'))) return;
  // 端口已被占（比如手工起过一个），就不再重复起
  if (await portOpen(MIRROR_PORT)) return;
  launchMirror();
}

// ---------- 实时快照 ----------
// watch.js 每 15 秒把后台 Chrome 的画面截到 data/now.png，peek.html 靠它显示实况。
// 它挂了看板不会白，但截图区会一直显示旧画面，容易误判成"卡住了"。
let watchProc = null;

function launchWatch() {
  const p = spawn(NODE, [path.join(ROOT, 'watch.js')], {
    stdio: 'ignore',
    windowsHide: true,
    env: { ...process.env, SDLPA_PORT: String(PORT) },
  });
  p.on('exit', (code) => {
    log(`快照服务退出 code=${code}`);
    watchProc = null;
  });
  p.on('error', (e) => { log('快照服务启动失败 ' + e.message); watchProc = null; });
  watchProc = p;
  log(`快照服务已启动 pid=${p.pid}`);
}

async function ensureWatch() {
  if (stopping || watchProc) return;
  if (!fs.existsSync(path.join(ROOT, 'watch.js'))) return;
  if (!(await portOpen(PORT))) return;    // Chrome 没起来，截不了
  launchWatch();
}

// ---------- 公网映射 ----------
// tunnel.js 把 8765 通过 ngrok 挂到公网，方便手机上随时看。
// 它必须由这里托管：SDK 的 connect() resolve 之后 Node 可能没有活动句柄，
// 事件循环一空进程就自己退了（之前手工 Start-Process 起过，十几秒后就没了）。
// 只有在配了 ngrok-token.txt 的情况下才启用，没配就静默跳过。
let tunnelProc = null;

function launchTunnel() {
  const p = spawn(NODE, [path.join(ROOT, 'tunnel.js')], {
    stdio: 'ignore',
    windowsHide: true,
    env: { ...process.env },
  });
  p.on('exit', (code) => {
    log(`公网映射退出 code=${code}`);
    tunnelProc = null;
  });
  p.on('error', (e) => { log('公网映射启动失败 ' + e.message); tunnelProc = null; });
  tunnelProc = p;
  log(`公网映射已启动 pid=${p.pid}`);
}

async function ensureTunnel() {
  if (stopping || tunnelProc) return;
  if (!fs.existsSync(path.join(ROOT, 'tunnel.js'))) return;
  if (!fs.existsSync(path.join(ROOT, 'ngrok-token.txt'))) return;   // 没配就不启
  if (!(await portOpen(MIRROR_PORT))) return;                        // 看板本身没起就没意义
  launchTunnel();
}


// ---------- 看门狗：识别「页面 JS 卡死」 ----------
// 症状：Chrome 进程活着、runner 进程活着，但页面 JS 引擎卡住，
// CDP 的 Runtime.evaluate 永不返回，runner 的 await 也永不 resolve。
// 于是一路静默——日志不再写、进度不再涨，能卡几个小时。
// 判据：run.log 超过 STALL_MS 没有新内容（runner 每 4 分钟写一行心跳，
// 所以 11 分钟 = 2.75 个心跳周期，正常播放绝不会误判）。
const RUN_LOG = path.join(DATA, 'run.log');
const STALL_MS = Number(process.env.SDLPA_STALL_MS || 11 * 60 * 1000);
let stallHit = 0;

function runLogAge() {
  try { return Date.now() - fs.statSync(RUN_LOG).mtimeMs; } catch (e) { return 0; }
}

async function checkStall() {
  if (stopping || !runnerProc) return;
  // 看板点了暂停：日志本来就不会动，这时候不能算卡死
  if (fs.existsSync(path.join(DATA, 'PAUSED'))) { stallHit = 0; return; }
  const age = runLogAge();
  if (age < STALL_MS) { stallHit = 0; return; }
  stallHit++;
  log(`!! run.log 已 ${Math.round(age / 60000)} 分钟没有新内容，判定卡死（第 ${stallHit} 次）`);
  if (stallHit < 2) return;         // 连续两次确认，避开启动建队列这类长静默
  log('看门狗触发：杀掉 runner 与 Chrome，整轮重启');
  try { runnerProc.kill('SIGKILL'); } catch (e) {}
  runnerProc = null;
  await killChrome();
  await sleep(3000);
  chromeStartedAt = Date.now();
  stallHit = 0;
  await ensureChrome();
}

// ---------- 主循环 ----------
async function ensureChrome() {
  if (stopping) return;
  const up = await portOpen(PORT);
  if (up) {
    if (Date.now() - chromeStartedAt > CHROME_RESTART_MS) {
      log('Chrome 已跑满 6 小时，滚动重启');
      if (runnerProc) { try { runnerProc.kill(); } catch (e) {} runnerProc = null; }
      await killChrome();
      await sleep(4000);
      chromeStartedAt = Date.now();
    } else {
      return;
    }
  }
  if (chromeLaunching) return;
  chromeLaunching = true;
  log('Chrome 未在监听，拉起');
  const ok = await launchChrome();
  log('Chrome 启动' + (ok ? '成功' : '失败'));
  chromeLaunching = false;
  chromeStartedAt = Date.now();
  await sleep(3000);
}

async function tick() {
  if (stopping) return;
  try {
    startSleeper();
    startNotifier();
    await ensureChrome();
    await ensureRunner();
    ensureStatus();
    await ensureMirror();
    await ensureWatch();
    await ensureTunnel();
    await checkStall();
  } catch (e) {
    log('tick 异常 ' + e.message);
  }
  setTimeout(tick, 60000);
}

process.on('SIGINT', () => { stopping = true; process.exit(0); });
process.on('SIGTERM', () => { stopping = true; process.exit(0); });
process.on('uncaughtException', (e) => { log('未捕获异常 ' + (e && e.stack)); });
process.on('exit', () => { releaseLock(); try { sleeperProc && sleeperProc.kill(); } catch (e) {} try { notifyProc && notifyProc.kill(); } catch (e) {} try { statusProc && statusProc.kill(); } catch (e) {} try { mirrorProc && mirrorProc.kill(); } catch (e) {} try { watchProc && watchProc.kill(); } catch (e) {} try { tunnelProc && tunnelProc.kill(); } catch (e) {} });

if (!acquireLock()) process.exit(0);
log('================ daemon 启动 ================');
tick();
