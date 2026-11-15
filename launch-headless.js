// 无窗口常驻 Chrome 启动器
// --headless=new：不生成任何可见窗口，但仍是完整渲染进程，可播 H.264
// --user-agent：抹掉 UA 里的 HeadlessChrome 标记
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const net = require('net');

const ROOT = __dirname;
const PROFILE = process.env.SDLPA_PROFILE || path.join(ROOT, 'data', 'profile');
const PORT = Number(process.env.SDLPA_PORT || 9222);
const plat = require('./platform');
const CHROME = plat.findChrome();
if (!CHROME) {
  console.error('[launch] 找不到 Chrome / Chromium。装一个，或设环境变量 SDLPA_CHROME 指向可执行文件');
  process.exit(1);
}
const LOG = path.join(ROOT, 'data', 'chrome.log');

// 与真 Chrome 完全一致的 UA，不含 HeadlessChrome。
// 平台要跟着跑的系统走，否则 Linux 上报 Windows UA 本身就是一条破绽。
const UA = process.env.SDLPA_UA || (plat.IS_WIN
  ? 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36'
  : 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36');

const FLAGS = [
  '--headless=new',
  `--user-data-dir=${PROFILE}`,
  `--remote-debugging-port=${PORT}`,
  '--remote-allow-origins=*',
  `--user-agent=${UA}`,
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-gpu',
  '--mute-audio',
  '--disable-dev-shm-usage',
  // 后台不降频，保证 1 秒计时器与视频解码不被打断
  '--disable-background-timer-throttling',
  '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',
  '--disable-ipc-flooding-protection',
  '--disable-features=CalculateNativeWinOcclusion,Translate,MediaRouter,OptimizationHints',
  '--autoplay-policy=no-user-gesture-required',
  '--disable-component-update',
  // Linux 上以 root 跑必须加，否则 chrome 直接拒绝启动
  ...(plat.IS_LINUX ? ['--no-sandbox', '--disable-setuid-sandbox'] : []),
  '--disable-session-crashed-bubble',
  '--window-size=1366,900',
  'about:blank',
];

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

function logline(m) {
  try {
    fs.mkdirSync(path.join(ROOT, 'data'), { recursive: true });
    fs.appendFileSync(LOG, `[${new Date().toISOString()}] ${m}\n`);
  } catch (e) {}
}

(async () => {
  if (await portOpen(PORT)) {
    logline(`port ${PORT} 已在监听，复用现有实例`);
    console.log(`[launch] port ${PORT} already open, reuse`);
    return;
  }
  fs.mkdirSync(PROFILE, { recursive: true });
  const child = spawn(CHROME, FLAGS, { detached: true, stdio: 'ignore', windowsHide: true });
  child.unref();
  logline(`spawned chrome pid=${child.pid} port=${PORT}`);
  console.log(`[launch] chrome pid ${child.pid} on ${PORT} (headless, no window)`);

  for (let i = 0; i < 60; i++) {
    if (await portOpen(PORT)) { console.log('[launch] ready'); return; }
    await new Promise((r) => setTimeout(r, 500));
  }
  logline('chrome 启动超时');
  console.error('[launch] timeout');
  process.exit(1);
})();
