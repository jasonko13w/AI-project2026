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

const SYSTEM = `你是台灣餐廳的菜單整理助手。你會收到用 OCR 從菜單照片讀出的文字，每一行格式是「x,y,寬,高|文字」（座標單位是像素，x 往右變大、y 往下變大）。
請根據語意與位置，把菜單整理成品項與價格。規則：
1. 只輸出菜單上真的有的品項，不要自己編造品項或價格。
2. 菜單可能是直式（文字由上往下寫、一欄一欄由右往左）、手寫、或多欄排列；請依座標與語意判斷哪個價格屬於哪個品項。
3. 同一個品項有多個價格（例如 大/小、單點/套餐、中碗/大碗、杯/瓶），請拆成多筆，品名後面用全形括號標註，例如「貢丸湯（大）」「貢丸湯（小）」。
4. 價格只保留整數新台幣數字（去掉「元」「$」「NT」等符號）。看不出價格的品項不要輸出。
5. 忽略店名、標語、電話、地址、營業時間、服務費說明、分類標題（例如「湯品」「炸物」）。
6. 品名保持菜單上的原文，修正明顯的 OCR 錯字可以，但不要翻譯或改寫。
只輸出 JSON，格式：{"items":[{"name":"品名","price":數字}]}`;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return reply(405, { error: "method_not_allowed" });

  const endpoint = (Deno.env.get("AZURE_OPENAI_ENDPOINT") || "").replace(/\/+$/, "");
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

  let body: { lines?: { text: string; box: number[] }[] } = {};
  try { body = await req.json(); } catch { return reply(400, { error: "bad_json" }); }
  const lines = Array.isArray(body.lines) ? body.lines.slice(0, MAX_LINES) : [];
  if (!lines.length) return reply(400, { error: "no_lines" });

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
        messages: [{ role: "system", content: SYSTEM }, { role: "user", content: compact }],
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
    return reply(200, { items, usage: { in: usage.prompt_tokens || 0, out: usage.completion_tokens || 0 } });
  } catch (e) {
    return reply(502, { error: String((e as Error).message || e) });
  }
});
