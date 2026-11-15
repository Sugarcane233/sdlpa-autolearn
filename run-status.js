// 一行式进度汇报（含课程级进度与已完成课程）
const { chromium } = require('playwright-core');
const fs = require('fs'), path = require('path');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const DATA = path.join(__dirname, 'data');

(async () => {
  let stat = null;
  try {
    const b = await chromium.connectOverCDP('http://127.0.0.1:' + (process.env.SDLPA_PORT || 9222));
    const ctx = b.contexts()[0];
    const page = await ctx.newPage();
    page.on('response', async res => {
      if (res.url().includes('getTraineeLearnStat') && !stat) {
        try { stat = JSON.parse(await res.text()); } catch (e) {}
      }
    });
    await page.goto(`https://sdu.sdlpa.org.cn/learn?traineeid=${process.env.SDLPA_TRAINEE || 0}&courseid=674`, { waitUntil: 'domcontentloaded' });
    for (let i = 0; i < 30 && !stat; i++) await sleep(700);
    await page.close();
    if (stat) fs.writeFileSync(path.join(DATA, 'stat.json'), JSON.stringify(stat, null, 2));
  } catch (e) {
    try { stat = JSON.parse(fs.readFileSync(path.join(DATA, 'stat.json'), 'utf8')); } catch (e2) {}
  }
  if (!stat || !stat.data) { console.log('取不到学籍统计（Chrome 可能没在跑）'); process.exit(1); }
  const d = stat.data;

  let learned = 0, tot = 0, cdone = 0, cnt = 0;
  const byCourse = [];
  for (const cid of Object.keys(d.courseStats)) {
    const c = d.courseStats[cid];
    let cl = 0, ct = 0, cd = 0, cn = 0;
    for (const wid of Object.keys(c.coursewareStats || {})) {
      const w = c.coursewareStats[wid];
      if (!w.totalDuration) continue;
      cn++; ct += w.totalDuration; cl += w.learnDuration;
      if (w.learnDuration >= w.totalDuration - 3) cd++;
    }
    cnt += cn; tot += ct; learned += cl; cdone += cd;
    byCourse.push({ cid, name: c.courseName || cid, cl, ct, cd, cn, pass: c.isPass });
  }

  console.log(`课件 ${cdone}/${cnt} 完成 | 学时 ${(learned / 3600).toFixed(2)}h / ${(tot / 3600).toFixed(1)}h = ${tot ? (learned / tot * 100).toFixed(2) : 0}%`);

  // 有进度但没满的（多半是异常中断留下的几秒残量），这类会被队列重新排进去补完
  const residual = [];
  for (const cid of Object.keys(d.courseStats)) {
    const cs = d.courseStats[cid];
    for (const wid of Object.keys(cs.coursewareStats || {})) {
      const w = cs.coursewareStats[wid];
      if (!w.totalDuration) continue;
      if (w.learnDuration > 0 && w.learnDuration < w.totalDuration - 3) {
        residual.push({ cid, wid, l: w.learnDuration, t: w.totalDuration });
      }
    }
  }
  if (residual.length) {
    console.log(`残量待补 ${residual.length} 节（已记秒数 < 3 秒的多为异常中断遗留，队列会重播补满）：`);
    residual.slice(0, 5).forEach((r) => console.log(`  课程${r.cid} 课件${r.wid} 已记 ${r.l}s / ${r.t}s`));
  }
  console.log(`已通过课程 ${d.publicCourseCount_Pass + d.specializedCourseCount_Pass} 门（公需 ${d.publicCourseCount_Pass} / 专业 ${d.specializedCourseCount_Pass}）`);

  const finished = byCourse.filter(c => c.ct > 0 && c.cl >= c.ct - 3);
  if (finished.length) console.log('学时已满：' + finished.map(c => c.name).join('、'));

  const running = byCourse.filter(c => c.cl > 0 && c.cl < c.ct - 3).sort((a, b) => b.cl - a.cl).slice(0, 3);
  if (running.length) {
    console.log('正在推进：' + running.map(c => `${c.name} ${(c.cl / 3600).toFixed(1)}/${(c.ct / 3600).toFixed(1)}h`).join('、'));
  }
  process.exit(0);
})().catch(e => { console.error(e.message); process.exit(1); });
