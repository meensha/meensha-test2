// Best-effort log of one completed bot action (sale, voucher, stock intake,
// etc). Rolled up into a session summary for MeenshaMonitor once there's a
// clear gap in that chat's activity — see activity-summary-digest. Never
// blocks or fails the action itself.
// deno-lint-ignore no-explicit-any
type SB = any;

export async function logActivity(
  supabase: SB,
  bot: "india" | "au",
  chatId: number | string,
  action: string,
  detail?: string,
  amount?: number,
) {
  try {
    const table = bot === "au" ? "telegram_allowed_users_au" : "telegram_allowed_users";
    const { data: row } = await supabase
      .from(table)
      .select("label")
      .eq("chat_id", String(chatId))
      .maybeSingle();
    await supabase.from("bot_activity_log").insert({
      bot,
      chat_id: String(chatId),
      actor: row?.label || null,
      action,
      detail: detail || null,
      amount: amount || null,
    });
  } catch { /* best-effort, never breaks the action itself */ }
}
