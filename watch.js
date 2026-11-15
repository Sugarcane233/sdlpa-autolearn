// 只读旁观：定时把后台实例的画面截到 data/now.png
// 不碰播放器、不点任何东西，纯截图。
//
// 关于频率：截图一张约 450 KB。固定 15 秒一张的话一天就是 2.5 GB ——
// 本地看无所谓，一旦这个页面被映射到公网，免费流量两小时就烧完。
// 所以按「有没有人在看」分两档：
//   - 最近 3 分钟内有人取过图 → 15 秒一张（实况）
//   - 没人看 → 3 分钟一张（省流量）
//
// 心跳是 5 秒一次（很轻，不截图），每次心跳判断「该不该拍」。
// 这样你刚打开页面，最多 5 秒内就会补一张新的，不用干等 3 分钟。
const { chromium } = require('playwright-core');
const fs = require('fs'), path = require('path');
const DATA = path.join(__dirname, 'data');
const OUT = path.join(DATA, 'now.png');
const VIEWED = path.join(DATA, 'last-view');
const BEAT = Number(process.env.SDLPA_BEAT_MS || 5000);        // 心跳间隔
const EVERY = Number(process.env.SDLPA_SHOT_MS || 15000);      // 有人在看时的截图间隔
const IDLE_EVERY = Number(process.env.SDLPA_SHOT_IDLE_MS || 180000);  // 没人看时的间隔
const ACTIVE_WINDOW = Number(process.env.SDLPA_SHOT_ACTIVE_MS || 180000);

function mtimeAgo(p) {
  try { return Date.now() - fs.statSync(p).mtimeMs; } catch (e) { return Infinity; }
}

let lastShotAt = 0;
let lastLog = '';

async function shoot(logActive) {
  let b;
  try {
    b = await chromium.connectOverCDP('http://127.0.0.1:' + (process.env.SDLPA_PORT || 9222));
    const ctx = b.contexts()[0];
    // 选页顺序要稳住：登录页/about:blank 一律不截，
    // 否则 runner 重启的间隙会截到白页，看板上就成了「无视频播放」。
    const pages = ctx.pages();
    const ok = (p) => /sdlpa\.org\.cn\/(learn|train|exam)/.test(p.url()) && !/\/login/.test(p.url());
    let page = pages.find(ok);
    if (!page) {
      // 退一步：找真正挂着 <video> 的页
      for (const p of pages) {
        const has = await p.evaluate(() => !!document.querySelector('video')).catch(() => false);
        if (has) { page = p; break; }
      }
    }
    if (!page) return '当前没有正在播放的页面';
    if (!page) return '没有可截的页面';
    const tmp = path.join(DATA, 'now.tmp.png');
    await page.screenshot({ path: tmp, type: 'png' });
    fs.renameSync(tmp, OUT);          // 原子替换，查看器不会读到半张图
    const st = await page.evaluate(() => {
      const v = document.querySelector('video');
      return {
        page: document.querySelector('.cw-title.cw-selected')?.innerText?.replace(/\n/g, ' ') || location.pathname,
        pos: v ? `${Math.floor(v.currentTime / 60)}:${String(Math.floor(v.currentTime % 60)).padStart(2, '0')} / ${Math.floor((v.duration || 0) / 60)}:${String(Math.floor((v.duration || 0) % 60)).padStart(2, '0')}` : '-',
        playing: v ? !v.paused : null,
      };
    });
    fs.writeFileSync(path.join(DATA, 'now.json'), JSON.stringify({ at: new Date().toLocaleTimeString('zh-CN', { hour12: false }), ...st }));
    const line = `[${new Date().toLocaleTimeString('zh-CN', { hour12: false })}] ${st.page} ${st.pos} ${st.playing ? '播放中' : '暂停'}${logActive ? '' : '（无人看，降频）'}`;
    if (line.slice(11) !== lastLog) { console.log(line); lastLog = line.slice(11); }
    return line;
  } catch (e) {
    const msg = '连不上后台 Chrome：' + e.message;
    console.log(`[${new Date().toLocaleTimeString('zh-CN', { hour12: false })}] ${msg}`);
    return msg;
  }
}

(async () => {
  const one = process.argv.includes('--once');
  if (one) { await shoot(true); process.exit(0); }

  while (true) {
    const idle = mtimeAgo(VIEWED);
    const active = idle < ACTIVE_WINDOW;
    const gap = active ? EVERY : IDLE_EVERY;
    // 上次截图到现在够久了，或者文件根本不存在（刚启动 / 被删），就拍一张
    const needShot = Date.now() - lastShotAt >= gap || mtimeAgo(OUT) > gap;
    if (needShot) {
      lastShotAt = Date.now();
      await shoot(active);
    }
    await new Promise(r => setTimeout(r, BEAT));
  }
})();
