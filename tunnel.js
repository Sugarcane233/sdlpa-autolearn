// 把本地看板（8765）通过 ngrok 映射到公网。
//
// 用官方 Node SDK（@ngrok/ngrok），不需要单独下 exe —— 那个 12MB 的包
// 在你这网络环境下一直断流，SDK 自带原生库，npm 装完就有。
//
// 前置条件（只需做一次）：
//   1. 去 https://dashboard.ngrok.com/signup 注册（邮箱即可，不要信用卡）
//   2. 在 https://dashboard.ngrok.com/get-started/your-authtoken 复制 token
//   3. 把 token 存进 sdlpa\ngrok-token.txt（一行，不要引号）
//   4. 你的固定域名在 https://dashboard.ngrok.com/domains 能看到，
//      形如 xxxx.ngrok-free.app，存进 sdlpa\ngrok-domain.txt
//
// 跑起来之后是 https://<域名>/peek.html?k=<口令>，重启不变。
//
// 免费版每月 1 GB 出站流量。看板里最吃流量的是实况截图，
// watch.js 已经做了「没人看就降频到 3 分钟一张」，别把频率改回去。
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const DATA = path.join(ROOT, 'data');
const LOG = path.join(DATA, 'ngrok.log');
const TOKEN_FILE = path.join(ROOT, 'ngrok-token.txt');
const DOMAIN_FILE = path.join(ROOT, 'ngrok-domain.txt');
const LOCAL_PORT = Number(process.env.SDLPA_MIRROR_PORT || 8765);

function log(...a) {
  const line = `[${new Date().toLocaleString('zh-CN', { hour12: false })}] ${a.join(' ')}`;
  try { fs.mkdirSync(DATA, { recursive: true }); fs.appendFileSync(LOG, line + '\n'); } catch (e) {}
  console.log(line);
}

function readOne(p) {
  try { return fs.readFileSync(p, 'utf8').trim(); } catch (e) { return ''; }
}

const token = process.env.NGROK_AUTHTOKEN || readOne(TOKEN_FILE);
if (!token) {
  log('缺少 authtoken：去 https://dashboard.ngrok.com/get-started/your-authtoken 复制，');
  log('存成 ' + TOKEN_FILE + '（一行，不要引号），再重跑本脚本。');
  process.exit(2);
}
const domain = process.env.NGROK_DOMAIN || readOne(DOMAIN_FILE);

let ngrok;
try {
  ngrok = require('@ngrok/ngrok');
} catch (e) {
  log('没装 SDK：先在本目录跑 npm i @ngrok/ngrok');
  process.exit(3);
}

let listener = null;
let stop = false;
let retry = 0;

// SDK 的 connect() resolve 之后，Node 里可能没有任何活动句柄了，
// 事件循环一空进程就直接退出——隧道也会跟着断。
// 之前用 Start-Process 起过一次，日志写着连接成功，几秒后进程就没了，就是这个原因。
// 这个定时器既是保活，也顺手做健康检查。
const keepAlive = setInterval(async () => {
  if (stop) return;
  try {
    const alive = typeof ngrok.listeners === 'function' ? ngrok.listeners().size > 0 : true;
    if (!alive && listener) {
      log('隧道似乎掉了，重连');
      listener = null;
      await connect();
    }
  } catch (e) { /* 健康检查失败不影响主流程，下一轮再看 */ }
}, 60000);

async function connect() {
  const opts = { addr: LOCAL_PORT, authtoken: token };
  if (domain) opts.domain = domain;     // 免费版必须用账号里那个固定域名

  // 重连之前必须把旧 listener 关掉。
  // ngrok 免费账号限制「一个 agent session 最多 5 个 endpoint」，
  // 之前每次重试都新开一个、旧的留在那儿不关，第 6 次就永久失败：
  //   "Your account may not run more than 5 endpoints over a single ngrok agent session."
  // 而且旧 endpoint 已经占着那个固定域名，新的也开不出来。
  try {
    if (listener) { await listener.close(); listener = null; }
  } catch (e) {
    try { ngrok.kill(); } catch (e2) {}     // 关不掉就把整个 session 掀了重来
    await new Promise((r) => setTimeout(r, 2000));
  }

  log(`连接 ngrok：本地 ${LOCAL_PORT}` + (domain ? ` → ${domain}` : ' （未配域名，用临时地址）'));
  try {
    listener = await ngrok.connect(opts);
    const url = listener.url();
    log(`公网地址 ${url}`);
    try { fs.writeFileSync(path.join(DATA, 'ngrok-url.txt'), url); } catch (e) {}
    retry = 0;
  } catch (e) {
    const msg = (e && e.message) || String(e);
    log('连接失败：' + msg.slice(0, 300));
    // 端点占满：把 session 整个掀掉，下一轮从零开始
    if (/more than 5 endpoints/i.test(msg)) {
      log('  → 旧会话残留端点太多，重置 ngrok session');
      try { ngrok.kill(); } catch (e2) {}
      await new Promise((r) => setTimeout(r, 3000));
    }
    if (/ERR_NGROK_105|failed to start tunnel|authentication/i.test(msg)) {
      log('  → 多半是 token 无效或没在 ngrok 后台建过域名，检查 ngrok-token.txt / ngrok-domain.txt');
    }
    if (stop) return;
    retry = Math.min(retry + 1, 6);
    const wait = Math.min(15000 * retry, 2 * 60 * 1000);
    log(`  ${Math.round(wait / 1000)} 秒后重试（第 ${retry} 次）`);
    setTimeout(connect, wait);
  }
}

function shutdown() {
  stop = true;
  clearInterval(keepAlive);
  try { if (listener) listener.close(); } catch (e) {}
  try { ngrok.kill(); } catch (e) {}
}
process.on('SIGINT', () => { shutdown(); process.exit(0); });
process.on('SIGTERM', () => { shutdown(); process.exit(0); });
process.on('exit', shutdown);

connect();
