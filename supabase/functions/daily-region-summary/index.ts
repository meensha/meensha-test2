// Daily 9am-local summary for each region's own staff bot (India/Shalini,
// Australia/Meenakshi) — website/sales-logic health, stock count,
// fulfilments pending, and yesterday/last-week sales, in that region's own
// currency and scoped ONLY to that region's own data (never the other
// region's) — same isolation principle as Sales History/Godown on the bots
// themselves. Called once per region per day by pg_cron (see
// setup/add_daily_region_summary_cron.sql) with a POST body {"region":"india"}
// or {"region":"australia"} — two separate cron entries, since 9am IST and
// 9am AEST land at different UTC times.
//
// Required secrets: TELEGRAM_BOT_TOKEN, TELEGRAM_BOT_TOKEN_AU (already set).
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

Deno.serve(async (req: Request) => {
  const { region } = await req.json().catch(() => ({ region: null }));
  if (region !== "india" && region !== "australia") {
    return new Response(JSON.stringify({ error: "region must be 'india' or 'australia'" }), { status: 400 });
  }
  const isAu = region === "australia";
  const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const fmt = (n: number) => isAu ? `A$${n.toFixed(2)}` : `₹${n.toLocaleString("en-IN")}`;

  // Website + sales-logic health — same checks daily-health-check uses,
  // simplified to a plain ok/not-ok line for this digest.
  let websiteOk = false;
  try { websiteOk = (await fetch("https://meensha.in")).ok; } catch { /* stays false */ }
  let salesLogicOk = false;
  try { const { error } = await supabase.from("sales").select("id").limit(1); salesLogicOk = !error; } catch { /* stays false */ }

  // Stock: total SKUs with at least one available unit, scoped to this
  // region (AU: au_available only, matching Kiosk/Godown/everything else
  // built for AU. India: no filter, matching India's own Kiosk/stock-check,
  // which has never filtered by india_available).
  let skuQuery = supabase.from("inventory_skus").select("id");
  if (isAu) skuQuery = skuQuery.eq("au_available", true);
  const { data: skus } = await skuQuery;
  const skuIds = (skus ?? []).map((s: { id: string }) => s.id);
  let stockCount = 0;
  if (skuIds.length) {
    const { count } = await supabase.from("inventory_units").select("id", { count: "exact", head: true })
      .eq("status", "available").in("sku_id", skuIds);
    stockCount = count ?? 0;
  }

  // Fulfilments pending: shipping (sales awaiting dispatch/delivery) +
  // requests (open "Request a Saree" rows) — both scoped to this region's
  // own source/region tag, never the other region's.
  let shipQuery = supabase.from("sales").select("id", { count: "exact", head: true })
    .eq("delivery_mode", "shipping").not("shipping_status", "in", "(shipped,delivered)");
  shipQuery = isAu ? shipQuery.eq("source", "telegram_au") : shipQuery.neq("source", "telegram_au");
  const { count: shipPending } = await shipQuery;

  const { count: reqPending } = await supabase.from("requests").select("id", { count: "exact", head: true })
    .eq("region", region).in("status", ["new", "contacted"]);

  const totalPending = (shipPending ?? 0) + (reqPending ?? 0);

  // Sales: yesterday + last 7 days, this region's own sales only.
  const today = new Date();
  const yesterday = new Date(today); yesterday.setDate(yesterday.getDate() - 1);
  const weekAgo = new Date(today); weekAgo.setDate(weekAgo.getDate() - 7);
  const yStr = yesterday.toISOString().slice(0, 10);
  const wStr = weekAgo.toISOString().slice(0, 10);

  let ySalesQuery = supabase.from("sales").select("total").eq("date", yStr);
  ySalesQuery = isAu ? ySalesQuery.eq("source", "telegram_au") : ySalesQuery.neq("source", "telegram_au");
  const { data: yesterdaySales } = await ySalesQuery;
  const yesterdayTotal = (yesterdaySales ?? []).reduce((a: number, r: { total: number }) => a + Number(r.total || 0), 0);

  let wSalesQuery = supabase.from("sales").select("total").gte("date", wStr);
  wSalesQuery = isAu ? wSalesQuery.eq("source", "telegram_au") : wSalesQuery.neq("source", "telegram_au");
  const { data: weekSales } = await wSalesQuery;
  const weekTotal = (weekSales ?? []).reduce((a: number, r: { total: number }) => a + Number(r.total || 0), 0);

  const text = [
    `${isAu ? "🇦🇺" : "🇮🇳"} Good morning! Daily summary:`,
    "",
    `Website: ${websiteOk ? "✅ OK" : "🔴 Down"}`,
    `Sales logic: ${salesLogicOk ? "✅ OK" : "🔴 Issue"}`,
    "",
    `📦 Stock: ${stockCount} SKUs available`,
    `📋 Fulfilments pending: ${totalPending} (${shipPending ?? 0} shipping, ${reqPending ?? 0} requests/enquiries)`,
    "",
    `💰 Sales — Yesterday: ${fmt(yesterdayTotal)}, Last 7 days: ${fmt(weekTotal)}`,
    "",
    "Good day! Type /start to access menu.",
  ].join("\n");

  const token = isAu ? Deno.env.get("TELEGRAM_BOT_TOKEN_AU") : Deno.env.get("TELEGRAM_BOT_TOKEN");
  const allowlistTable = isAu ? "telegram_allowed_users_au" : "telegram_allowed_users";
  const { data: rows } = await supabase.from(allowlistTable).select("chat_id").eq("active", true);
  let sent = 0;
  for (const r of rows ?? []) {
    try {
      await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: r.chat_id, text }),
      });
      sent++;
    } catch { /* best-effort per recipient */ }
  }

  return new Response(JSON.stringify({ ok: true, region, sent, stockCount, totalPending, yesterdayTotal, weekTotal }), {
    headers: { "Content-Type": "application/json" },
  });
});
