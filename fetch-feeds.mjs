// GitHub の自動実行で動かす中継スクリプト。
// アプリから直接読めないサイトの新着を集めて feeds.json に書き出す。
// 集めるのはタイトル・リンク・日時・サムネイルのアドレスだけで、本文は保存しない。
import { writeFile } from "node:fs/promises";

const SOURCES = [
  { id: "lodestone", url: "https://jp.finalfantasyxiv.com/lodestone/news/topics.xml" },
  { id: "yt-official", url: "https://www.youtube.com/feeds/videos.xml?channel_id=UCpx2BZg8ABgaDV50sGJtWAg", channel: "UCpx2BZg8ABgaDV50sGJtWAg" },
  { id: "hikasen", url: "https://ff14hikasensokuhou.com/?xml" },
  { id: "yan", url: "https://yan-flash.com/feed.xml" }
];
const PER_SOURCE = 30;

const decode = (s = "") =>
  s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
    .replace(/&amp;/g, "&").trim();

const tag = (block, name) => {
  const m = block.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`));
  return m ? decode(m[1]) : "";
};
const attr = (block, re) => decode(block.match(re)?.[1] ?? "");

function parse(xml) {
  const isAtom = /<feed[\s>]/.test(xml);
  const blocks = xml.match(isAtom ? /<entry[\s>][\s\S]*?<\/entry>/g : /<item[\s>][\s\S]*?<\/item>/g) ?? [];
  return blocks.map((b) => {
    const html = tag(b, "content:encoded") || tag(b, "content") || tag(b, "description");
    const link = isAtom
      ? attr(b, /<link[^>]*rel="alternate"[^>]*href="([^"]+)"/) || attr(b, /<link[^>]*href="([^"]+)"/)
      : tag(b, "link");
    const img =
      attr(b, /<media:thumbnail[^>]*url="([^"]+)"/) ||
      attr(b, /<link[^>]*rel="enclosure"[^>]*href="([^"]+)"/) ||
      attr(b, /<enclosure[^>]*url="([^"]+)"/) ||
      (html.match(/<img[^>]+src="([^"]+)"/i)?.[1] ?? "");
    const date = Date.parse(tag(b, "published") || tag(b, "dc:date") || tag(b, "pubDate") || tag(b, "updated")) || 0;
    return { title: tag(b, "title"), link, date, img: img.startsWith("https://") ? img : "" };
  }).filter((it) => it.title && it.link.startsWith("https://"));
}

// YouTube の配信（RSS）は「見つからない」と返すことがあるので、その時はチャンネルのページから読み取る。
// ページには「3 日前」のような大まかな日時しかないため、そこから逆算する。
const UNIT_MS = { "秒": 1e3, "分": 6e4, "時間": 36e5, "日": 864e5, "週間": 6048e5, "か月": 2592e6, "年": 31536e6 };

function parseChannelPage(html, now) {
  return html.split('"lockupViewModel":{').slice(1).map((chunk) => {
    const id = chunk.match(/"contentId":"([A-Za-z0-9_-]{11})"/)?.[1];
    const raw = chunk.match(/"lockupMetadataViewModel":\{"title":\{"content":"((?:[^"\\]|\\.)*)"/)?.[1];
    if (!id || !raw) return null;
    let date = 0;
    let upcoming = false;
    const ago = chunk.match(/"content":"[^"]*?(\d+) ?(秒|分|時間|日|週間|か月|年)前/);
    const planned = chunk.match(/"content":"(\d{4})\/(\d{1,2})\/(\d{1,2}) (\d{1,2}):(\d{2}) に公開予定/);
    if (ago) date = now - Number(ago[1]) * UNIT_MS[ago[2]];
    else if (planned) {
      const [, y, mo, d, h, mi] = planned.map(Number);
      date = Date.UTC(y, mo - 1, d, h - 9, mi); // 日本時間として読む
      upcoming = true;
    } else return null;
    return {
      title: JSON.parse('"' + raw + '"'),
      link: "https://www.youtube.com/watch?v=" + id,
      date,
      img: "https://i.ytimg.com/vi/" + id + "/hqdefault.jpg",
      ...(upcoming ? { upcoming } : {})
    };
  }).filter(Boolean);
}

async function youtubeFromPage(channel) {
  const now = Date.now();
  const all = [];
  for (const tab of ["videos", "streams"]) {
    const res = await fetch(`https://www.youtube.com/channel/${channel}/${tab}`, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36",
        "Accept-Language": "ja-JP,ja;q=0.9"
      }
    });
    if (res.ok) all.push(...parseChannelPage(await res.text(), now));
  }
  const seen = new Set();
  return all.filter((it) => (seen.has(it.link) ? false : seen.add(it.link))).sort((a, b) => b.date - a.date);
}

async function fetchSource(s) {
  try {
    const res = await fetch(s.url, { headers: { "User-Agent": "Mozilla/5.0 (eorzea-dispatch feed reader)" } });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const items = parse(await res.text());
    if (!items.length) throw new Error("記事が見つかりませんでした");
    return items;
  } catch (e) {
    if (!s.channel) throw e;
    const items = await youtubeFromPage(s.channel);
    if (!items.length) throw new Error("配信もチャンネルページも読めませんでした（" + (e.message || e) + "）");
    return items;
  }
}

const out = { updatedAt: Date.now(), sources: {}, items: [] };
for (const s of SOURCES) {
  try {
    const items = (await fetchSource(s)).slice(0, PER_SOURCE);
    out.sources[s.id] = { ok: true, count: items.length };
    out.items.push(...items.map((it) => ({ src: s.id, ...it })));
  } catch (e) {
    out.sources[s.id] = { ok: false, error: String(e.message || e) };
  }
  console.log(s.id, JSON.stringify(out.sources[s.id]));
}

await writeFile("feeds.json", JSON.stringify(out, null, 1) + "\n");
