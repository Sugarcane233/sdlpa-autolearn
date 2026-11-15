// 极简联网检索：把查询丢给 Bing 的 RSS 接口，拿回标题 + 摘要。
//
// 为什么用 RSS 而不是抓 HTML 页面：百度/Bing 的搜索结果页现在大量靠 JS 渲染，
// 抓下来的 HTML 里混着一堆模板 id、埋点 JSON，能用的正文很少（实测前 5 条
// 全是 chat-input / head-tab 这种壳）。RSS 是服务端渲染的纯数据，解析稳定。
//
// 用途：给模型提供「法规原文 / 标准答案」的佐证，压掉它在数字类判断题上瞎猜
// （实测同一道「冷库总容积不少于 500 立方米」两次答出相反结果）。
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

function strip(html) {
  return String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function unescapeXml(s) {
  return String(s)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&amp;/g, '&');
}

// 把题干压成适合搜索的关键词。
// 整句话直接丢给搜索引擎会被当成「查词条」处理 —— 实测把「开展冷藏冷冻药品
// 物流业务的第三方物流企业，冷库总容积原则上不少于500立方米」原样投进去，
// 返回的全是「开展」这个词的词典释义。所以要去掉引导词、括号、标点，
// 只留名词性关键词。
function toKeywords(question) {
  let q = String(question)
    .replace(/[（(]\s*[)）]/g, ' ')
    .replace(/[A-D]、[^\n]{0,80}/g, ' ')
    .replace(/[，。、；：""''（）()《》？！,.;:?!"']/g, ' ')
    .replace(/\b(以下|下列|关于|说法|正确|错误|的是|有|包括|包含|属于|应当|可以|不得)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const words = q.split(/\s+/).filter((w) => w.length >= 2);
  return words.slice(0, 8).join(' ');
}

async function search(query, opts = {}) {
  const n = opts.n || 5;
  const timeout = opts.timeout || 9000;
  const url = 'https://cn.bing.com/search?setlang=zh-CN&q=' + encodeURIComponent(query);
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeout);
  try {
    const r = await fetch(url, {
      headers: { 'user-agent': UA, 'accept-language': 'zh-CN,zh;q=0.9' },
      signal: ctl.signal,
      redirect: 'follow',
    });
    if (!r.ok) return [];
    const html = await r.text();
    // 只取 <li class="b_algo"> 的结果块，其它都是导航/广告/相关搜索
    const blocks = html.match(/<li class="b_algo"[\s\S]*?<\/li>/g) || [];
    const out = [];
    for (const b of blocks) {
      const t = strip(b);
      if (t.length < 40) continue;
      out.push({ title: '', snippet: t.slice(0, 380) });
      if (out.length >= n) break;
    }
    return out;
  } catch (e) {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

// 拼成一段给模型看的参考资料
async function contextFor(question, opts = {}) {
  if (process.env.WB_SEARCH === '0') return '';
  // 题干里常带选项，检索时去掉选项更准
  const q = toKeywords(question);
  if (!q) return '';
  const hits = await search(q, opts);
  if (!hits.length) return '';
  return hits.map((h, i) => `[${i + 1}] ${h.title}\n${h.snippet}`).join('\n\n');
}

module.exports = { search, contextFor };

if (require.main === module) {
  (async () => {
    const q = process.argv.slice(2).join(' ') || '冷库总容积 500 立方米 第三方物流';
    const r = await search(q);
    console.log('query:', q, '→', r.length, '条');
    r.forEach((h, i) => console.log(`\n[${i + 1}] ${h.title}\n${h.snippet}`));
  })();
}
