// Runs on a schedule (see setup/add_bot_activity_log.sql, every 10 min via
// pg_cron). Groups unnotified bot_activity_log rows by chat_id, and for any
// chat whose most recent action is already 10+ minutes old (a "clear
// break" in what they were doing), posts one consolidated summary to
// MeenshaMonitor instead of a separate message per action. Chats still
// mid-session (last action under 10 min old) are left pending — a later
// run picks them up once they actually pause.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const BREAK_MS = 10 * 60 * 1000;

const ACTION_LABELS: Record<string, string> = {
  sale: "🛍️ Sale",
  razorpay_link: "💳 Razorpay link sent",
  stock_intake: "📦 Stock intake submitted",
  voucher: "🎟️ Voucher created",
  event_form: "📋 Event form created",
  insta_link: "🔗 Insta link generated",
};

Deno.serve(async () => {
  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  const { data: pending } = await supabase
    .from("bot_activity_log")
    .select("*")
    .eq("notified", false)
    .order("created_at", { ascending: true });

  if (!pending?.length) return new Response("ok");

  const byChat = new Map<string, typeof pending>();
  for (const row of pending) {
    if (!byChat.has(row.chat_id)) byChat.set(row.chat_id, []);
    byChat.get(row.chat_id)!.push(row);
  }

  const monitorToken = Deno.env.get("TELEGRAM_MONITOR_BOT_TOKEN");
  const { data: settingsRow } = await supabase
    .from("settings").select("value").eq("key", "telegram_monitor_chat_id").maybeSingle();
  const monitorChatId = settingsRow?.value;

  for (const [chatId, rows] of byChat) {
    const lastAt = new Date(rows[rows.length - 1].created_at).getTime();
    if (Date.now() - lastAt < BREAK_MS) continue; // still an active session — wait for the real break

    const bot = rows[0].bot as string;
    const botTag = bot === "au" ? "🇦🇺 AU" : "🇮🇳 India";
    const sym = bot === "au" ? "A$" : "₹";
    const actor = rows[0].actor || `Chat ${chatId}`;

    const counts: Record<string, { n: number; amt: number }> = {};
    for (const r of rows) {
      const c = counts[r.action] ?? { n: 0, amt: 0 };
      c.n += 1;
      c.amt += Number(r.amount) || 0;
      counts[r.action] = c;
    }
    const lines = Object.entries(counts).map(([action, c]) => {
      const label = ACTION_LABELS[action] || action;
      return c.amt > 0 ? `${label} ×${c.n} — ${sym}${c.amt}` : `${label} ×${c.n}`;
    });

    const text = `📋 ${actor} (${botTag}) — session summary\n${lines.join("\n")}`;

    if (monitorToken && monitorChatId) {
      try {
        await fetch(`https://api.telegram.org/bot${monitorToken}/sendMessage`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ chat_id: monitorChatId, text }),
        });
      } catch { /* best-effort — still mark notified below, no point retrying stale activity */ }
    }

    const ids = rows.map((r) => r.id);
    await supabase.from("bot_activity_log").update({ notified: true }).in("id", ids);
  }

  return new Response("ok");
});
