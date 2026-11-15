// 网页端远程登录：把无头 Chrome 里的登录页当成一个「表单接口」用。
//
// 为什么这样做：之前登录必须开一个有头窗口，人得坐在那台机器的桌面前。
// 其实不需要——登录页的验证码是张 data:image/png 的图，
// 只要把它抠出来给网页，人在哪都能填。
//
// 对外三个动作：
//   getCaptcha()                 打开（或复用）登录页，返回验证码图 + 当前状态
//   submit({ user, pass, code }) 填表、提交、判定结果；成功则导出 cookie
//   status()                     只看当前登录态，不碰页面
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const DATA = path.join(ROOT, 'data');
const CDP = `http://127.0.0.1:${process.env.SDLPA_PORT || 9222}`;
const LOGIN_URL = 'https://user.sdlpa.org.cn/login';
const TRAIN_URL = `https://sdu.sdlpa.org.cn/train?traineeid=${process.env.SDLPA_TRAINEE || 0}`;

const sessionStore = require('./session-store');

function pw() { return require('playwright-core'); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 连 CDP。Chrome 冷启动要几十秒（尤其是服务刚重启时），
// 直接连会 ECONNREFUSED。这里等到超时为止，而不是一上来就报错
// ——网页上看到「连不上」就以为坏了，其实只是还没起来。
async function withBrowser(fn) {
  const { chromium } = pw();
  let lastErr = null;
  for (let i = 0; i < 40; i++) {
    try {
      const b = await chromium.connectOverCDP(CDP);
      try {
        return await fn(b.contexts()[0]);
      } finally {
        await b.close().catch(() => {});
      }
    } catch (e) {
      lastErr = e;
      // 只有「连不上」才重试；业务逻辑抛的错要原样往上抛
      if (!/ECONNREFUSED|connectOverCDP|Target page|browser has been closed/i.test(e.message)) throw e;
      await sleep(2000);
    }
  }
  throw new Error('后台 Chrome 还没起来（等了 80 秒）。等一两分钟再试，或看 daemon 日志。');
}

// 找登录页：优先复用已有页签，没有就开一个。
// 返回 { page, redirected }  redirected=true 表示当前其实已登录（被踢回首页了）
async function openLoginPage(ctx) {
  let page = ctx.pages().find((p) => /user\.sdlpa\.org\.cn\/login/.test(p.url()));
  if (!page) {
    page = await ctx.newPage();
    await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
  } else {
    await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
  }
  await page.waitForTimeout(1500);
  const redirected = !/\/login/.test(page.url());
  return { page, redirected };
}

// 验证码是页面上唯一一张 data:image/png 的图
async function readCaptcha(page) {
  return page.evaluate(() => {
    const img = [...document.querySelectorAll('img')].find((e) => (e.src || '').startsWith('data:image'));
    if (!img) return null;
    return { src: img.src, w: img.width, h: img.height };
  });
}

// 「保持登录状态」拉到最长档。默认只给 1 天，30 天能少折腾很多次。
// Element Plus 新版下拉：当前值在 .el-select__placeholder，点 .el-select__wrapper 展开。
async function setKeepLongest(page) {
  const WANT = ['1月', '2周', '1周'];
  const readCur = () => page.evaluate(() => {
    const el = document.querySelector('.el-select__placeholder');
    return el ? el.innerText.trim() : '';
  }).catch(() => '');
  try {
    const cur = await readCur();
    if (WANT.includes(cur)) return cur;
    await page.locator('.el-select__wrapper').first().click({ timeout: 5000 });
    await page.waitForTimeout(600);
    for (const w of WANT) {
      const opt = page.locator('.el-select-dropdown__item', { hasText: w }).first();
      if (await opt.count().catch(() => 0)) {
        await opt.click({ timeout: 5000 });
        await page.waitForTimeout(350);
        break;
      }
    }
    return await readCur();
  } catch (e) {
    return '';
  }
}

function loginState() {
  const left = sessionStore.expiresIn();
  let dead = false;
  try { dead = sessionStore.isDead(); } catch (e) {}
  return {
    loggedIn: !dead && left !== null && left > 0,
    expiresIn: left,
    expiresInDays: left === null ? null : +(left / 86400000).toFixed(2),
    hasStore: !!sessionStore.load(),
    needLogin: fs.existsSync(path.join(DATA, 'NEED_LOGIN')),
  };
}

async function getCaptcha() {
  return withBrowser(async (ctx) => {
    const { page, redirected } = await openLoginPage(ctx);
    if (redirected) {
      // 已经登录着，不用验证码
      return { ok: true, already: true, state: loginState() };
    }
    const keep = await setKeepLongest(page);
    const cap = await readCaptcha(page);
    if (!cap) throw new Error('页面上找不到验证码图片，登录页结构可能变了');
    // 顺手把账号框里已填的内容带回去，省得每次重打
    const prefillUser = await page.evaluate(() => {
      const i = document.querySelector('input[placeholder*="身份证"], input[placeholder*="用户名"]');
      return i ? i.value : '';
    }).catch(() => '');
    return { ok: true, captcha: cap.src, keep, prefillUser, state: loginState() };
  });
}

// 点一下验证码图刷新。验证码错了要换一张，否则永远是同一张。
async function refreshCaptcha(page) {
  await page.evaluate(() => {
    const img = [...document.querySelectorAll('img')].find((e) => (e.src || '').startsWith('data:image'));
    if (img) img.click();
  }).catch(() => {});
  await page.waitForTimeout(1200);
  return readCaptcha(page);
}

async function submit({ user, pass, code }) {
  if (!user || !pass || !code) throw new Error('账号 / 密码 / 验证码都要填');

  return withBrowser(async (ctx) => {
    const { page, redirected } = await openLoginPage(ctx);
    if (redirected) return { ok: true, already: true, state: loginState() };

    await setKeepLongest(page);

    // 按 placeholder 定位，比按下标稳
    const fill = async (sel, val) => {
      const el = page.locator(sel).first();
      if (!(await el.count())) throw new Error('找不到输入框：' + sel);
      await el.click({ timeout: 8000 });
      await el.fill('');
      await el.fill(val);
    };
    try {
      await fill('input[placeholder*="身份证"], input[placeholder*="用户名"]', user);
      await fill('input[type="password"]', pass);
      // 验证码框没有 placeholder，只能按位置找：
      // 页面上可见的 text input 里，x 最靠右的那个就是它。
      // 打一个临时属性上去再交给 playwright 填，比 last() 稳
      // （last() 会选到 checkbox 之类隐藏元素，之前就是这么踩坑的）。
      const tagged = await page.evaluate(() => {
        const cands = [...document.querySelectorAll('input')]
          .filter((e) => (e.type === 'text' || e.type === 'tel' || e.type === '') && e.getBoundingClientRect().width > 40);
        if (!cands.length) return false;
        cands.sort((a, b) => b.getBoundingClientRect().x - a.getBoundingClientRect().x);
        cands.forEach((e) => e.removeAttribute('data-sdlpa-code'));
        cands[0].setAttribute('data-sdlpa-code', '1');
        return true;
      });
      if (!tagged) throw new Error('找不到验证码输入框');
      const codeBox = page.locator('input[data-sdlpa-code="1"]').first();
      await codeBox.click({ timeout: 8000 });
      await codeBox.fill(code);
    } catch (e) {
      throw new Error('填写表单失败：' + e.message);
    }

    // 提交
    const btn = page.locator('button.el-button--primary').filter({ hasText: '登录' }).first();
    if (!(await btn.count())) throw new Error('找不到「登录」按钮');
    await btn.click({ timeout: 8000 });

    // 等结果：最多 20 秒，看 cookie 或 URL
    const start = Date.now();
    let outcome = null;
    while (Date.now() - start < 20000) {
      await sleep(800);
      const url = page.url();
      if (!/\/login/.test(url)) { outcome = 'ok'; break; }
      const err = await page.evaluate(() => {
        const t = document.body.innerText || '';
        const m = t.match(/(验证码[^\n]{0,20}|密码[^\n]{0,16}错误|账号[^\n]{0,16}错误|用户不存在)/);
        return m ? m[0].trim() : '';
      }).catch(() => '');
      if (err) { outcome = err; break; }
    }

    if (outcome === 'ok') {
      const cs = await ctx.cookies();
      const n = sessionStore.save(cs);
      // 清掉阻塞标记，让 daemon 下一轮把 runner 拉起来
      for (const f of ['NEED_LOGIN', 'NEED_MANUAL']) {
        try { fs.rmSync(path.join(DATA, f), { force: true }); } catch (e) {}
      }
      const left = sessionStore.expiresIn();
      return {
        ok: true,
        saved: n,
        expiresInDays: left === null ? null : +(left / 86400000).toFixed(2),
        state: loginState(),
      };
    }

    // 失败：换一张验证码，让用户直接重试
    const cap = await refreshCaptcha(page).catch(() => null);
    return {
      ok: false,
      msg: outcome && outcome !== 'ok' ? outcome : '登录没成功，可能是验证码过期，换一张再试',
      captcha: cap ? cap.src : null,
      state: loginState(),
    };
  });
}

// 登录成功后杀掉旧 runner，让 daemon 用新登录态重新起一轮。
// 不杀的话，正在跑的那个还揣着旧 token 的页面，要等它自己撞墙。
async function kickRunner() {
  try {
    const plat = require('./platform');
    let n = 0;
    for (const p of plat.listNodeProcs('sdlpa')) {
      const cmd = (p.cmd || '') || '';
      if (/runner\.js/.test(cmd)) { plat.killPid(p.pid); n++; }
    }
    try { fs.rmSync(path.join(DATA, 'runner.lock'), { force: true }); } catch (e) {}
    return n;
  } catch (e) {
    return 0;
  }
}

module.exports = { getCaptcha, submit, status: loginState, kickRunner };
