// Supabase Edge Function：menu-ocr
// 用途：替網頁保管 Azure 金鑰。網頁把菜單照片交給這裡 → 確認是登入的使用者 → 交給 Azure AI Vision 讀字 → 回傳一行一行的文字與位置。
// 需要在 Supabase 的 Secrets 設定：AZURE_VISION_ENDPOINT、AZURE_VISION_KEY（金鑰只存在這裡，網頁看不到）

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const MAX_BYTES = 4 * 1024 * 1024; // 照片最大 4MB（網頁會先縮小）

function reply(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });
}

type Line = { text: string; box: number[] };

// 新版（Image Analysis 4.0）：一次就回結果
async function readV4(endpoint: string, key: string, img: Uint8Array): Promise<Line[] | null> {
  const r = await fetch(`${endpoint}/computervision/imageanalysis:analyze?api-version=2024-02-01&features=read`, {
    method: "POST",
    headers: { "Ocp-Apim-Subscription-Key": key, "Content-Type": "application/octet-stream" },
    body: img,
  });
  if (r.status === 404) return null; // 這個地區不支援新版，改用舊版
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error("azure_" + r.status + ":" + ((j && j.error && (j.error.code || j.error.message)) || ""));
  const out: Line[] = [];
  for (const b of (j.readResult && j.readResult.blocks) || []) {
    for (const ln of b.lines || []) {
      out.push({ text: String(ln.text || ""), box: (ln.boundingPolygon || []).flatMap((p: { x: number; y: number }) => [p.x, p.y]) });
    }
  }
  return out;
}

// 舊版（Read 3.2）：先送出，再輪詢結果
async function readV32(endpoint: string, key: string, img: Uint8Array): Promise<Line[]> {
  const r = await fetch(`${endpoint}/vision/v3.2/read/analyze`, {
    method: "POST",
    headers: { "Ocp-Apim-Subscription-Key": key, "Content-Type": "application/octet-stream" },
    body: img,
  });
  if (r.status !== 202) {
    const j = await r.json().catch(() => ({}));
    throw new Error("azure_" + r.status + ":" + ((j && j.error && (j.error.code || j.error.message)) || ""));
  }
  const loc = r.headers.get("Operation-Location");
  if (!loc) throw new Error("azure_no_location");
  for (let i = 0; i < 20; i++) {
    await new Promise((ok) => setTimeout(ok, 800));
    const g = await fetch(loc, { headers: { "Ocp-Apim-Subscription-Key": key } });
    const j = await g.json().catch(() => ({}));
    if (j.status === "succeeded") {
      const out: Line[] = [];
      for (const page of (j.analyzeResult && j.analyzeResult.readResults) || []) {
        for (const ln of page.lines || []) out.push({ text: String(ln.text || ""), box: ln.boundingBox || [] });
      }
      return out;
    }
    if (j.status === "failed") throw new Error("azure_read_failed");
  }
  throw new Error("azure_timeout");
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return reply(405, { error: "method_not_allowed" });

  const endpoint = (Deno.env.get("AZURE_VISION_ENDPOINT") || "").replace(/\/+$/, "");
  const key = Deno.env.get("AZURE_VISION_KEY") || "";
  if (!endpoint || !key) return reply(500, { error: "not_configured" });

  // 只有登入的使用者可以用（避免別人拿去刷你的 Azure 費用）
  const auth = req.headers.get("Authorization") || "";
  const supaUrl = Deno.env.get("SUPABASE_URL") || "";
  const anon = Deno.env.get("SUPABASE_ANON_KEY") || "";
  const who = await fetch(`${supaUrl}/auth/v1/user`, { headers: { Authorization: auth, apikey: anon } });
  if (!who.ok) return reply(401, { error: "login_required" });

  const img = new Uint8Array(await req.arrayBuffer());
  if (!img.length) return reply(400, { error: "no_image" });
  if (img.length > MAX_BYTES) return reply(413, { error: "image_too_large" });

  try {
    const lines = (await readV4(endpoint, key, img)) ?? (await readV32(endpoint, key, img));
    return reply(200, { lines });
  } catch (e) {
    return reply(502, { error: String((e as Error).message || e) });
  }
});
