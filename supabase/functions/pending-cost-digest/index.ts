// Daily digest of AU-market SKUs whose sourcing (INR) cost was skipped
// during Telegram stock intake and is still unknown — inventory_skus.cost
// IS NULL means "pending", not free (see setup/fix_stock_intake_pending_cost.sql).
// Same pattern as returns-pending-digest (skip sending entirely when
// there's nothing pending, triggered by pg_cron — see
// setup/add_pending_cost_digest_cron.sql), same audience: India staff
// (telegram-bot, every active chat_id) — Shalini is the one who can fill
// these in from the Telegram Maintenance menu or from the web admin panel.
//
// Required secret: TELEGRAM_BOT_TOKEN.
// Supabase auto-provides SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

async function sendTo(token: string, chatId: string, text: string) {
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text }),
    });
  } catch { /* best-effort — one failed send must not block the others */ }
}

Deno.serve(async (_req: Request) => {
  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  const { data: skus } = await supabase
    .from("inventory_skus")
    .select("name, display_variant, sku_code")
    .eq("au_available", true)
    .is("cost", null);

  const pending = skus ?? [];
  if (pending.length === 0) {
    return new Response(JSON.stringify({ pending: 0, sent: false }), { headers: { "Content-Type": "application/json" } });
  }

  const lines = pending.map((s: { name: string; display_variant?: string; sku_code: string }) =>
    `• ${s.name}${s.display_variant ? " (" + s.display_variant + ")" : ""} [${s.sku_code}]`
  );
  const text = `💰 Pending AU Purchase Costs (${pending.length})\n\nThese items were sourced for the AU market but still need their INR purchase cost entered — fill in from the Telegram Maintenance menu ("💰 Pending AU costs") or the Inventory tab on the web dashboard:\n\n${lines.join("\n")}`;

  const botToken = Deno.env.get("TELEGRAM_BOT_TOKEN");
  if (botToken) {
    const { data: allowedRows } = await supabase.from("telegram_allowed_users").select("chat_id").eq("active", true);
    for (const row of allowedRows ?? []) {
      await sendTo(botToken, row.chat_id, text);
    }
  }

  return new Response(JSON.stringify({ pending: pending.length, sent: true }), { headers: { "Content-Type": "application/json" } });
});
