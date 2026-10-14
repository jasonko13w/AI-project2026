// Supabase Edge Function：menu-ai
// 用途：把 Azure AI Vision 讀出的「文字＋位置」交給 Azure OpenAI（例如 gpt-4o-mini），依語意整理成乾淨的菜單 [[品名, 價格]]。
// 處理幾何規則難以處理的情況：直式（由上往下寫）、手寫、大/小份、單點/套餐等多個價格。
// 需要在 Supabase 的 Secrets 設定：
//   AZURE_OPENAI_ENDPOINT    例如 https://xxxx.openai.azure.com/
//   AZURE_OPENAI_KEY         Azure OpenAI 的金鑰
//   AZURE_OPENAI_DEPLOYMENT  部署名稱，例如 gpt-4o-mini
// 金鑰只存在這裡，網頁拿不到。

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const API_VERSION = "2024-10-21";
const MAX_LINES = 400;

function reply(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });
}

const SYSTEM = `你是台灣餐廳的菜單整理助手。你會收到一張菜單照片，以及 OCR 從照片讀出的文字（每行格式「x,y,寬,高|文字」，座標單位是像素）。
OCR 文字只是參考，可能有錯字、漏字，或把價格和品名拆開；請以照片為準，自己看懂菜單。
規則：
1. 只輸出菜單上真的有的品項與價格，不要編造。
2. 菜單可能是手寫、直式、多欄，價格可能是後來貼上的小紙條或貼紙；請判斷每個價格屬於哪個品項。貼紙蓋在原價上時，以貼紙上的價格為準。
3. 一個價格同時對應多種做法（例如「排骨 飯／麵 90」），請拆成多筆，例如「排骨飯」「排骨麵」都是 90。
4. 同一品項有多個價格（大/小、單點/套餐、中碗/大碗、杯/瓶），請拆成多筆，品名後面用全形括號標註，例如「貢丸湯（大）」「貢丸湯（小）」。
5. 加價項目（例如「加麵 +20」「加大 10元」）也要輸出，品名照寫（例如「加麵」「加大」），價格寫加價的金額。
6. 價格只保留整數新台幣數字（去掉「元」「$」「+」等符號）。看不出價格的品項不要輸出。
7. 忽略店名、標語、電話、地址、營業時間、分類標題（例如「湯品」「炸物」「飲料」）。
8. 品名用正確的中文寫出來：手寫錯字、用字母或同音字代替的簡寫，要還原成常見寫法（例如「魯肉飯」寫成「滷肉飯」、「蕃茄」寫成「番茄」）。
只輸出 JSON，格式：{"items":[{"name":"品名","price":數字}]}`;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return reply(405, { error: "method_not_allowed" });

  // 端點只取「https://主機名稱」：貼完整的 Target URI（含 /openai/deployments/...）也沒關係
  let endpoint = (Deno.env.get("AZURE_OPENAI_ENDPOINT") || "").trim();
  try { endpoint = new URL(endpoint).origin; } catch { endpoint = endpoint.replace(/\/+$/, ""); }
  const key = Deno.env.get("AZURE_OPENAI_KEY") || "";
  const deployment = Deno.env.get("AZURE_OPENAI_DEPLOYMENT") || "";
  if (!endpoint || !key || !deployment) return reply(500, { error: "not_configured" });

  // 只有登入的使用者可以用
  const auth = req.headers.get("Authorization") || "";
  const supaUrl = Deno.env.get("SUPABASE_URL") || "";
  const anon = Deno.env.get("SUPABASE_ANON_KEY") || req.headers.get("apikey") || "";
  if (!auth.startsWith("Bearer ")) return reply(401, { error: "login_required" });
  const who = await fetch(`${supaUrl}/auth/v1/user`, { headers: { Authorization: auth, apikey: anon } });
  if (!who.ok) return reply(401, { error: "login_required" });

  let body: { lines?: { text: string; box: number[] }[]; image?: string } = {};
  try { body = await req.json(); } catch { return reply(400, { error: "bad_json" }); }
  const lines = Array.isArray(body.lines) ? body.lines.slice(0, MAX_LINES) : [];
  // 照片（data:image/jpeg;base64,...），有的話讓模型直接看圖
  const image = typeof body.image === "string" && /^data:image\/(jpeg|png|webp);base64,/.test(body.image) && body.image.length < 6_000_000 ? body.image : "";
  if (!lines.length && !image) return reply(400, { error: "no_lines" });

  // 精簡成「x,y,寬,高|文字」，省 token
  const compact = lines.map((l) => {
    const b = Array.isArray(l.box) ? l.box.map(Number) : [];
    const xs = b.filter((_, i) => i % 2 === 0), ys = b.filter((_, i) => i % 2 === 1);
    const x1 = xs.length ? Math.min(...xs) : 0, y1 = ys.length ? Math.min(...ys) : 0;
    const w = xs.length ? Math.max(...xs) - x1 : 0, h = ys.length ? Math.max(...ys) - y1 : 0;
    return `${Math.round(x1)},${Math.round(y1)},${Math.round(w)},${Math.round(h)}|${String(l.text || "").slice(0, 80)}`;
  }).join("\n");

  try {
    const r = await fetch(`${endpoint}/openai/deployments/${encodeURIComponent(deployment)}/chat/completions?api-version=${API_VERSION}`, {
      method: "POST",
      headers: { "api-key": key, "Content-Type": "application/json" },
      body: JSON.stringify({
        messages: [
          { role: "system", content: SYSTEM },
          image
            ? { role: "user", content: [
                { type: "text", text: "OCR 參考文字（可能有錯）：\n" + (compact || "（沒有讀到文字）") },
                { type: "image_url", image_url: { url: image, detail: "high" } },
              ] }
            : { role: "user", content: compact },
        ],
        temperature: 0,
        max_tokens: 4000,
        response_format: { type: "json_object" },
      }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) return reply(502, { error: "azure_" + r.status + ":" + ((j && j.error && (j.error.code || j.error.message)) || "") });
    const text = j && j.choices && j.choices[0] && j.choices[0].message ? j.choices[0].message.content : "";
    let parsed: { items?: { name?: unknown; price?: unknown }[] } = {};
    try { parsed = JSON.parse(text || "{}"); } catch { return reply(502, { error: "bad_ai_output" }); }
    // 再檢查一次：品名合理、價格是合理的整數
    const seen = new Set<string>();
    const items: [string, number][] = [];
    for (const it of parsed.items || []) {
      const name = String(it && it.name || "").replace(/\s+/g, " ").trim().slice(0, 40);
      const price = Math.round(Number(String(it && it.price || "").replace(/[^\d.]/g, "")));
      if (!name || !/[一-鿿A-Za-z]/.test(name)) continue;
      if (!(price >= 1 && price <= 99999)) continue;
      if (seen.has(name)) continue;
      seen.add(name);
      items.push([name, price]);
    }
    const usage = j.usage || {};
    return reply(200, { items, vision: !!image, usage: { in: usage.prompt_tokens || 0, out: usage.completion_tokens || 0 } });
  } catch (e) {
    return reply(502, { error: String((e as Error).message || e) });
  }
});
