// URLを受け取り、SNS投稿の中身(キャプション)→店名→住所 を返すサーバー関数
const { onRequest } = require("firebase-functions/v2/https");

// 取得してよいサイトだけに限定(関係ないサイトへのアクセスに悪用されないように)
const ALLOWED = [
  /(^|\.)tiktok\.com$/,
  /(^|\.)instagram\.com$/,
  /(^|\.)lemon8-app\.com$/,
  /(^|\.)youtube\.com$/,
  /^youtu\.be$/,
];
const UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";
const UA_PC =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";
const CATS = ["ごはん", "カフェ", "旅行", "おでかけ", "その他"];

function isAllowed(u) {
  try {
    const x = new URL(u);
    return /^https?:$/.test(x.protocol) && ALLOWED.some((r) => r.test(x.hostname.toLowerCase()));
  } catch {
    return false;
  }
}

// 短縮URL(vt.tiktok.com など)を1段ずつたどって、最終URLとHTMLを得る
async function resolve(url) {
  let cur = url;
  for (let i = 0; i < 6; i++) {
    if (!isAllowed(cur)) throw new Error("対応していないサイトです");
    const r = await fetch(cur, {
      redirect: "manual",
      headers: { "user-agent": UA, "accept-language": "ja,en;q=0.8" },
      signal: AbortSignal.timeout(8000),
    });
    const loc = r.headers.get("location");
    if (r.status >= 300 && r.status < 400 && loc) {
      cur = new URL(loc, cur).toString();
      continue;
    }
    return { finalUrl: cur, status: r.status, html: r.ok ? await r.text() : "" };
  }
  throw new Error("リダイレクトが多すぎます");
}

function decode(s) {
  return String(s || "")
    .replace(/&quot;/g, '"').replace(/&#39;|&#x27;/g, "'")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, "&");
}
function meta(html, key) {
  const a = new RegExp(`<meta[^>]+(?:property|name)=["']${key}["'][^>]*content=["']([^"']*)["']`, "i").exec(html);
  const b = new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]*(?:property|name)=["']${key}["']`, "i").exec(html);
  return decode((a || b || [])[1] || "");
}

async function getJson(url, debug, label) {
  try {
    const r = await fetch(url, {
      headers: { "user-agent": UA, accept: "application/json", "accept-language": "ja,en;q=0.8" },
      signal: AbortSignal.timeout(8000),
    });
    debug[label + "Status"] = r.status;
    if (!r.ok) { debug[label + "Body"] = (await r.text()).slice(0, 200); return null; }
    return await r.json();
  } catch (e) {
    debug[label + "Error"] = String(e && e.message || e);
    return null;
  }
}

async function pageHtml(u, ua) {
  try {
    const r = await fetch(u, { headers: { "user-agent": ua, "accept-language": "ja,en;q=0.8" }, signal: AbortSignal.timeout(8000) });
    return r.ok ? await r.text() : "";
  } catch { return ""; }
}
function descsIn(html) {
  const out = [];
  if (!html) return out;
  for (const m of html.matchAll(/"(?:desc|description)":"((?:[^"\\]|\\.)*)"/g)) { try { out.push(JSON.parse('"' + m[1] + '"')); } catch {} }
  out.push(meta(html, "og:description") || "", meta(html, "description") || "");
  return out;
}

// 投稿のキャプション・投稿者・サムネイルを取る
async function fetchPost(url) {
  const { finalUrl, status, html } = await resolve(url);
  const host = new URL(finalUrl).hostname;
  const canon = finalUrl.split("?")[0]; // ?is_from_webapp=1 などの余計な部分を外す
  const debug = { finalUrl, pageStatus: status, htmlLength: html.length };
  let caption = "", author = "", thumb = "";

  if (/tiktok\.com$/.test(host)) {
    const o = await getJson("https://www.tiktok.com/oembed?url=" + encodeURIComponent(canon), debug, "oembed");
    if (o) { caption = o.title || ""; author = o.author_name || ""; thumb = o.thumbnail_url || ""; }
  } else if (/youtube\.com$|youtu\.be$/.test(host)) {
    const o = await getJson("https://www.youtube.com/oembed?format=json&url=" + encodeURIComponent(canon), debug, "oembed");
    if (o) { caption = o.title || ""; author = o.author_name || ""; thumb = o.thumbnail_url || ""; }
  }
  // ページ側の説明文も集めて、いちばん長いものを使う(oEmbedは短く切られることがある)
  const cands = [caption];
  cands.push(meta(html, "og:description") || "", meta(html, "description") || "");
  if (html) {
    for (const m of html.matchAll(/"desc":"((?:[^"\\]|\\.)*)"/g)) { try { cands.push(JSON.parse('"' + m[1] + '"')); } catch {} }
  }
  // TikTokは説明文が短く切られることがあるので、埋め込みページなど別の入口からも集める
  const vid = (canon.match(/\/video\/(\d+)/) || [])[1];
  if (/tiktok\.com$/.test(host) && vid) {
    const pages = await Promise.all([
      pageHtml("https://www.tiktok.com/embed/v2/" + vid, UA),
      pageHtml("https://www.tiktok.com/embed/v2/" + vid, UA_PC),
      pageHtml(canon, UA_PC),
    ]);
    pages.forEach((p) => cands.push(...descsIn(p)));
    debug.extraHtml = pages.map((p) => p.length);
    for (const p of pages) { if (!thumb) thumb = meta(p, "og:image") || (/"(?:cover|originCover|dynamicCover)":"([^"]+)"/.exec(p) || [])[1]?.replace(/\\u002F/g, "/") || ""; }
  }
  caption = cands.reduce((a, c) => (c && c.length > a.length ? c : a), "") || meta(html, "og:title") || "";
  debug.candLens = cands.map((c) => (c || "").length);
  if (!thumb) thumb = meta(html, "og:image");
  debug.captionLength = caption.length;
  return { finalUrl, caption: caption.trim(), author, thumb, debug };
}

// キャプションから店名などをAIで抜き出す
// GEMINI_API_KEY があればGemini(無料枠あり)、なければ ANTHROPIC_API_KEY があればClaudeを使う
let AI_ERR = "";
let IMG_ERR = "";
async function fetchImage(u) {
  IMG_ERR = "";
  if (!/^https:\/\//.test(u || "")) return null;
  try {
    const r = await fetch(u, { signal: AbortSignal.timeout(8000), headers: { "user-agent": UA_PC, referer: "https://www.tiktok.com/", accept: "image/avif,image/webp,image/*,*/*;q=0.8" } });
    IMG_ERR = "status " + r.status;
    if (!r.ok) return null;
    const mime = (r.headers.get("content-type") || "").split(";")[0];
    IMG_ERR = "type " + mime;
    if (!/^image\/(jpeg|png|webp|avif)/.test(mime)) return null;
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length > 4e6) return null;
    return { mime, b64: buf.toString("base64") };
  } catch { return null; }
}
async function extract(caption, author, img) {
  AI_ERR = "";
  if (!caption && !img) { AI_ERR = "no caption"; return null; }
  const gKey = process.env.GEMINI_API_KEY, cKey = process.env.ANTHROPIC_API_KEY;
  if (!gKey && !cKey) { AI_ERR = "no AI key in env"; return null; }
  const prompt =
    (img ? `添付はSNS動画のサムネイル画像です。画像内の文字(店名・看板・テロップ・住所)とキャプションから、紹介されているお店・スポットを、すべて(最大10件)抜き出し、JSONだけを返してください。画像に読み取れる文字がなければ空で構いません。\n` : `次はSNS投稿のキャプションです。紹介されているお店・スポットを、すべて(最大10件)抜き出し、JSONだけを返してください。\n`) +
    `形式: {"spots":[{"name":"店名や場所名","address":"キャプションに書かれた住所(なければ空)","area":"地名・駅名など(なければ空)","cat":"${CATS.join("|")}のどれか","memo":"特徴を60字以内"}]}\n` +
    `ハッシュタグ(#店名)、住所の断片、駅名+店名、略称、絵文字や記号で区切られた書き方、「📍」「📌」「住所」「場所」の後ろの文字も手がかりにして、お店・スポット名を探してください。` +
    `店名が明記されていなくても、住所や地名・建物名だけで場所が分かるなら、その場所名を name に入れてください。` +
    `アカウント名(@から始まる文字)や投稿者名はスポット名ではありません。キャプションにまったく根拠のない店名は作らないこと。\n` +
    `スポットが1つも見つからなければ {"spots":[]} を返すこと。\n\n投稿者: ${author}\nキャプション:\n${caption}`;
  let text = "";
  if (gKey) {
    const model = process.env.GEMINI_MODEL || "gemini-2.5-flash-lite";
    let r;
    for (let k = 0; k < 3; k++) {
    r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
      method: "POST",
      headers: { "x-goog-api-key": gKey, "content-type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }, ...(img ? [{ inlineData: { mimeType: img.mime, data: img.b64 } }] : [])] }],
        generationConfig: { temperature: 0, maxOutputTokens: 2000, responseMimeType: "application/json" },
      }),
      signal: AbortSignal.timeout(20000),
    });
    if ((r.status === 503 || r.status === 429) && k < 2) { await new Promise((z) => setTimeout(z, 1500 * (k + 1))); continue; }
    break;
    }
    if (!r.ok) { const b = await r.text(); console.error("Gemini API", r.status, b); AI_ERR = "Gemini " + r.status + " " + b.slice(0, 300); return null; }
    const j = await r.json();
    text = ((j.candidates || [])[0]?.content?.parts || []).map((x) => x.text || "").join("");
  } else {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": cKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({
        model: process.env.CLAUDE_MODEL || "claude-haiku-5-5",
        max_tokens: 2000,
        messages: [{ role: "user", content: img ? [{ type: "image", source: { type: "base64", media_type: img.mime, data: img.b64 } }, { type: "text", text: prompt }] : prompt }],
      }),
      signal: AbortSignal.timeout(20000),
    });
    if (!r.ok) { const b = await r.text(); console.error("Claude API", r.status, b); AI_ERR = "Claude " + r.status + " " + b.slice(0, 300); return null; }
    const j = await r.json();
    text = (j.content || []).map((c) => c.text || "").join("");
  }
  const m = text.match(/\{[\s\S]*\}/);
  try { if (!m) { AI_ERR = "no JSON in: " + text.slice(0, 200); return null; } return JSON.parse(m[0]); } catch { AI_ERR = "bad JSON: " + text.slice(0, 200); return null; }
}

// 店名から住所・地図URLをGoogle Placesで探す(GOOGLE_PLACES_KEY があるときだけ)
async function findPlace(name, area) {
  const key = process.env.GOOGLE_PLACES_KEY;
  if (!key || !name) return null;
  const r = await fetch("https://places.googleapis.com/v1/places:searchText", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "X-Goog-Api-Key": key,
      "X-Goog-FieldMask": "places.displayName,places.formattedAddress,places.location,places.googleMapsUri",
    },
    body: JSON.stringify({ textQuery: [name, area].filter(Boolean).join(" "), languageCode: "ja", regionCode: "JP" }),
    signal: AbortSignal.timeout(8000),
  });
  if (!r.ok) { console.error("Places API", r.status, await r.text()); return null; }
  const p = ((await r.json()).places || [])[0];
  if (!p) return null;
  return {
    placeName: p.displayName?.text || "",
    address: (p.formattedAddress || "").replace(/^日本、(〒\d{3}-\d{4} )?/, ""),
    lat: p.location?.latitude ?? null,
    lng: p.location?.longitude ?? null,
    mapsUrl: p.googleMapsUri || "",
  };
}

exports.parse = onRequest({ region: "us-central1", cors: true, timeoutSeconds: 40 }, async (req, res) => {
  if (req.method !== "POST") return res.status(405).json({ error: "POSTのみ" });
  // 店名だけで住所・座標を探すモード(手入力で追加するとき用)
  if (req.body && req.body.query) {
    try {
      const place = await findPlace(String(req.body.query).slice(0, 100), "");
      return res.json({ place: place || null });
    } catch (e) {
      console.error(e);
      return res.status(502).json({ error: "場所を検索できませんでした" });
    }
  }
  const pasted = String((req.body && req.body.text) || "").trim().slice(0, 8000);
  const url = String((req.body && req.body.url) || "").trim().match(/https?:\/\/\S+/)?.[0];
  if (!pasted && (!url || !isAllowed(url))) return res.status(400).json({ error: "TikTok / Instagram / Lemon8 / YouTube のURLを貼ってください" });
  try {
    const post = pasted ? { finalUrl: url || "", caption: pasted, author: "", thumb: "", debug: { pasted: true } } : await fetchPost(url);
    const pick = (ex) => { const l = Array.isArray(ex?.spots) ? ex.spots : (ex?.name ? [ex] : []); return l.filter((s) => s && s.name).slice(0, 10); };
    const run = (img) => extract(post.caption, post.author, img).catch((e) => { AI_ERR = "exception " + e.message; return null; });
    let list = pick(await run(null));
    let fromImage = false;
    if (!list.length && !AI_ERR) {
      // キャプションに無いときは、サムネイル画像の文字を読む
      const img = await fetchImage(post.thumb);
      if (img) { list = pick(await run(img)); fromImage = list.length > 0; }
      else AI_ERR = "キャプションに店名がなく、サムネイル画像も取得できませんでした(" + (IMG_ERR || (post.thumb ? "取得失敗" : "サムネなし")) + ")";
    }
    const spots = await Promise.all(list.map(async (s) => {
      const place = await findPlace(s.name, s.address || s.area).catch(() => null);
      return {
        name: place?.placeName || s.name,
        cat: CATS.includes(s.cat) ? s.cat : "",
        memo: s.memo || "",
        address: place?.address || s.address || "",
        lat: place?.lat ?? null,
        lng: place?.lng ?? null,
        mapsUrl: place?.mapsUrl || "",
      };
    }));
    const first = spots[0] || {};
    console.log("PARSE", JSON.stringify({ capLen: (post.caption || "").length, caption: (post.caption || "").slice(0, 80), candLens: post.debug && post.debug.candLens, extraHtml: post.debug && post.debug.extraHtml, thumb: (post.thumb || "").slice(0, 80), spots: spots.length, fromImage, aiError: AI_ERR }));
    res.json({
      url: post.finalUrl,
      caption: post.caption,
      author: post.author,
      thumb: post.thumb,
      debug: post.debug,
      aiError: AI_ERR,
      fromImage,
      spots,
      // 1件目は、これまでどおりの項目でも返す
      name: first.name || "",
      cat: first.cat || "",
      memo: first.memo || (first.name ? "" : post.caption.slice(0, 120)),
      address: first.address || "",
      lat: first.lat ?? null,
      lng: first.lng ?? null,
      mapsUrl: first.mapsUrl || "",
    });
  } catch (e) {
    console.error(e);
    res.status(502).json({ error: "投稿を読み込めませんでした: " + e.message });
  }
});
