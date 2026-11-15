// 重新登录：停后台 → 开一个看得见窗口的 Chrome（同一个 profile）→ 你手动登录 → 自动切回无头后台
//
// 为什么要这样：后台跑的是无窗口 Chrome，用 data/profile 这个用户目录。
// 登录态（jwtToken / jwtToken_Refresh）过期后，只能由人在这同一个 profile 里重新登一次。
// 用你自己平时的浏览器登录没用——那是另一个 profile，cookie 不共享。
//
// 用法：
//   node relogin.js            停后台 + 开窗口 + 等登录（成功后自动恢复后台）
//   node relogin.js --window   只开窗口，不自动切回
//
// 没有图形界面的服务器上：用 ssh -X 连过去再跑，或者把 data/profile 整个拷到
// 有桌面的机器上登录完再拷回来（profile 里有 cookie，别外传）。
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const net = require('net');
const plat = require('./platform');
const sessionStore = require('./session-store');

const ROOT = __dirname;
const DATA = path.join(ROOT, 'data');
const PROFILE = path.join(DATA, 'profile');
const PORT = 9222;
const TRAINEE = process.env.SDLPA_TRAINEE || '0';
const URL_TRAIN = `https://sdu.sdlpa.org.cn/train?traineeid=${TRAINEE}`;
const CHROME = plat.findChrome();

function log(...a) { console.log(`[${new Date().toLocaleTimeString('zh-CN', { hour12: false })}] ${a.join(' ')}`); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function portOpen(port) {
  return new Promise((res) => {
    const s = net.connect(port, '127.0.0.1');
    s.setTimeout(800);
    s.on('connect', () => { s.destroy(); res(true); });
    s.on('error', () => res(false));
    s.on('timeout', () => { s.destroy(); res(false); });
  });
}

function runQuiet(cmd, args) {
  try { execFileSync(cmd, args, { stdio: 'ignore', windowsHide: true }); return true; } catch (e) { return false; }
}

// 停 daemon / runner / 看板等全部后台进程（排除自己）
async function stopAll() {
  log('停掉后台服务与进程…');
  if (plat.IS_WIN) {
    runQuiet('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
      ['-NoProfile', '-Command', 'Stop-ScheduledTask -TaskName SDLPAAutoLearn -ErrorAction SilentlyContinue']);
    runQuiet('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
      ['-NoProfile', '-Command',
        `Get-CimInstance Win32_Process -Filter "name='node.exe'" | Where-Object { $_.CommandLine -like '*sdlpa*' -and $_.ProcessId -ne ${process.pid} } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`]);
  } else {
    // Linux：先停 systemd 服务（会带走整组子进程），再清残留
    runQuiet('systemctl', ['--user', 'stop', 'sdlpa.service']);
    for (const p of plat.listNodeProcs('sdlpa')) {
      if (p.pid !== process.pid) plat.killPid(p.pid);
    }
  }
  await sleep(1800);
  await plat.killChrome(PROFILE);
  await sleep(2500);
}

async function launchWindow() {
  if (!CHROME) { log('找不到 Chrome/Chromium，设 SDLPA_CHROME 指过去'); process.exit(1); }
  if (await portOpen(PORT)) {
    log('9222 还被占着，先清掉');
    await plat.killChrome(PROFILE);
    await sleep(2000);
  }
  fs.mkdirSync(PROFILE, { recursive: true });
  log('打开可见窗口，用同一个 profile…');
  const child = spawn(CHROME, [
    '--user-data-dir=' + PROFILE,
    '--remote-debugging-port=' + PORT,
    '--remote-allow-origins=*',
    '--no-first-run',
    '--no-default-browser-check',
    '--autoplay-policy=no-user-gesture-required',
    ...(plat.IS_LINUX ? ['--no-sandbox', '--disable-setuid-sandbox'] : []),
    URL_TRAIN,
  ], { detached: true, stdio: 'ignore' });
  child.unref();
  await sleep(4500);
}

// 清掉 profile 里现有的登录 cookie，强制走一次真正的登录。
// 不清的话：profile 里还有昨天那份没过期的 jwtToken，
// 窗口一开就被判定「已登录」，直接关窗退出——等于白开一次。
async function forceLoggedOut() {
  const { chromium } = require('playwright-core');
  try {
    const b = await chromium.connectOverCDP('http://127.0.0.1:' + PORT);
    const ctx = b.contexts()[0];
    await ctx.clearCookies();
    const page = ctx.pages()[0];
    if (page) await page.goto(URL_TRAIN, { waitUntil: 'domcontentloaded' }).catch(() => {});
    log('已清掉旧登录 cookie，这次必须重新输入账号密码');
    await b.close().catch(() => {});
    return true;
  } catch (e) {
    log('清 cookie 失败（继续，但可能被误判已登录）: ' + e.message);
    return false;
  }
}

// 把「保持登录状态」下拉设到最长档（1月）。
// 平台默认只有「1天」，也就是 jwtToken_Refresh 只有 24 小时——
// 这就是之前每天都要重登一次的原因。选「1月」能撑 30 天。
async function presetKeepLongest() {
  const { chromium } = require('playwright-core');
  const WANT = ['1月', '2周', '1周'];
  try {
    const b = await chromium.connectOverCDP('http://127.0.0.1:' + PORT);
    const ctx = b.contexts()[0];
    let page = ctx.pages().find((p) => /sdlpa\.org\.cn/.test(p.url()));
    if (!page) page = ctx.pages()[0];
    if (!page || !/\/login/.test(page.url())) return false;

    // Element Plus 新版下拉：当前值在 .el-select__placeholder，点 .el-select__wrapper 展开
    const readCur = () => page.evaluate(() => {
      const el = document.querySelector('.el-select__placeholder');
      return el ? el.innerText.trim() : '';
    }).catch(() => '');

    const cur = await readCur();
    if (WANT.includes(cur)) return true;

    await page.locator('.el-select__wrapper').first().click();
    await page.waitForTimeout(800);
    let picked = '';
    for (const w of WANT) {
      const opt = page.locator('.el-select-dropdown__item', { hasText: w }).first();
      if (await opt.count().catch(() => 0)) {
        await opt.click();
        await page.waitForTimeout(400);
        picked = w;
        break;
      }
    }
    if (!picked) return false;

    const after = await readCur();
    if (after === picked) {
      log(`已把「保持登录状态」设为「${after}」（平台默认只有 1 天）`);
      return true;
    }
    log(`设置「${picked}」没生效，当前仍是「${after || '空'}」`);
    return false;
  } catch (e) {
    log('设置保持登录时长失败（你可以自己在窗口里点下拉选「1月」）: ' + e.message);
    return false;
  }
}

// 轮询判断有没有登录成功：cookie 里出现 jwtToken，且页面不再是 /login
async function waitLogin(timeoutMs = 90 * 60 * 1000) {
  const { chromium } = require('playwright-core');
  const start = Date.now();
  let lastNote = 0;
  let presetAt = 0;
  while (Date.now() - start < timeoutMs) {
    await sleep(3000);
    // 每 15 秒确认一次「保持登录状态」还是最长档：
    // 页面在登录过程中可能重载，下拉会回落到默认的「1天」，
    // 只在开头设一次是不够的（上次就是这么丢的）。
    if (Date.now() - presetAt > 15000) {
      presetAt = Date.now();
      await presetKeepLongest();
    }
    try {
      const b = await chromium.connectOverCDP('http://127.0.0.1:' + PORT);
      const ctx = b.contexts()[0];
      const cs = await ctx.cookies();
      const tok = cs.find((c) => c.name === 'jwtToken');
      const page = ctx.pages().find((p) => /sdlpa\.org\.cn/.test(p.url()));
      const onLoginPage = page ? /\/login/.test(page.url()) : true;

      if (tok && !onLoginPage) {
        const ok = await page.evaluate(() => !!(sessionStorage.getItem('user_info') || sessionStorage.getItem('device-id'))).catch(() => false);
        log(`检测到登录态：jwtToken 长度 ${tok.value.length}` + (ok ? '，sessionStorage 正常' : ''));
        // 关键：jwtToken 是会话 cookie，Chrome 不会落盘，
        // 所以这里主动导出到 data/session.json，供无头实例启动时注入。
        const saved = sessionStore.save(cs);
        log(`已导出登录态 ${saved} 条 cookie → data/session.json`);
        // 验证「保持登录状态」到底有没有生效：
        // 选「1天」时 refresh token 的 exp 是 24 小时后，选「1月」应该是 30 天。
        // 如果这里还是 1 天出头，说明下拉框被重置了，得提醒重登一次。
        const left = sessionStore.expiresIn();
        if (left !== null) {
          const days = left / 86400000;
          if (days < 25) {
            log(`⚠ 保持登录只拿到 ${days.toFixed(1)} 天，不是 30 天——下拉框可能被重置了`);
            log('⚠ 这一轮会在到期时中断，到期后需再登一次');
          } else {
            log(`✔ 保持登录 ${days.toFixed(1)} 天，够跑完全部课程`);
          }
        }
        return true;
      }
      if (Date.now() - lastNote > 60000) {
        log('还没登录…请在弹出的浏览器窗口里完成登录（记得选对学员/单位）');
        lastNote = Date.now();
      }
    } catch (e) {
      if (Date.now() - lastNote > 60000) { log('等窗口就绪…'); lastNote = Date.now(); }
    }
  }
  return false;
}

async function backToHeadless() {
  log('关掉可见窗口…');
  await plat.killChrome(PROFILE);
  await sleep(3000);
  // 清掉阻塞标记，让 daemon 正常往下走
  for (const f of ['NEED_LOGIN', 'NEED_MANUAL', 'ALL_DONE']) {
    try { fs.rmSync(path.join(DATA, f), { force: true }); } catch (e) {}
  }
  log('重新拉起后台…');
  if (plat.IS_WIN) {
    runQuiet('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
      ['-NoProfile', '-Command', 'Start-ScheduledTask -TaskName SDLPAAutoLearn']);
  } else {
    runQuiet('systemctl', ['--user', 'start', 'sdlpa.service']);
  }
  await sleep(15000);
  log('后台已拉起。用 node run-status.js 看进度，或打开看板确认。');
}

(async () => {
  const onlyWindow = process.argv.includes('--window');

  await stopAll();
  await launchWindow();
  // 只在等登录之前清一次，保证真的重登
  if (!onlyWindow) await forceLoggedOut();

  log('');
  log('========== 请在弹出的 Chrome 窗口里完成登录 ==========');
  log('登录后要能进到课程列表页（看到课程条目即可）');
  log('如果页面停在登录页，直接在那里输账号密码就行');
  log('===================================================');
  log('');

  const ok = await waitLogin();
  if (!ok) {
    log('等了 90 分钟没检测到登录，窗口留着；登好后再跑一次 node relogin.js');
    process.exit(2);
  }

  if (onlyWindow) { log('登录成功。窗口留着（--window 模式），你自己处理完手动重启服务'); process.exit(0); }

  await backToHeadless();
  process.exit(0);
})();
