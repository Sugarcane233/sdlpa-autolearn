#!/usr/bin/env bash
# 打包 sdlpa 项目，输出到 D:\backup
#
# 排除的东西（以及原因）：
#   data/profile, data/profile-hl   Chrome 用户目录，418MB，且 Windows 的 cookie
#                                   用 DPAPI 加密，搬到 Linux 解不开，带过去没用
#   node_modules                    平台相关，Linux 上要重新 npm install
#   *.log, *.png, *.tmp             运行产物，不影响复现
#   调试脚本（详见 KEEP_DEBUG=1 的反向开关）
set -euo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STAMP="$(date +%Y%m%d-%H%M)"
OUT_DIR="/d/backup"
PKG="sdlpa-backup-$STAMP"

cd "$SRC"
mkdir -p "$OUT_DIR"
rm -rf "/tmp/$PKG"
mkdir -p "/tmp/$PKG"

echo "=== 1/4 复制核心文件 ==="
# 核心运行文件
cp -v platform.js daemon.js runner.js guard.js launch-headless.js \
      status.js mirror-server.js watch.js tunnel.js relogin.js \
      run-status.js peek.html README.md package.json \
      /tmp/"$PKG"/ 2>/dev/null || true

# 配置文件（含凭据，打包后提醒用户别外传）
cp -v ngrok-token.txt ngrok-domain.txt /tmp/"$PKG"/ 2>/dev/null || true
# access-token 必须放在 data/ 下：mirror-server.js 读的就是 data/access-token.txt
mkdir -p "/tmp/$PKG/data"
cp -v data/access-token.txt /tmp/"$PKG"/data/ 2>/dev/null || true

# Windows 专用脚本（留着备用，Linux 上不用）
mkdir -p "/tmp/$PKG/windows"
cp -v daemon-hidden.vbs tunnel-hidden.vbs keepscreen.ps1 notify.ps1 \
      schtask-install.ps1 fetch-ngrok.cmd /tmp/"$PKG"/windows/ 2>/dev/null || true

# Linux 部署
cp -r deploy "/tmp/$PKG"/

echo "=== 2/4 复制数据快照（不含 profile）==="
mkdir -p "/tmp/$PKG/data"
for f in stat.json courses.json state.json history.json tags.json audit.json; do
  cp -v "data/$f" "/tmp/$PKG/data/" 2>/dev/null || true
done

echo "=== 3/4 复制逆向产物 ==="
if [ -d js ]; then
  mkdir -p "/tmp/$PKG/js"
  cp -v js/*.js "/tmp/$PKG/js/" 2>/dev/null || true
fi

echo "=== 4/4 打包 ==="
tar -czf "$OUT_DIR/sdlpa-backup-$STAMP.tar.gz" -C /tmp "$PKG"

# 同时打一份 zip，Windows 上双击就能看
if command -v zip >/dev/null 2>&1; then
  (cd /tmp && zip -qr "$OUT_DIR/sdlpa-backup-$STAMP.zip" "$PKG")
fi

echo
echo "=== 完成 ==="
ls -lh "$OUT_DIR"/sdlpa-backup-"$STAMP".* 
echo
echo "解包检查："
tar -tzf "$OUT_DIR/sdlpa-backup-$STAMP.tar.gz" | head -30
echo "... 共 $(tar -tzf "$OUT_DIR/sdlpa-backup-$STAMP.tar.gz" | wc -l) 项"
rm -rf "/tmp/$PKG"
