// 极简本地服务：把「看板需要的那几个文件」挂到 http://127.0.0.1:8765
//
// 这个服务会被内网穿透工具接到公网上去，所以按白名单放行：
// 只给 peek.html / now.png / status.json / checkin.png 这几个，
// 其余一律 404。曾经的做法是整目录静态挂载，等于把 data/profile 下
// 整个 Chrome 用户资料（Local State 里的密钥、History、Cookies）全暴露出去。
//
// 另外两个防护：
//  - 端口默认只监听 127.0.0.1，不对外网卡开放
//  - 如果设了 SDLPA_TOKEN 环境变量，所有请求都要带 ?k=<token> 或 cookie
//
// 用途 2：接收「暂停 / 继续」两个按钮的 POST，落成 data/PAUSED 标记文件。
// 注意：走隧道进来的请求 remoteAddress 也是 127.0.0.1，
// 所以本机判断挡不住公网来客，写操作必须靠 token 保护。
const http = require('http');
const fs = require('fs');
const path = require('path');
const loginAgent = require('./login-agent');

const ROOT = __dirname;
const DATA = path.join(ROOT, 'data');
const PORT = Number(process.env.SDLPA_MIRROR_PORT || 8765);
const BIND = process.env.SDLPA_BIND || '127.0.0.1';

// 访问口令。一旦这个服务被穿透到公网，就必须有口令，
// 否则任何拿到网址的人都能看你的学员信息、也能点「暂停」把课停掉。
// 优先级：环境变量 > data/access-token.txt（首次运行自动生成）。
function loadToken() {
  const env = (process.env.SDLPA_TOKEN || '').trim();
  if (env) return env;
  const f = path.join(DATA, 'access-token.txt');
  try {
    const t = fs.readFileSync(f, 'utf8').trim();
    if (t) return t;
  } catch (e) {}
  const t = require('crypto').randomBytes(9).toString('base64url');   // 12 位，手打不痛苦
  try { fs.mkdirSync(DATA, { recursive: true }); fs.writeFileSync(f, t + '\n'); } catch (e) {}
  return t;
}
const TOKEN = loadToken();
const PAUSE_FLAG = path.join(DATA, 'PAUSED');

// 白名单：URL 路径 → 磁盘文件。不在这张表里的一律 404，不做任何目录拼接。
const ALLOW = {
  '/': path.join(ROOT, 'peek.html'),
  '/peek.html': path.join(ROOT, 'peek.html'),
  '/now.png': path.join(DATA, 'now.png'),
  '/status.json': path.join(DATA, 'status.json'),
  '/checkin.png': path.join(DATA, 'checkin.png'),
  // 兼容 peek.html 早先写的 data/xxx 相对路径（缓存里的旧页面仍会这么请求）
  '/data/now.png': path.join(DATA, 'now.png'),
  '/data/status.json': path.join(DATA, 'status.json'),
  '/data/checkin.png': path.join(DATA, 'checkin.png'),
};
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.png': 'image/png',
  '.json': 'application/json; charset=utf-8',
};

// 读 POST body（登录表单要把密码送到本机服务上）。
// 限 32KB，正常表单远到不了。
function readBody(req) {
  return new Promise((resolve, reject) => {
    let n = 0;
    const chunks = [];
    req.on('data', (c) => {
      n += c.length;
      if (n > 32768) { reject(new Error('body 太大')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function json(res, code, obj) {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(obj));
}

function plain(res, code, msg) {
  res.writeHead(code, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
  res.end(msg);
}

// 口令校验。本地直连（127.0.0.1）放行，从隧道进来的必须带口令。
// 怎么区分？看 Host 头和 X-Forwarded-For：
//   - 本机浏览器访问 → Host: 127.0.0.1:8765，没有 XFF
//   - 经 ngrok/cloudflared 进来 → Host 是公网域名，且带 XFF
// 光靠 remoteAddress 不行，隧道转发的请求源地址也是 127.0.0.1。
function isLocal(req) {
  if (req.headers['x-forwarded-for'] || req.headers['x-real-ip']) return false;
  const host = String(req.headers.host || '').replace(/:\d+$/, '').toLowerCase();
  return host === '127.0.0.1' || host === 'localhost' || host === '[::1]' || host === '::1';
}

function authorized(req, q) {
  if (isLocal(req)) return true;
  if (q.get('k') === TOKEN) return true;
  const ck = req.headers.cookie || '';
  return ck.split(/;\s*/).some((s) => s === 'sdlpa_k=' + TOKEN);
}

http.createServer(async (req, res) => {
  const u = new URL(req.url || '/', 'http://x');
  const url = u.pathname;

  if (!authorized(req, u.searchParams)) {
    return plain(res, 401, '需要访问口令：在本页地址后面加 ?k=<口令>\n\n口令在 sdlpa\\data\\access-token.txt');
  }
  // 口令正确就种成 cookie，之后刷新页面不用一直带参数
  if (u.searchParams.get('k') === TOKEN) {
    res.setHeader('set-cookie', `sdlpa_k=${TOKEN}; Path=/; Max-Age=31536000; SameSite=Lax`);
  }

  // ---- 远程登录接口 ----
  // 这几个是这次新加的：以前登录只能在跑 daemon 的那台机器的桌面上开窗口，
  // 现在把登录页的验证码抠出来发到网页上，人在哪都能填。
  if (url.startsWith('/api/login')) {
    try {
      if (url === '/api/login/captcha') {
        const r = await loginAgent.getCaptcha();
        return json(res, 200, r);
      }
      if (url === '/api/login/status') {
        return json(res, 200, { ok: true, state: loginAgent.status() });
      }
      if (url === '/api/login/submit') {
        if (req.method !== 'POST') return json(res, 405, { ok: false, msg: '只用 POST' });
        const raw = await readBody(req);
        let body = {};
        try { body = JSON.parse(raw || '{}'); } catch (e) { return json(res, 400, { ok: false, msg: 'body 不是 JSON' }); }
        const r = await loginAgent.submit({
          user: String(body.user || '').trim(),
          pass: String(body.pass || ''),
          code: String(body.code || '').trim(),
        });
        if (r.ok) {
          // 登录成功后把还在跑旧 token 的 runner 踢掉，让 daemon 用新 cookie 重开
          const kicked = await loginAgent.kickRunner();
          r.kicked = kicked;
        }
        return json(res, 200, r);
      }
      return json(res, 404, { ok: false, msg: '没有：' + url });
    } catch (e) {
      return json(res, 500, { ok: false, msg: e.message });
    }
  }

  // ---- 控制接口 ----
  if (url === '/api/pause' || url === '/api/resume' || url === '/api/state') {
    if (url === '/api/state') {
      return json(res, 200, { ok: true, paused: fs.existsSync(PAUSE_FLAG) });
    }
    // 写操作：非本机来的必须有口令（上面 authorized 已经挡过一道，这里再确认一次）
    if (!isLocal(req) && !TOKEN) {
      return json(res, 403, { ok: false, msg: 'remote control disabled' });
    }
    try {
      if (url === '/api/pause') {
        fs.mkdirSync(DATA, { recursive: true });
        fs.writeFileSync(PAUSE_FLAG, new Date().toLocaleString('zh-CN', { hour12: false }));
        return json(res, 200, { ok: true, paused: true });
      }
      fs.rmSync(PAUSE_FLAG, { force: true });
      return json(res, 200, { ok: true, paused: false });
    } catch (e) {
      return json(res, 500, { ok: false, msg: e.message });
    }
  }

  // ---- 白名单静态文件 ----
  const file = ALLOW[url];
  if (!file) return plain(res, 404, '没有：' + url);
  // 有人看截图 = 记一笔，watch.js 据此从 3 分钟一张切回 15 秒一张
  if (url === '/now.png') {
    try { fs.writeFileSync(path.join(DATA, 'last-view'), String(Date.now())); } catch (e) {}
  }
  fs.readFile(file, (err, buf) => {
    if (err) return plain(res, 404, '还没生成：' + path.basename(file));
    res.writeHead(200, {
      'content-type': MIME[path.extname(file)] || 'application/octet-stream',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    });
    res.end(buf);
  });
}).listen(PORT, BIND, () => {
  console.log(`mirror on http://${BIND}:${PORT}/peek.html` + (TOKEN ? '  (需要口令)' : ''));
});
