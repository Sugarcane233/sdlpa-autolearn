# SDLPA 继续教育自动刷课 — 备份与迁移说明

这个包是 2026-11-09 从 Windows 机器上打包的，目标是把整套东西搬到 Linux 继续跑。
下面按「新机器怎么装起来」「项目到底在干什么」「遇到问题怎么查」三段写。

---

## 一、这个项目是什么

用无窗口 Chrome 在后台播放 `sdu.sdlpa.org.cn`（山东大学执业药师继续教育）的课程视频，
按平台的计时规则真实累计学时，自动切下一节，全程不弹窗、不需要人守着。

**它没有伪造任何数据。** 学时是播放器真的播了那么久、平台自己按 300 秒一批上报的。
它做的是「让人不用坐在电脑前」这件事，不是「骗过服务器」。

截至打包时进度：**90/123 节，27.15h / 61.81h = 43.9%**，已整门学满 8 门
（646、648、652、658、659、661、662、674），公需课 674 已通过。
**22 门专业课学满后还需要各考一次试**，那个必须你本人考。

---

## 二、搬到 Linux 怎么装

### 1. 前提

| 项 | 要求 |
|---|---|
| Node.js | 18 以上（推荐 20） |
| Chrome / Chromium | 任意版本，脚本会自动找 |
| systemd | 用 user 服务常驻，绝大多数发行版都有 |

Node 没装的话：

```bash
# Ubuntu / Debian
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs

# Fedora
sudo dnf install -y nodejs npm

# Arch
sudo pacman -S nodejs npm
```

### 2. 解压到哪

脚本默认假设项目在 `~/sdlpa`，装到别处也能用（安装脚本会自己算路径写进 systemd unit）：

```bash
mkdir -p ~/sdlpa
tar -xzf sdlpa-backup-*.tar.gz -C ~/sdlpa --strip-components=1
cd ~/sdlpa
```

### 3. 一键装

```bash
bash deploy/install.sh
```

它会：检查 node/chrome → `npm install` → 装 systemd user 服务 → 启动。
跑完会打印状态和常用命令。

Chrome 缺运行库的话（Ubuntu 常见），脚本会提示装这几个：

```bash
sudo apt install -y libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 libgbm1 libasound2 libpangocairo-1.0-0
```

### 4. 登录（必须做一次）

```bash
node relogin.js
```

会停掉后台、开一个**看得见的** Chrome 窗口、用项目自己的 profile 打开课程页。
你在那个窗口里登录（账号（见你自己平台的登录名）），脚本检测到 `jwtToken` 出现就自动关窗口、切回无头后台。

> 用你自己平时的浏览器登录没用，那是另一个 profile，cookie 不共享，而且还会把后台顶掉。

**纯命令行服务器上没有图形界面怎么办？**
两条路：

1. `ssh -X` 连过去再跑 `node relogin.js`，窗口会转发到你本地
2. 在服务器上装个 Xvfb 虚拟显示：`sudo apt install -y xvfb`，然后
   `xvfb-run -a node relogin.js`，配合 VNC/截图看窗口
   （`relogin.js` 会把窗口画在虚拟屏上，你通过 CDP 也能操作）

**注意：Windows 的 `data/profile` 不能直接用。**
Chrome 在 Windows 上用 DPAPI 加密 cookie，密钥绑定当前 Windows 用户账号，
搬到 Linux 上解不开——那个目录里 418MB 的东西带过去也没用。
所以打包时**故意没包含 `data/profile`**，登录必须在 Linux 上重新做一次。

### 5. 确认在跑

```bash
node run-status.js                      # 一行看进度
systemctl --user status sdlpa           # 服务状态
tail -f data/run.log                    # 播放日志
```

看板：`http://127.0.0.1:8765/peek.html`（本机直接开，不需要口令）

---

## 三、文件说明

### 核心逻辑

| 文件 | 作用 |
|---|---|
| `daemon.js` | 守护进程，唯一的常驻入口。看护 Chrome / runner / 看板 / 截图 / 公网映射，防睡眠，6 小时滚动重启 Chrome，看门狗杀卡死 |
| `runner.js` | 主控。拉服务端进度 → 排待学队列 → 逐个播放 → 到结尾回查 → 切下一节 |
| `guard.js` | 注入页面的抗干扰层：钉死 `visibilityState`、屏蔽 blur/visibilitychange 监听、自动点弹窗、抢回播放 |
| `launch-headless.js` | 启动无窗口 Chrome（UA 已抹掉 HeadlessChrome 痕迹，Linux 下自动加 `--no-sandbox`） |
| `platform.js` | **跨平台适配层**。Chrome 路径探测、杀进程、枚举进程、防睡眠、通知，Windows/Linux 差异全在这一个文件里 |
| `relogin.js` | 登录态过期后重新登录用 |

### 看板

| 文件 | 作用 |
|---|---|
| `status.js` | 每 10 秒汇总进度/速率/进程/异常，写 `data/status.json` |
| `peek.html` | 看板页面 |
| `mirror-server.js` | 看板网页服务（8765）。**白名单模式**，只放行 4 个文件 + 访问口令 |
| `watch.js` | 截图循环，写 `data/now.png`。有人看才勤快，没人看降到 3 分钟一张 |

### 公网映射

| 文件 | 作用 |
|---|---|
| `tunnel.js` | 通过 ngrok 把 8765 挂到公网，固定域名（写在 ngrok-domain.txt，不提交） |
| `ngrok-token.txt` | ngrok authtoken（**敏感，别外传**） |
| `ngrok-domain.txt` | 固定域名 |

### 数据

| 路径 | 内容 |
|---|---|
| `data/stat.json` | 服务端最后一次返回的学时真相 |
| `data/courses.json` | 课程结构缓存（24 门 / 138 课件） |
| `data/run.log` | 播放日志，出问题先看这个 |
| `data/daemon.log` | 守护日志 |
| `data/access-token.txt` | 看板访问口令（首次运行自动生成，勿外传） |
| `data/profile/` | **Chrome 用户目录，含登录 cookie。敏感，别外传** |
| `data/ALL_DONE` | 全部刷完的标记，出现后 daemon 不再空转 |
| `data/PAUSED` | 看板点了暂停 |
| `data/NEED_MANUAL` | 出现图形签到，需要人工点一下 |

### 平台配置

| 文件 | 作用 |
|---|---|
| `schtask-install.ps1` | Windows 计划任务安装脚本（Linux 上不用，改走 systemd） |
| `daemon-hidden.vbs` | Windows 无窗口启动器（Linux 上不用） |
| `keepscreen.ps1` | Windows 防睡眠（Linux 走 `systemd-inhibit`，已在 platform.js 里） |
| `deploy/install.sh` | **Linux 一键安装** |
| `deploy/sdlpa.service` | systemd user 服务模板 |

---

## 四、它挡了什么、怎么挡的

平台在播放页里放了这些检查，`guard.js` 逐个处理：

| 平台的做法 | 我们的处理 |
|---|---|
| `window.blur` 时暂停并弹窗 | 拦截 `addEventListener`/`removeEventListener`，`blur` 等事件注册直接吞掉；`document.hasFocus` 恒为 true |
| 靠 `visibilityState` 判定切后台 | `Object.defineProperty` 钉死为 `visible` / `hidden=false` |
| 每 10 秒查 `playbackRate > 1.05` | keepAlive 每 700ms 检查，超了强制回 1 |
| `seeking` 时拦快进 | 从不动 `currentTime` 往前跳 |
| 弹题（`questions[]`） | 答案平台明文下发，`window.__cwAnswers` 注入后自动作答（实测全站弹题数为 0） |
| 长课件中途弹「请点击签到」 | `el-message-box` 自动点掉 |
| 服务端下发 `NEED_CHECKIN`（图形点选） | **这个挡不住**，写 `data/NEED_MANUAL` 并截图，等你人工点 |

---

## 五、已修复的坑（实战记录）

搬过去之后如果又遇到，先翻这张表。

| 现象 | 根因 | 修法 |
|---|---|---|
| 日志每秒刷 `resume (paused)` 永不动 | HLS 断流让 `video` 进 `error.code=4`，`play()` 必然失败 | guard 侦测 error 后停手，runner 重载本节 |
| 连续几十次「列表里找不到」 | 同上，video 崩了但 DOM 还在，点击无效 | 失败先 reload 再重试 |
| 服务端已满 2134/2134，本地还在从头重播 | 播放器到结尾销毁重建 `<video>`，位置回滚到 0，5 秒轮询抓不到 | 记「播到过的最远位置」`maxCt` + `ended` 标志 |
| 日志停住、看板显示暂停、卡几小时 | 页面 JS 引擎死锁：Chrome 活、runner 活，但 `Runtime.evaluate` 永不返回 | daemon 看门狗：`run.log` 11 分钟无新内容且连续两轮确认，杀 runner + Chrome 整轮重启 |
| 两个进程抢同一个播放器 | 计划任务的 `MultipleInstances` 管的是 wscript 不是 node | `data/daemon.pid` 单实例锁 |
| 看板打不开但后台正常 | `mirror-server.js` / `watch.js` 没被 daemon 托管，一挂就永久消失 | daemon 增 `ensureMirror()` / `ensureWatch()` |
| 登录失效后每分钟拉起一次 runner | `ensureRunner()` 没判 `lastRunnerExit`，`setTimeout` 的等待被 tick 绕过 | 加 `lastRunnerCode`，code=2 等 10 分钟 |
| ngrok 第 6 次重连永久失败 | 每次重试新开 listener、旧的没关，撞「一个 session 最多 5 个 endpoint」 | 重连前 `await listener.close()`，占满时 `ngrok.kill()` 掀掉会话 |
| 看板能开但截图一直不动 | 降频策略太粗：没人看时固定 3 分钟一张，刚打开要干等 | 改 5 秒心跳、按需判断，检测到有人取图 10 秒内补拍 |

---

## 六、登录态能撑多久

- `jwtToken`：24 小时，页面在跑时前端每 5 分钟自动续期
- `jwtToken_Refresh`：**7 天，硬上限**

只要后台连续跑（Chrome 不关、页面在），token 会一直滚下去。
**但如果连续断开超过 refresh token 的剩余时间，链条就断，必须重新登录。**

这次就是 11-01 首次登录、11-08 01:00 refresh token 到期，凌晨断掉后白跑了 7 小时。
搬过去之后建议每周瞄一眼 `node run-status.js`，进度不动就是掉登录了。

---

## 七、日常命令

```bash
systemctl --user status sdlpa       # 状态
systemctl --user restart sdlpa      # 重启
systemctl --user stop sdlpa         # 停
journalctl --user -u sdlpa -f       # 跟 systemd 日志

node run-status.js                  # 进度一行
tail -f data/run.log                # 播放日志
tail -f data/daemon.log             # 守护日志

node relogin.js                     # 重新登录
```

看板：`http://127.0.0.1:8765/peek.html`
公网：`https://<你的-ngrok-域名>/peek.html?k=<口令>`

暂停刷课：看板右上角「暂停/继续」按钮，或者手动 `touch data/PAUSED`（继续就删掉）。

---

## 八、Linux 上可能撞到的新问题

1. **Chrome 起不来** —— 90% 是缺共享库。`google-chrome --version` 直接手动跑一遍看报错，
   缺什么 `ldd` 一查就知道。Ubuntu 上通常是 `libnss3` / `libgbm1` / `libasound2` 这几族。

2. **以 root 跑** —— 脚本已自动加 `--no-sandbox`。但更建议用普通用户 + systemd user 服务。

3. **`systemd --user` 在没登录时不起** —— 需要 `sudo loginctl enable-linger $USER`。
   `install.sh` 会检测并提示。

4. **播放卡顿** —— 无头 Chrome 在某些 VPS 上没有 GPU，`--disable-gpu` 已在标志里。
   如果还是很慢，检查 CPU 是否被别的进程吃满（视频解码要真实算力）。

5. **时区** —— 日志用 `toLocaleString('zh-CN')`，Linux 上要确保 `TZ` 或系统时区是
   `Asia/Shanghai`，否则日志时间会差 8 小时（不影响功能，只影响看日志）。

6. **H.264 解码** —— Chrome/Chromium 分「有专有编解码器」和「没有」两种构建。
   平台视频是 H.264，**Chromium 开源版可能放不了**。
   验证方法：起好之后 `node -e "..."` 或者在浏览器控制台看 `video.canPlayType('video/mp4; codecs="avc1.42E01E"')`，
   返回 `probably` 才行。不行就换 `google-chrome` 官方 deb。

---

## 九、安全提醒

- `data/profile/` 里有登录 cookie，等同于你的账号凭据。**别传网盘、别进 git。**
- `ngrok-token.txt` 是 ngrok 账号凭据。
- 看板有访问口令（`data/access-token.txt`），本地直连免输，公网必须带。
- `mirror-server.js` 是白名单模式，只放行 `peek.html` / `now.png` / `status.json` / `checkin.png`。
  曾经是整目录静态挂载，等于把 Chrome 的加密主密钥和浏览记录全暴露出去，已修。
