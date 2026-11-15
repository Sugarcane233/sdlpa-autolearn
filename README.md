# SDLPA 继续教育自动刷课

用无窗口 Chrome（通过 CDP 控制）在后台真实播放 `sdu.sdlpa.org.cn`（山东大学执业药师继续教育平台）的课程视频，按平台的计时规则累计学时，自动切课，全程不弹窗、不需要人守着。

配套一个网页看板（实时截图 + 进度 + 远程登录）和一套考试页悬浮解题助手。

> **它没有伪造任何数据。** 学时是播放器真的播了那么久、平台自己按批次上报的。项目做的是「让人不用坐在电脑前」这件事，不是「骗过服务器」。

---

## 功能

| 模块 | 说明 |
|---|---|
| 后台播放 | 无头 Chrome 真实播放视频，注入 guard 脚本钉死 `visibilityState`、屏蔽 blur 事件、锁定 `playbackRate=1` |
| 自动排队 | 以服务端 `getTraineeLearnStat` 为唯一真相决定下一个学哪节，长课件（可能触发签到）排到最后 |
| 看板 | 8765 端口，实时截图 + 进度条 + 远程登录（图形验证码抠出来发到网页，人远程填） |
| 公网映射 | 通过 ngrok 把看板挂到公网，手机也能看 |
| 考试助手 | 考试页右下角悬浮按钮，读题 → 问模型 → 显示答案 → 自动勾选（多选也支持） |
| 自愈 | 看门狗检测 run.log 停滞 11 分钟 ×2 次就重启 Chrome；6 小时滚动重启；登录态过期写 `NEED_LOGIN` 标记并系统通知 |

---

## 安装

### 前提

| 项 | 要求 |
|---|---|
| Node.js | >= 18（实测 24.x） |
| Chrome / Chromium | 任意较新版本；脚本会自动找，也可用 `SDLPA_CHROME` 指定 |
| systemd | 用 user 服务常驻（可选，但推荐） |

Ubuntu/Debian 装 Node：

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
```

**没有 root 权限时装 Chrome**（下载 deb 解包到用户目录）：

```bash
cd /tmp
curl -LO https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb
ar x google-chrome-stable_current_amd64.deb
tar -xf data.tar.xz
mkdir -p ~/.local/opt/google-chrome
cp -a opt/google/chrome/* ~/.local/opt/google-chrome/
mkdir -p ~/.local/bin && ln -sf ~/.local/opt/google-chrome/chrome ~/.local/bin/google-chrome
```

> 需要带专有编解码器的 Chrome（要播 H.264）。验证：
> `video.canPlayType('video/mp4; codecs="avc1.42E01E"')` 返回 `"probably"` 即可。

### 部署

```bash
git clone <本仓库> ~/sdlpa
cd ~/sdlpa
npm install --omit=dev
```

### 配置环境变量

项目**不含任何账号、口令、密钥**，全部通过环境变量注入：

| 变量 | 说明 |
|---|---|
| `SDLPA_TRAINEE` | **必填**，你的学员 ID（登录后 URL 里 `traineeid=` 后面那串数字） |
| `SDLPA_CHROME` | Chrome 可执行文件路径（不在 PATH 里时必填） |
| `SDLPA_TOKEN` | 看板访问口令，不设则自动生成到 `data/access-token.txt` |
| `SDLPA_PORT` | Chrome CDP 端口，默认 9222 |
| `WB_VAULT` | WorkBuddy 凭据目录（考试助手用），不设则解题功能不可用 |
| `WB_MODEL` | 解题用的模型，默认 `deepseek-v4.1-flash` |
| `WB_VOTES` | 解题采样次数（多数投票），默认 3 |

### 常驻服务

`deploy/install.sh` 是模板版本，需要 root 装依赖并写 `/etc/systemd/system`。用用户级服务可以绕开 root：

```ini
# ~/.config/systemd/user/sdlpa.service
[Unit]
Description=SDLPA AutoLearn daemon
After=network-online.target

[Service]
Type=simple
WorkingDirectory=%h/sdlpa
Environment=SDLPA_TRAINEE=<你的学员ID>
Environment=SDLPA_CHROME=%h/.local/opt/google-chrome/chrome
Environment=TZ=Asia/Shanghai
Environment=PATH=%h/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
ExecStart=/usr/bin/env node %h/sdlpa/daemon.js
Restart=always
RestartSec=30
KillMode=control-group
KillSignal=SIGTERM
TimeoutStopSec=20
OOMScoreAdjust=-200

[Install]
WantedBy=default.target
```

```bash
systemctl --user daemon-reload
systemctl --user enable --now sdlpa.service
loginctl enable-linger $USER     # 没登录桌面也能跑，开机自启的关键
```

### 首次登录

平台不允许复用别的机器上的 cookie（Windows 的是 DPAPI 加密的），必须在目标机器上登录一次。

**方式一：开可见窗口自己登（推荐）**

```bash
node relogin.js
```

会弹出一个 Chrome 窗口，登录完成后脚本自动导出 cookie、关窗口、切回无头后台。

**方式二：通过看板远程登**

打开 `http://127.0.0.1:8765/peek.html`，检测到未登录时会自动显示登录卡片，填账号密码 + 图形验证码即可。

> ⚠️ 登录页的「保持登录状态」默认是「1天」。想少登录几次，把它改到「1月」。

---

## 用法

```bash
# 看当前进度（命令行）
node run-status.js

# 看板（本机）
# http://127.0.0.1:8765/peek.html?k=<口令>
# 口令在 data/access-token.txt，参数名是 k 不是 t

# 暂停 / 恢复
touch data/PAUSED      # 暂停
rm data/PAUSED         # 恢复

# 重新登录
node relogin.js
```

### 考试助手

```bash
systemd-run --user --unit=sdlpa-exam-helper --collect \
  --working-directory=$HOME/sdlpa \
  /usr/bin/node $HOME/sdlpa/exam-helper.js
```

打开考试答题页，右下角会出现「🎯 解题并自动填」。点一下：读题 → 问模型（默认采样 3 次取多数）→ 显示答案和理由 → 自动勾选，多选题会逐个勾全。

答题前会先做课程评价（5 个评分项各点满星），提交评价后才进入答题页。

---

## 文件说明

| 文件 | 作用 |
|---|---|
| `daemon.js` | 唯一常驻入口，托管下面所有子进程；单实例锁 `data/daemon.pid`；看门狗 |
| `runner.js` | 主逻辑：拉课程列表、排队、播放、切换 |
| `guard.js` | 注入页面：钉死 `visibilityState`、吞 blur、锁 `playbackRate=1` |
| `launch-headless.js` | 启动无头 Chrome（抹掉 HeadlessChrome UA、Linux 加 `--no-sandbox`） |
| `platform.js` | 跨平台适配：找 Chrome、杀进程、防睡眠、系统通知 |
| `session-store.js` | **登录态持久化**：导出/注入 cookie（见下方「坑」第 1 条） |
| `relogin.js` | 开可见窗口重新登录，完成后自动导出 cookie 并切回无头 |
| `mirror-server.js` | 看板服务（8765），白名单 + 口令；`/api/login/*` 是远程登录接口 |
| `login-agent.js` | 远程登录的后端：取验证码、填表提交、踢 runner 重开 |
| `peek.html` | 看板页面（截图、进度、登录卡片） |
| `watch.js` | 定时截图到 `data/now.png`（有人看 15s/张，无人 180s/张） |
| `status.js` | 每 10 秒汇总状态到 `data/status.json` |
| `tunnel.js` | ngrok 公网映射 |
| `exam-helper.js` | 考试助手 Node 侧：轮询页面请求、调模型、用 Playwright 真实点击选项 |
| `exam-ui.js` | 注入考试页的悬浮窗（必须独立文件，见「坑」第 4 条） |
| `search.js` | 联网检索（默认关闭，`WB_SEARCH=1` 启用） |

---

## 踩过的坑

这些都是实际调试出来的，重装时能省很多时间。

**1. 登录 cookie 不落盘，换进程就丢**

平台的 `jwtToken` 是**会话 cookie**（没有 `expires`）。Chrome 只把带过期时间的 cookie 写进 `Cookies` 数据库，所以关掉窗口换无头进程，登录态就没了。

解法是 `session-store.js`：登录成功后把 `*.sdlpa.org.cn` 的 cookie 导出到 `data/session.json`，runner 启动时用 `ctx.addCookies()` 注回去。

**2. 「保持登录状态」的下拉框 DOM**

Element Plus 新版 el-select 的结构变了：当前值在 `.el-select__placeholder` 的 innerText，展开要点 `.el-select__wrapper`，选项是 `.el-select-dropdown__item`。早先用 `.el-input__inner` 读值永远读到空字符串，导致每次都误判「设置失败」而实际一次都没设成。

**3. `relogin.js` 会杀掉自己**

它的 `stopAll()` 扫 `/proc/*/cmdline` 找含 `sdlpa` 的 node 进程，而自己的命令行里就有 `sdlpa`，于是 SIGKILL 了自己。绕过办法是用 `setsid` 从包装脚本启动，让进程 cmdline 不含关键字。

**4. `exam-ui.js` 必须独立成文件**

它内部用反引号写 CSS，内联进 `exam-helper.js` 的模板字符串会把模板提前截断，报 `SyntaxError: Private field '#sdlpa' must be declared in an enclosing class`。改成 `fs.readFileSync` 读文件。

**5. 页面内合成点击驱动不了 Element Plus 的多选**

试过点内部 `<input>`、给 `.el-checkbox__inner` 派发 `MouseEvent`、加 `await sleep()` 间隔，全都不行 —— 四个都点了只勾上最后一个。Vue 的受控状态在同一 tick 里会互相覆盖。

**唯一有效的是 Playwright 的真实鼠标事件**：`locator.click()` 逐个点。所以现在的架构是页面把答案发给 Node 侧（`window.__applyReq`），Node 用真实点击填好，再把结果回写页面。

**6. 改完代码页面里还是旧的**

`exam-ui.js` 开头原来只判断「有没有注入过」，改完重启后重新 evaluate 被直接 `return 'already'` 挡掉，跑的还是旧版。现在加了版本号 `VER`，不一致就拆掉重装。

**7. 看门狗重启会掐断 token 续期**

页面在前端每 5 分钟续一次 token。如果看门狗把 Chrome 杀掉重启，续期链条就断了，token 一路走到过期。所以现在重启前会检查登录态剩余时间。

**8. 模型答案不稳定，同一题能答出相反结果**

实测一道判断题（「冷库总容积不少于 500 立方米」）两次问给出相反答案。现在默认采样 3 次做多数投票，面板上会显示「2/3 票一致」，让用户知道这题模型自己也没把握。

**9. Element Plus 的做题控件有两种**

判断题/单选题是 `.el-radio`，多选题是 `.el-checkbox`。写选择器要同时覆盖，而且都得点容器而不是内部 input。

---

## 历史记录

`README-HISTORY.md` 是最初从 Windows 迁移时写的打包说明，包含当时的进度快照和更多调试细节，留作参考。

---

## 免责

仅供个人学习研究使用。请遵守平台的服务条款，自行承担使用风险。
