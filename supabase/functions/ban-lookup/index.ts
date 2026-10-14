// Supabase Edge Function：ban-lookup
// 用途：用統一編號查經濟部商工登記公示資料（公開資料），回傳登記名稱，讓店家不用自己打店名。
// 呼叫方式：GET /functions/v1/ban-lookup?ban=12345678
// 回傳：{ name:"登記名稱" }，查不到時 { name:"" }
// 不需要任何金鑰（政府開放資料）。注意：商工登記開放平臺可能限制來源 IP，查不到時網頁會請店家直接輸入店名。

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
};
function reply(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });
}
// 財政部檢查碼規則：加權後各位數相加能被 5 整除；第 7 碼是 7 時有特例
function banOk(s: string) {
  if (!/^\d{8}$/.test(s)) return false;
  const w = [1, 2, 1, 2, 1, 2, 4, 1];
  let t = 0;
  for (let i = 0; i < 8; i++) { const p = Number(s[i]) * w[i]; t += Math.floor(p / 10) + (p % 10); }
  return t % 5 === 0 || (s[6] === "7" && (t + 1) % 5 === 0);
}
const BASE = "https://data.gcis.nat.gov.tw/od/data/api/";
// 公司登記基本資料-應用一、商業登記基本資料-應用一（行號）
const SOURCES = [
  { id: "5F64D864-61CB-4D0D-8AD9-492047CC1EA6", field: "Business_Accounting_NO", name: ["Company_Name"] },
  { id: "7E6AFA72-AD6A-46D3-8681-ED77951D912D", field: "President_No", name: ["Business_Name"] },
];

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const ban = new URL(req.url).searchParams.get("ban") || "";
  if (!banOk(ban)) return reply(400, { error: "bad_ban" });
  for (const s of SOURCES) {
    try {
      const url = `${BASE}${s.id}?$format=json&$filter=${s.field}%20eq%20${ban}&$skip=0&$top=1`;
      const r = await fetch(url, { headers: { "Accept": "application/json" } });
      if (!r.ok) continue;
      const text = await r.text();
      if (!text.trim()) continue;
      const j = JSON.parse(text);
      const row = Array.isArray(j) ? j[0] : null;
      if (!row) continue;
      for (const k of s.name) {
        const v = String(row[k] || "").trim();
        if (v) return reply(200, { name: v.slice(0, 60) });
      }
    } catch (_e) { /* 換下一個資料來源 */ }
  }
  return reply(200, { name: "" });
});
