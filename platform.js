// 跨平台适配层：把 Windows / Linux 的差异全部收在这里，
// 其他脚本只调这里的函数，不再自己拼 powershell 或写死 exe 路径。
//
// 支持的差异点：
//   1. Chrome 可执行文件路径
//   2. 结束进程（Windows: Get-CimInstance + Stop-Process；Linux: pkill -f）
//   3. 列出 node 进程
//   4. 防睡眠（Windows: SetThreadExecutionState 脚本；Linux: systemd-inhibit 或 caffeinate 类似物）
//   5. 通知（Windows: Toast 脚本；Linux: notify-send）
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const IS_WIN = process.platform === 'win32';
const IS_LINUX = process.platform === 'linux';
const ROOT = __dirname;

// ---------- Chrome ----------
// 候选路径从「最可能」到「最不可能」，第一个存在的就用。
function findChrome() {
  const env = process.env.SDLPA_CHROME;
  if (env && fs.existsSync(env)) return env;

  const cands = IS_WIN ? [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    path.join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    // Playwright 自带的 chromium（如果装过）
    path.join(os.homedir(), 'AppData', 'Local', 'ms-playwright', 'chromium-1', 'chrome-win', 'chrome.exe'),
  ] : [
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/snap/bin/chromium',
    '/usr/bin/microsoft-edge',
    '/opt/google/chrome/chrome',
    // Playwright 的默认位置
    path.join(os.homedir(), '.cache', 'ms-playwright', 'chromium-1', 'chrome-linux', 'chrome'),
    path.join(os.homedir(), '.cache', 'ms-playwright', 'chromium', 'chrome-linux', 'chrome'),
  ];

  for (const c of cands) {
    try { if (c && fs.existsSync(c)) return c; } catch (e) {}
  }
  // 最后试 PATH
  for (const name of ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'chrome']) {
    try {
      const out = execFileSync(IS_WIN ? 'where' : 'which', [name], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
      const first = out.split(/\r?\n/).map((s) => s.trim()).find(Boolean);
      if (first && fs.existsSync(first)) return first;
    } catch (e) {}
  }
  return null;
}

// ---------- 结束进程 ----------
function ps(cmd) {
  if (!IS_WIN) return '';
  try {
    return execFileSync('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
      ['-NoProfile', '-Command', cmd], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
  } catch (e) { return ''; }
}

// 杀掉所有用本项目 profile 的 chrome 进程。
// pattern 默认用 profile 目录名，避免误杀用户自己的浏览器。
function killChrome(profileDir) {
  return new Promise((resolve) => {
    if (IS_WIN) {
      const psCmd = `
        Get-CimInstance Win32_Process -Filter "name='chrome.exe'" |
          Where-Object { $_.CommandLine -like '*sdlpa*profile*' } |
          ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
      `;
      const p = spawn('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
        ['-NoProfile', '-Command', psCmd], { stdio: 'ignore', windowsHide: true });
      p.on('exit', () => resolve(true));
      p.on('error', () => resolve(false));
      return;
    }
    // Linux：按 user-data-dir 精确匹配，不要 pkill chrome 把用户自己的浏览器也杀了
    const pat = profileDir || 'sdlpa';
    const p = spawn('bash', ['-c', `pkill -f -- "--user-data-dir=${pat}" 2>/dev/null; true`],
      { stdio: 'ignore' });
    p.on('exit', () => resolve(true));
    p.on('error', () => resolve(false));
  });
}

// 列出本项目的 node 进程（排除自己）
function listNodeProcs(matchHint) {
  const hint = matchHint || 'sdlpa';
  const out = [];
  try {
    if (IS_WIN) {
      const raw = ps(`Get-CimInstance Win32_Process -Filter "name='node.exe'" | Where-Object { $_.CommandLine -like '*${hint}*' } | ForEach-Object { $_.ProcessId.ToString() + ' ' + $_.CommandLine }`);
      for (const line of String(raw).split(/\r?\n/)) {
        const m = line.trim().match(/^(\d+)\s+(.*)$/);
        if (m) out.push({ pid: Number(m[1]), cmd: m[2] });
      }
      return out;
    }
    // Linux：读 /proc，同样排除自己
    for (const d of fs.readdirSync('/proc')) {
      if (!/^\d+$/.test(d)) continue;
      const pid = Number(d);
      if (pid === process.pid) continue;
      try {
        const cmd = fs.readFileSync(`/proc/${d}/cmdline`, 'utf8').replace(/\0/g, ' ').trim();
        if (cmd.includes('node') && cmd.includes(hint)) out.push({ pid, cmd });
      } catch (e) {}
    }
  } catch (e) {}
  return out;
}

// 结束指定 pid。SIGKILL 兜底。
function killPid(pid) {
  try { process.kill(pid, 'SIGKILL'); return true; } catch (e) { return false; }
}

// ---------- 防睡眠 ----------
// 返回一个子进程句柄；调用方负责在退出时 kill。
// Windows：keepscreen.ps1（SetThreadExecutionState）
// Linux：systemd-inhibit 包一层 sleep infinity，进程活着就抑制空闲休眠
function startSleeper() {
  try {
    if (IS_WIN) {
      const f = path.join(ROOT, 'keepscreen.ps1');
      if (!fs.existsSync(f)) return null;
      return spawn('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
        ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', f],
        { stdio: 'ignore', windowsHide: true });
    }
    // Linux
    const has = (bin) => {
      try { execFileSync('which', [bin], { stdio: 'ignore' }); return true; } catch (e) { return false; }
    };
    if (has('systemd-inhibit')) {
      // --what=idle：阻止空闲休眠，但不阻止用户手动合盖
      return spawn('systemd-inhibit', ['--what=idle', '--why=SDLPA learning runner', '--mode=block', 'sleep', 'infinity'],
        { stdio: 'ignore', detached: false });
    }
    return null;
  } catch (e) { return null; }
}

// ---------- 通知 ----------
function notify(title, body) {
  try {
    if (IS_WIN) return null;   // Windows 走 notify.ps1，由 daemon 单独托管
    const has = (bin) => {
      try { execFileSync('which', [bin], { stdio: 'ignore' }); return true; } catch (e) { return false; }
    };
    if (has('notify-send')) {
      spawn('notify-send', [title, body], { stdio: 'ignore', detached: true }).unref();
      return true;
    }
    return false;
  } catch (e) { return false; }
}

module.exports = {
  IS_WIN, IS_LINUX, ROOT,
  findChrome, killChrome, listNodeProcs, killPid,
  startSleeper, notify,
};
