// GitHub の自動実行で動かす中継スクリプト（Claude 版）。
// Claude・Anthropic 関連の新着を集めて claude/feeds.json に書き出す。
// ANTHROPIC_API_KEY があれば、英語の記事に日本語の見出しと要約を付け、直近1週間のまとめも作る。
import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import Anthropic from "@anthropic-ai/sdk";

const OUT = new URL("./feeds.json", import.meta.url);
const OLSHANSK = "https://raw.githubusercontent.com/Olshansk/rss-feeds/main/feeds/";

// ai: true の情報源は英語なので、要約の対象にする
const SOURCES = [
  { id: "news", url: OLSHANSK + "feed_anthropic_news.xml", ai: true },
  { id: "engineering", url: OLSHANSK + "feed_anthropic_engineering.xml", ai: true },
  { id: "research", url: OLSHANSK + "feed_anthropic_research.xml", ai: true },
  { id: "claude-code", url: "https://github.com/anthropics/claude-code/releases.atom", changelog: true, ai: true },
  { id: "status", url: "https://status.claude.com/history.rss", alt: "https://status.anthropic.com/history.rss", ai: true, per: 15 },
  { id: "youtube", url: "https://www.youtube.com/feeds/videos.xml?channel_id=UCrDwWp7EBBv4NwvScIpBDOA", ai: true, per: 15 },
  { id: "hn", url: "https://hnrss.org/newest?q=Claude+OR+Anthropic&points=100&count=30", ai: true },
  { id: "reddit", url: "https://www.reddit.com/r/ClaudeAI/top/.rss?t=week", ai: true, per: 20 },
  { id: "zenn", url: "https://zenn.dev/topics/claudecode/feed", alt: "https://zenn.dev/topics/claude/feed" },
  { id: "qiita", url: "https://qiita.com/tags/claudecode/feed", alt: "https://qiita.com/tags/claude/feed" }
];
const PER_SOURCE = 30;
const MODEL = "claude-opus-5-5";
const SUMMARIZE_DAYS = 14;     // これより古い記事は要約しない
const SUMMARIZE_PER_RUN = 40;  // 1回の実行で要約する上限（費用の上限）
const DIGEST_DAYS = 7;

const decode = (s = "") =>
  s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").trim();

const tag = (block, name) => {
  const m = block.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`));
  return m ? decode(m[1]) : "";
};
const attr = (block, re) => decode(block.match(re)?.[1] ?? "");
const plain = (html) => decode(html.replace(/<li[^>]*>/gi, "\n- ").replace(/<[^>]+>/g, " ")).replace(/[ \t]+/g, " ").replace(/\s*\n\s*/g, "\n").trim();
const clip = (s, n) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

function parse(xml) {
  const isAtom = /<feed[\s>]/.test(xml);
  const blocks = xml.match(isAtom ? /<entry[\s>][\s\S]*?<\/entry>/g : /<item[\s>][\s\S]*?<\/item>/g) ?? [];
  return blocks.map((b) => {
    const html = tag(b, "content:encoded") || tag(b, "content") || tag(b, "media:description") || tag(b, "description");
    const link = isAtom
      ? attr(b, /<link[^>]*rel="alternate"[^>]*href="([^"]+)"/) || attr(b, /<link[^>]*href="([^"]+)"/)
      : tag(b, "link");
    const img =
      attr(b, /<media:thumbnail[^>]*url="([^"]+)"/) ||
      attr(b, /<enclosure[^>]*url="([^"]+\.(?:png|jpe?g|webp|gif)[^"]*)"/i) ||
      (html.match(/<img[^>]+src="([^"]+)"/i)?.[1] ?? "");
    const date = Date.parse(tag(b, "published") || tag(b, "dc:date") || tag(b, "pubDate") || tag(b, "updated")) || 0;
    const usable = img.startsWith("https://") && !img.includes("avatars.githubusercontent.com");
    return { title: tag(b, "title"), link, date, img: usable ? img : "", text: plain(html) };
  }).filter((it) => it.title && it.link.startsWith("https://"));
}

// GitHub のリリース一覧が読めない時は CHANGELOG.md から版ごとに切り出す。
// CHANGELOG には日付がないので、前回見つけた日時を引き継ぎ、初めて見た版は今の時刻にする。
async function claudeCodeFromChangelog(prev) {
  const res = await fetch("https://raw.githubusercontent.com/anthropics/claude-code/main/CHANGELOG.md");
  if (!res.ok) throw new Error("CHANGELOG HTTP " + res.status);
  const md = await res.text();
  const now = Date.now();
  return md.split(/^## /m).slice(1, PER_SOURCE + 1).map((sec, i) => {
    const ver = sec.split("\n")[0].trim();
    const link = "https://github.com/anthropics/claude-code/releases/tag/v" + ver;
    return { title: "v" + ver, link, date: prev.get(link)?.date ?? now - i * 60000, img: "", text: sec.slice(ver.length).trim() };
  });
}

async function fetchFeed(url) {
  const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 (claude-dispatch feed reader)" } });
  if (!res.ok) throw new Error("HTTP " + res.status);
  const items = parse(await res.text());
  if (!items.length) throw new Error("記事が見つかりませんでした");
  return items;
}

async function fetchSource(s, prev) {
  try {
    return await fetchFeed(s.url);
  } catch (e) {
    if (s.alt) return fetchFeed(s.alt);
    if (s.changelog) return claudeCodeFromChangelog(prev);
    throw e;
  }
}

// ---- 日本語の要約（ANTHROPIC_API_KEY がある時だけ） ----

const SUMMARY_SCHEMA = {
  type: "object",
  properties: {
    items: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "integer" },
          title: { type: "string", description: "自然な日本語の見出し（40字以内）" },
          summary: { type: "string", description: "何が起きた・何が変わったかを伝える日本語の要約（120字以内）" }
        },
        required: ["id", "title", "summary"],
        additionalProperties: false
      }
    }
  },
  required: ["items"],
  additionalProperties: false
};

const DIGEST_SCHEMA = {
  type: "object",
  properties: {
    headline: { type: "string", description: "この1週間を一言で表す日本語の見出し（30字以内）" },
    points: {
      type: "array",
      description: "重要な順に3〜7件",
      items: {
        type: "object",
        properties: {
          text: { type: "string", description: "日本語で1〜2文（100字以内）" },
          ids: { type: "array", items: { type: "integer" }, description: "根拠にした記事の id" }
        },
        required: ["text", "ids"],
        additionalProperties: false
      }
    }
  },
  required: ["headline", "points"],
  additionalProperties: false
};

async function ask(client, system, content, schema, maxTokens) {
  const res = await client.beta.messages.create({
    model: MODEL,
    max_tokens: maxTokens,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    output_config: { effort: "low", format: { type: "json_schema", schema } },
    system,
    messages: [{ role: "user", content }]
  });
  if (res.stop_reason === "refusal") throw new Error("要約を断られました");
  if (res.stop_reason === "max_tokens") throw new Error("出力が上限で切れました");
  const text = res.content.filter((b) => b.type === "text").map((b) => b.text).join("");
  return JSON.parse(text);
}

const SYSTEM_SUMMARY =
  "あなたは日本語のテックニュース編集者です。Claude と Anthropic に関する英語の記事を、日本の読者向けに短くまとめます。" +
  "製品名・機能名・コマンド名は英語のまま残し、誇張せず、本文にないことは書きません。" +
  "Claude Code のリリースは、利用者にとって目立つ変更を2〜3点に絞って書きます。" +
  "障害情報は、何が使えなかったかと現在の状況を書きます。";

async function summarize(client, items) {
  for (let i = 0; i < items.length; i += 10) {
    const batch = items.slice(i, i + 10);
    const input = batch.map((it, j) =>
      `<article id="${j}" source="${it.src}">\n<title>${it.title}</title>\n<text>${clip(it.text || "", 4000)}</text>\n</article>`).join("\n");
    try {
      const out = await ask(client, SYSTEM_SUMMARY, input + "\n\n各記事について、日本語の見出しと要約を返してください。", SUMMARY_SCHEMA, 8000);
      for (const r of out.items) {
        const it = batch[r.id];
        if (it && r.title && r.summary) it.ja = { title: r.title, summary: r.summary };
      }
    } catch (e) {
      console.log("要約に失敗:", e.message || e);
    }
  }
}

async function makeDigest(client, items) {
  const input = items.map((it, i) =>
    `<article id="${i}" source="${it.src}" date="${new Date(it.date).toISOString().slice(0, 10)}">${it.ja ? it.ja.title + "：" + it.ja.summary : it.title}</article>`).join("\n");
  const out = await ask(
    client,
    "あなたは日本語のテックニュース編集者です。Claude と Anthropic に関するこの1週間の記事一覧から、利用者が知っておくべきことを重要な順にまとめます。" +
      "公式発表・新機能・料金や提供範囲の変化・大きな障害を優先し、似た記事はまとめます。記事にないことは書きません。",
    input + "\n\nこの1週間のまとめを返してください。",
    DIGEST_SCHEMA,
    4000
  );
  return {
    at: Date.now(),
    headline: out.headline,
    points: out.points.map((p) => ({ text: p.text, links: p.ids.map((i) => items[i]?.link).filter(Boolean) }))
  };
}

// ---- 本体 ----

const prevData = await readFile(OUT, "utf8").then(JSON.parse).catch(() => ({ items: [] }));
const prev = new Map(prevData.items.map((it) => [it.link, it]));

const out = { updatedAt: Date.now(), sources: {}, items: [], digest: prevData.digest ?? null };
const fullText = new Map(); // 要約に渡す本文。feeds.json には短い抜粋しか残さない
for (const s of SOURCES) {
  try {
    const items = (await fetchSource(s, prev)).slice(0, s.per ?? PER_SOURCE);
    out.sources[s.id] = { ok: true, count: items.length };
    for (const { text, ...it } of items) {
      fullText.set(it.link, text);
      const old = prev.get(it.link);
      out.items.push({ src: s.id, ...it, desc: clip(text.replace(/\n/g, " "), 160), ...(old?.ja ? { ja: old.ja } : {}) });
    }
  } catch (e) {
    // 読めなかった情報源は前回の内容を残す
    out.sources[s.id] = { ok: false, error: String(e.message || e) };
    out.items.push(...prevData.items.filter((it) => it.src === s.id));
  }
  console.log(s.id, JSON.stringify(out.sources[s.id]));
}

const seen = new Set();
out.items = out.items.filter((it) => (seen.has(it.link) ? false : seen.add(it.link))).sort((a, b) => b.date - a.date);

if (process.env.ANTHROPIC_API_KEY) {
  const client = new Anthropic();
  const aiIds = new Set(SOURCES.filter((s) => s.ai).map((s) => s.id));
  const since = Date.now() - SUMMARIZE_DAYS * 864e5;
  const todo = out.items
    .filter((it) => aiIds.has(it.src) && !it.ja && it.date > since)
    .slice(0, SUMMARIZE_PER_RUN)
    .map((it) => Object.assign(it, { text: fullText.get(it.link) || it.desc }));
  if (todo.length) {
    console.log("要約:", todo.length + "件");
    await summarize(client, todo);
    for (const it of todo) delete it.text;
  }

  // 直近1週間の顔ぶれが変わった時だけ、まとめを作り直す
  const week = out.items.filter((it) => it.date > Date.now() - DIGEST_DAYS * 864e5 && it.src !== "zenn" && it.src !== "qiita").slice(0, 80);
  const key = createHash("sha1").update(week.map((it) => it.link).sort().join("\n")).digest("hex");
  if (week.length && key !== prevData.digestKey) {
    try {
      out.digest = await makeDigest(client, week);
      out.digestKey = key;
      console.log("まとめを更新");
    } catch (e) {
      console.log("まとめに失敗:", e.message || e);
      out.digestKey = prevData.digestKey;
    }
  } else {
    out.digestKey = prevData.digestKey;
  }
} else {
  out.digestKey = prevData.digestKey;
  console.log("ANTHROPIC_API_KEY がないため、要約は作りません");
}

await writeFile(OUT, JSON.stringify(out, null, 1) + "\n");
