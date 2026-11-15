// 登录态持久化：把可见窗口里登录后的 cookie 存到 data/session.json，
// 无头 Chrome 每次启动时再注回去。
// 为什么要这个：平台的 jwtToken 是「会话 cookie」（没有 expires），
// Chrome 只把带过期时间的 cookie 落到磁盘，所以换个进程就丢，
// 只能靠我们自己导出/导入。
const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, 'data', 'session.json');

function save(cookies) {
  const keep = (cookies || []).filter((c) => /(^|\.)sdlpa\.org\.cn$/.test(c.domain || ''));
  const data = { at: new Date().toISOString(), cookies: keep };
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(data));
  return keep.length;
}

function load() {
  try {
    const j = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    if (!j || !Array.isArray(j.cookies) || !j.cookies.length) return null;
    return j;
  } catch (e) {
    return null;
  }
}

// 还剩多少毫秒过期（取 jwtToken_Refresh，没有就取 jwtToken）
function expiresIn() {
  const j = load();
  if (!j) return null;
  const pick = j.cookies.find((c) => c.name === 'jwtToken_Refresh')
    || j.cookies.find((c) => c.name === 'jwtToken');
  if (!pick || typeof pick.expires !== 'number' || pick.expires <= 0) return null;
  return pick.expires * 1000 - Date.now();
}

// 登录态是不是已经死了（连 refresh token 都过期）
function isDead() {
  const left = expiresIn();
  return left !== null && left <= 0;
}

function hasToken(j) {
  return !!(j && j.cookies && j.cookies.some((c) => c.name === 'jwtToken' && c.value));
}

// 把存下来的 cookie 注给一个 CDP context，返回注入了多少个
async function importInto(ctx) {
  const j = load();
  if (!hasToken(j)) return 0;
  // 过期的 cookie 注进去只会让页面反复跳登录，干脆不注
  const now = Date.now() / 1000;
  const alive = j.cookies.filter((c) => !(typeof c.expires === 'number' && c.expires > 0 && c.expires < now));
  if (!alive.some((c) => c.name === 'jwtToken')) return 0;
  const list = alive.map((c) => ({
    name: c.name,
    value: c.value,
    domain: c.domain,
    path: c.path || '/',
    expires: typeof c.expires === 'number' ? c.expires : -1,
    httpOnly: !!c.httpOnly,
    secure: !!c.secure,
    sameSite: c.sameSite || 'Lax',
  }));
  await ctx.addCookies(list);
  return list.length;
}

module.exports = { save, load, hasToken, importInto, expiresIn, isDead, FILE };
