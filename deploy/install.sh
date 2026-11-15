#!/usr/bin/env bash
# Linux 一键部署：装依赖 → 装 Chrome → 建目录 → 装 systemd 用户服务 → 启动
#
# 用法（在解压出来的 sdlpa 目录里跑）：
#   bash deploy/install.sh
#
# 前提：已经装好 Node.js 18+ 和 npm。没装的话脚本会提示你怎么装。
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$DIR"

say() { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m[!] %s\033[0m\n' "$*"; }
die() { printf '\033[1;31m[x] %s\033[0m\n' "$*" >&2; exit 1; }

say "检查 Node.js"
if ! command -v node >/dev/null 2>&1; then
  die "没找到 node。先装：
  Ubuntu/Debian:  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash - && sudo apt install -y nodejs
  Fedora:         sudo dnf install -y nodejs npm
  Arch:           sudo pacman -S nodejs npm"
fi
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 18 ] || die "Node 版本太低（$(node -v)），需要 18 以上"
echo "node $(node -v), npm $(npm -v)"

say "检查 Chrome / Chromium"
FOUND=""
for c in google-chrome google-chrome-stable chromium chromium-browser microsoft-edge; do
  if command -v "$c" >/dev/null 2>&1; then FOUND="$(command -v "$c")"; break; fi
done
if [ -z "$FOUND" ]; then
  warn "没找到 Chrome/Chromium。装一个，例如："
  warn "  Ubuntu/Debian: sudo apt install -y chromium-browser   或装官方 chrome deb"
  warn "  Fedora:        sudo dnf install -y chromium"
  warn "装完重跑本脚本，或设 SDLPA_CHROME=/path/to/chrome 再启动。"
  warn "（继续安装，但刷课会因为没浏览器而失败）"
else
  echo "找到浏览器：$FOUND"
fi

say "安装 npm 依赖"
# 国内网络建议加镜像：npm config set registry https://registry.npmmirror.com
npm install --omit=dev --no-audit --no-fund || die "npm install 失败"

say "准备数据目录"
mkdir -p data
# 播放器需要 Chromium 的共享库，Ubuntu 上常见缺这几个
if command -v apt >/dev/null 2>&1; then
  MISSING="$(ldconfig -p 2>/dev/null | grep -c 'libnss3\|libatk-1.0\|libgbm' || true)"
  if [ "${MISSING:-0}" -lt 3 ]; then
    warn "可能缺 Chromium 运行库。如果浏览器起不来，执行："
    warn "  sudo apt install -y libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 libgbm1 libasound2 libpangocairo-1.0-0"
  fi
fi

say "安装 systemd 用户服务"
mkdir -p "$HOME/.config/systemd/user"
sed "s#%h/sdlpa#$DIR#g" deploy/sdlpa.service > "$HOME/.config/systemd/user/sdlpa.service"
systemctl --user daemon-reload
systemctl --user enable --now sdlpa.service

# 用户服务默认在用户登出后就停。要让它在没登录时也跑，需要开 lingering：
if command -v loginctl >/dev/null 2>&1; then
  if ! loginctl show-user "$USER" -p Linger 2>/dev/null | grep -q 'Linger=yes'; then
    warn "开启 lingering 让服务在注销后继续运行（需要 sudo）："
    warn "  sudo loginctl enable-linger $USER"
  fi
fi

say "完成"
systemctl --user --no-pager status sdlpa.service || true
cat <<EOF

------------------------------------------------------------
接下来：

1. 登录（只需一次，之后 cookie 存在 data/profile 里）
     node relogin.js
   会打开一个可见窗口，用学号密码登进去，登录成功后自动切回无头后台。
   如果是在没有图形界面的服务器上，见 README 的「纯命令行登录」一节。

2. 看进度
     node run-status.js
   或浏览器打开 http://127.0.0.1:8765/peek.html

3. 常用
     systemctl --user status sdlpa      # 状态
     systemctl --user restart sdlpa     # 重启
     journalctl --user -u sdlpa -f      # 跟日志
     tail -f data/daemon.log            # 守护日志
     tail -f data/run.log               # 播放日志
------------------------------------------------------------
EOF
