// Telegram bot for Shalini — Kiosk mode, Enter Inventory, Godown check.
// See TELEGRAM_BOT_BUILD_PLAN.md for the original state machine spec
// (Enter Inventory has since been redesigned: staged via
// submit_purchase_intake_batch, reviewed/approved on the web dashboard —
// see the Approvals tab in admin.html and the memory note on this project).
//
// Required secrets: TELEGRAM_BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET
// Supabase auto-provides SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { askGemini } from "../_shared/askGemini.ts";
import { LOOKUP_CATALOG_REGIONAL, runLookup } from "../_shared/knowledgeBase.ts";
import { handleRequestAction } from "../_shared/requestActions.ts";

const BOT_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN")!;
const TG_API = `https://api.telegram.org/bot${BOT_TOKEN}`;

// deno-lint-ignore no-explicit-any
type SB = any;
// deno-lint-ignore no-explicit-any
type SessionData = Record<string, any>;

// Attached to every checkout-sequence prompt from "customer name" through
// "amount received" — lets Shalini go back to add more items without
// losing the cart or having to cancel and restart.
const BACK_ROW = [{ text: "◀ Add more items", callback_data: "kiosk:backtoitems" }];
// Attached everywhere in Kiosk mode — bails out of the whole sale from any
// point, no confirmation needed for this one since nothing's been saved to
// the database yet at any step before the final "Confirm" tap.
const CANCEL_ROW = [{ text: "✕ Cancel sale", callback_data: "kiosk:cancelall" }];
// Godown check has nothing pending to lose (every reconciliation step is
// read-only until a discrepancy note is actually submitted), so "cancel"
// here just means "exit back to the top menu."
const GODOWN_EXIT_ROW = [{ text: "✕ Exit", callback_data: "godown:exit" }];
// Enter Inventory is staged-then-approved — nothing here writes real
// inventory, so "exit" never needs a confirmation, same reasoning as Godown.
const INV_EXIT_ROW = [{ text: "✕ Exit", callback_data: "inv:exit" }];

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  const secret = req.headers.get("X-Telegram-Bot-Api-Secret-Token");
  if (secret !== Deno.env.get("TELEGRAM_WEBHOOK_SECRET")) {
    return new Response("Forbidden", { status: 403 });
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  const update = await req.json();
  const msg = update.message ?? update.callback_query?.message;
  const chatId = msg?.chat?.id;
  if (!chatId) {
    return new Response("ok", { status: 200 });
  }

  // service_role bypasses RLS, so this direct table read is fine here even
  // though telegram_allowed_users has no anon/authenticated policies —
  // admin.html (anon key) manages this table only through RPCs instead.
  const { data: allowedRows } = await supabase
    .from("telegram_allowed_users")
    .select("chat_id")
    .eq("active", true);
  const allowlist = (allowedRows ?? []).map((r: { chat_id: string }) => r.chat_id);

  if (!allowlist.length) {
    await tgSend(chatId, `Not authorized yet. Ask Rachnakar to approve chat_id: ${chatId}`);
    return new Response("ok", { status: 200 });
  }
  if (!allowlist.includes(String(chatId))) {
    return new Response("ok", { status: 200 });
  }

  const { data: session } = await supabase
    .from("telegram_sessions")
    .select("*")
    .eq("chat_id", chatId)
    .single();
  const state: string = session?.state ?? "idle";
  const data: SessionData = session?.data ?? {};

  const text: string | undefined = update.message?.text;
  const callbackData: string | undefined = update.callback_query?.data;
  const photo: { file_id: string }[] | undefined = update.message?.photo;

  if (text === "/start") {
    await showTopMenu(chatId);
    await saveSession(supabase, chatId, "idle", {});
  } else if (callbackData?.startsWith("kiosk:")) {
    await handleKiosk(supabase, chatId, state, data, callbackData);
  } else if (callbackData === "stock:check") {
    await handleStockCheck(supabase, chatId);
  } else if (callbackData?.startsWith("inv:")) {
    await handleInventory(supabase, chatId, state, data, callbackData);
  } else if (callbackData?.startsWith("godown:")) {
    await handleGodown(supabase, chatId, state, data, callbackData);
  } else if (callbackData?.startsWith("hist:")) {
    await handleSalesHistory(supabase, chatId, data, callbackData);
  } else if (callbackData?.startsWith("evphoto:")) {
    await handleEventPhotoToggle(supabase, chatId, callbackData);
  } else if (callbackData?.startsWith("maint:")) {
    await handleMaintenance(supabase, chatId, callbackData, data);
  } else if (callbackData?.startsWith("iglink:")) {
    await handleIglink(supabase, chatId, data, callbackData);
  } else if (callbackData?.startsWith("voucher:type:")) {
    await handleVoucherType(supabase, chatId, data, callbackData);
  } else if (callbackData?.startsWith("eventform:type:")) {
    await handleEventformType(supabase, chatId, data, callbackData);
  } else if (callbackData?.startsWith("req:")) {
    const actorFrom = update.callback_query?.from;
    const actor = [actorFrom?.first_name, actorFrom?.last_name].filter(Boolean).join(" ") || actorFrom?.username || `Chat ${chatId}`;
    await handleRequestAction(supabase, chatId, callbackData, actor, tgSend);
  } else if (photo?.length && state === "godown_discrepancy_note") {
    await handleGodownPhoto(supabase, chatId, data, photo);
  } else if (photo?.length && state === "inv_item_photos") {
    await handleInventoryPhoto(supabase, chatId, data, photo);
  } else if (text && state.startsWith("godown_")) {
    await handleGodownText(supabase, chatId, state, data, text);
  } else if (text && state.startsWith("inv_")) {
    await handleInventoryText(supabase, chatId, state, data, text);
  } else if (text && state === "maint_note_text") {
    await handleMaintenanceText(supabase, chatId, text);
  } else if (text && state === "iglink_caption_text") {
    await handleIglinkCaptionText(supabase, chatId, data, text);
  } else if (text && state.startsWith("voucher_")) {
    await handleVoucherText(supabase, chatId, state, data, text);
  } else if (text && state.startsWith("eventform_")) {
    await handleEventformText(supabase, chatId, state, data, text);
  } else if (text) {
    await handleTextInput(supabase, chatId, state, data, text);
  }

  if (update.callback_query) {
    await fetch(`${TG_API}/answerCallbackQuery`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ callback_query_id: update.callback_query.id }),
    });
  }

  return new Response("ok", { status: 200 });
});

// ═══════════════════════════════════════════════
// TELEGRAM HELPERS
// ═══════════════════════════════════════════════
async function tgSend(chatId: number, text: string, replyMarkup?: unknown, parseMode?: string) {
  await fetch(`${TG_API}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, reply_markup: replyMarkup, parse_mode: parseMode }),
  });
}

// Best-effort copy of a sale confirmation to MeenshaMonitor (@meenshabot),
// a separate read-only bot for owner-side visibility. Silently no-ops if
// the monitor chat hasn't been set up yet (settings.telegram_monitor_chat_id
// empty) or TELEGRAM_MONITOR_BOT_TOKEN isn't set — this must never block or
// fail a real sale.
async function notifyMonitor(supabase: SB, text: string) {
  try {
    const monitorToken = Deno.env.get("TELEGRAM_MONITOR_BOT_TOKEN");
    if (!monitorToken) return;
    const { data: row } = await supabase.from("settings").select("value").eq("key", "telegram_monitor_chat_id").single();
    const chatId = row?.value;
    if (!chatId) return;
    await fetch(`https://api.telegram.org/bot${monitorToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text }),
    });
  } catch { /* monitor notification is best-effort, never breaks a sale */ }
}

async function saveSession(supabase: SB, chatId: number, state: string, data: SessionData) {
  await supabase.from("telegram_sessions").upsert({
    chat_id: chatId,
    state,
    data,
    updated_at: new Date().toISOString(),
  });
}

async function showTopMenu(chatId: number) {
  await tgSend(chatId, "What would you like to do?", {
    inline_keyboard: [
      [{ text: "🛍️ Kiosk mode", callback_data: "kiosk:start" }],
      [{ text: "➕ Enter inventory", callback_data: "inv:start" }],
      [{ text: "🔧 Maintenance", callback_data: "maint:menu" }],
    ],
  });
}

// Everything that isn't Kiosk or Enter Inventory lives here — Check stock,
// Godown check, Sales history, Event photo submissions, and the free-form
// Note (the only one built new for this menu; the rest just moved here from
// the old flat top-level list).
async function showMaintenanceMenu(chatId: number) {
  await tgSend(chatId, "Maintenance:", {
    inline_keyboard: [
      [{ text: "📋 Check stock", callback_data: "stock:check" }],
      [{ text: "📦 Godown check", callback_data: "godown:start" }],
      [{ text: "🧾 Sales history", callback_data: "hist:start" }],
      [{ text: "📸 Event photo submissions", callback_data: "evphoto:menu" }],
      [{ text: "📝 Add a note", callback_data: "maint:note" }],
      [{ text: "🔗 Insta link", callback_data: "maint:iglink" }],
      [{ text: "🎟️ Create voucher", callback_data: "maint:voucher" }],
      [{ text: "📋 Create event form", callback_data: "maint:eventform" }],
      [{ text: "◀ Back to menu", callback_data: "maint:back" }],
    ],
  });
}

async function handleMaintenance(supabase: SB, chatId: number, callbackData: string, data: SessionData) {
  if (callbackData === "maint:menu") {
    await showMaintenanceMenu(chatId);
    return;
  }
  if (callbackData === "maint:back") {
    await showTopMenu(chatId);
    await saveSession(supabase, chatId, "idle", {});
    return;
  }
  if (callbackData === "maint:note") {
    await tgSend(chatId, "Type your note:");
    await saveSession(supabase, chatId, "maint_note_text", data);
    return;
  }
  if (callbackData === "maint:iglink") {
    await showIglinkItemPicker(supabase, chatId, {});
    await saveSession(supabase, chatId, "iglink_pick_item", {});
    return;
  }
  if (callbackData === "maint:voucher") {
    await tgSend(chatId, "Voucher code? (e.g. DIWALI200)");
    await saveSession(supabase, chatId, "voucher_code", {});
    return;
  }
  if (callbackData === "maint:eventform") {
    await tgSend(chatId, "Event title? (e.g. AFWWA Exhibition)");
    await saveSession(supabase, chatId, "eventform_title", {});
    return;
  }
}

async function handleMaintenanceText(supabase: SB, chatId: number, text: string) {
  const note = text.trim();
  if (!note) {
    await tgSend(chatId, "Note can't be empty — type your note:");
    return;
  }
  await supabase.from("bot_notes").insert({ text: note, submitted_by: `chat_id:${chatId}` });
  await tgSend(chatId, "📝 Note saved — it'll show on the dashboard.");
  await showMaintenanceMenu(chatId);
  await saveSession(supabase, chatId, "idle", {});
}

// ═══════════════════════════════════════════════
// MAINTENANCE → INSTA LINK
// ═══════════════════════════════════════════════
// Pick one SKU, type the caption text for the post, get back a storefront
// link (meensha.in/index.html?buy=<sku_id>) that auto-adds that item to
// the shopper's cart and opens the cart drawer the moment they tap it — so
// they land straight in the normal buy/checkout flow. No payment link is
// created ahead of time (there's no known buyer yet); this is purely a
// deep link, same as sharing any other page URL. Paste the caption text +
// link straight into Instagram.
const STOREFRONT_URL = "https://meensha.in";
const IGLINK_BACK_ROW = [{ text: "◀ Back to maintenance", callback_data: "iglink:cancel" }];

async function showIglinkItemPicker(supabase: SB, chatId: number, data: SessionData) {
  const query = supabase
    .from("inventory_skus")
    .select("id, name, mrp, sale_price, display_variant, display_material, au_available");
  const searchQ: string | undefined = data.search_query;
  const { data: skus } = searchQ
    ? await query.or(
      `name.ilike.%${searchQ}%,display_material.ilike.%${searchQ}%,display_variant.ilike.%${searchQ}%`,
    )
    : await query;
  const { data: units } = await supabase
    .from("inventory_units")
    .select("id, sku_id")
    .eq("status", "available");

  const availCount: Record<string, number> = {};
  (units ?? []).forEach((u: { sku_id: string }) => {
    availCount[u.sku_id] = (availCount[u.sku_id] ?? 0) + 1;
  });
  const inStock = (skus ?? []).filter((s: { id: string }) => (availCount[s.id] ?? 0) > 0);

  const pageSize = 8;
  const page = data.page ?? 0;
  const pageItems = inStock.slice(page * pageSize, (page + 1) * pageSize);

  const buttons = pageItems.map(
    (s: { id: string; name: string; mrp: number; sale_price: number; au_available: boolean }) => {
      const auTag = s.au_available ? "🇦🇺 " : "";
      const mrpTxt = s.mrp && s.mrp !== s.sale_price ? `MRP ₹${s.mrp} → ` : "";
      return [{
        text: `${auTag}${s.name} (${availCount[s.id]} left) — ${mrpTxt}₹${s.sale_price}`,
        callback_data: `iglink:item:${s.id}`,
      }];
    },
  );
  const navRow = [];
  if (page > 0) navRow.push({ text: "◀ Prev", callback_data: `iglink:page:${page - 1}` });
  if ((page + 1) * pageSize < inStock.length) {
    navRow.push({ text: "Next ▶", callback_data: `iglink:page:${page + 1}` });
  }
  if (navRow.length) buttons.push(navRow);
  if (searchQ) buttons.push([{ text: "✖ Clear search", callback_data: "iglink:clearsearch" }]);
  buttons.push(IGLINK_BACK_ROW);

  const header = searchQ
    ? (inStock.length ? `Results for "${searchQ}":` : `No items matched "${searchQ}".`)
    : (inStock.length ? "Pick an item for the Insta link, or type a name to search:" : "Nothing in stock right now.");

  await tgSend(chatId, header, { inline_keyboard: buttons });
}

async function askIglinkCaption(supabase: SB, chatId: number, data: SessionData) {
  await tgSend(
    chatId,
    `"${data.pendingSku.name}" — ₹${data.pendingSku.price}\n\n` +
      `Type the caption text for this Insta post — I'll pair it with the shop link:`,
  );
  await saveSession(supabase, chatId, "iglink_caption_text", data);
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

async function handleIglinkCaptionText(supabase: SB, chatId: number, data: SessionData, text: string) {
  const caption = text.trim();
  if (!caption) {
    await tgSend(chatId, "Caption can't be empty — type the text you want:");
    return;
  }
  const link = `${STOREFRONT_URL}/index.html?buy=${data.pendingSku.id}`;
  await tgSend(
    chatId,
    `🔗 <a href="${link}">${escapeHtml(caption)}</a>\n\n` +
      `Tapping it adds "${escapeHtml(data.pendingSku.name)}" to the shopper's cart and opens checkout right away.\n\n` +
      `Instagram captions/bio can't hold a real clickable link — paste that raw URL below into a Story "Link" sticker ` +
      `(you can rename the sticker's own display text there) or your bio-link field:\n${link}`,
    undefined,
    "HTML",
  );
  await showMaintenanceMenu(chatId);
  await saveSession(supabase, chatId, "idle", {});
}

async function handleIglink(supabase: SB, chatId: number, data: SessionData, callbackData: string) {
  if (callbackData === "iglink:cancel") {
    await showMaintenanceMenu(chatId);
    await saveSession(supabase, chatId, "idle", {});
    return;
  }
  if (callbackData.startsWith("iglink:page:")) {
    data.page = parseInt(callbackData.split(":")[2], 10) || 0;
    await showIglinkItemPicker(supabase, chatId, data);
    await saveSession(supabase, chatId, "iglink_pick_item", data);
    return;
  }
  if (callbackData === "iglink:clearsearch") {
    delete data.search_query;
    data.page = 0;
    await showIglinkItemPicker(supabase, chatId, data);
    await saveSession(supabase, chatId, "iglink_pick_item", data);
    return;
  }
  if (callbackData.startsWith("iglink:item:")) {
    const skuId = callbackData.split(":")[2];
    const { data: sku } = await supabase
      .from("inventory_skus")
      .select("id, name, sale_price")
      .eq("id", skuId)
      .single();
    if (!sku) {
      await showIglinkItemPicker(supabase, chatId, data);
      await saveSession(supabase, chatId, "iglink_pick_item", data);
      return;
    }
    data.pendingSku = { id: sku.id, name: sku.name, price: sku.sale_price };
    await askIglinkCaption(supabase, chatId, data);
    return;
  }
}

// ═══════════════════════════════════════════════
// MAINTENANCE → CREATE VOUCHER
// ═══════════════════════════════════════════════
// Direct equivalent of admin.html's Coupons tab "New Coupon" form, reusing
// the same admin_create_coupon RPC — region is always "india" since this
// is the India-side bot. Leave name/WA blank ("skip") for a public code
// anyone can use; fill them in to lock the voucher to one customer.
function daysFromNow(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}

async function handleVoucherType(supabase: SB, chatId: number, data: SessionData, callbackData: string) {
  data.v_type = callbackData.split(":")[2]; // "percent" | "flat"
  await tgSend(chatId, data.v_type === "percent" ? "Discount %? (e.g. 10)" : "Discount amount in ₹? (e.g. 200)");
  await saveSession(supabase, chatId, "voucher_value", data);
}

async function handleVoucherText(supabase: SB, chatId: number, state: string, data: SessionData, text: string) {
  const t = text.trim();
  if (state === "voucher_code") {
    if (!t) {
      await tgSend(chatId, "Code can't be empty — type a voucher code:");
      return;
    }
    data.v_code = t.toUpperCase();
    await tgSend(chatId, "Discount type?", {
      inline_keyboard: [
        [{ text: "% Percent off", callback_data: "voucher:type:percent" }],
        [{ text: "₹ Flat amount off", callback_data: "voucher:type:flat" }],
      ],
    });
    await saveSession(supabase, chatId, "voucher_pick_type", data);
    return;
  }
  if (state === "voucher_value") {
    const val = parseFloat(t);
    if (!val || val <= 0 || (data.v_type === "percent" && val > 100)) {
      await tgSend(chatId, "Enter a valid discount value:");
      return;
    }
    data.v_value = val;
    await tgSend(chatId, "For one specific customer? Type their name, or 'skip' for a public code anyone can use.");
    await saveSession(supabase, chatId, "voucher_name", data);
    return;
  }
  if (state === "voucher_name") {
    if (t.toLowerCase() === "skip") {
      data.v_name = null;
      data.v_wa = null;
      await tgSend(chatId, "Valid for how many days? (leave blank for 7)");
      await saveSession(supabase, chatId, "voucher_days", data);
      return;
    }
    data.v_name = t;
    await tgSend(chatId, "Their WhatsApp number?");
    await saveSession(supabase, chatId, "voucher_wa", data);
    return;
  }
  if (state === "voucher_wa") {
    data.v_wa = t;
    await tgSend(chatId, "Valid for how many days? (leave blank for 7)");
    await saveSession(supabase, chatId, "voucher_days", data);
    return;
  }
  if (state === "voucher_days") {
    const days = t ? parseInt(t, 10) || 7 : 7;
    const { data: coupon, error } = await supabase.rpc("admin_create_coupon", {
      p_code: data.v_code,
      p_customer_name: data.v_name,
      p_customer_wa: data.v_wa,
      p_discount_type: data.v_type,
      p_discount_value: data.v_value,
      p_region: "india",
      p_valid_from: daysFromNow(0),
      p_valid_until: daysFromNow(days),
    });
    if (error || !coupon) {
      await tgSend(chatId, `Couldn't create the voucher — code "${data.v_code}" may already exist.`);
      await showMaintenanceMenu(chatId);
      await saveSession(supabase, chatId, "idle", {});
      return;
    }
    const discTxt = data.v_type === "percent" ? `${data.v_value}% off` : `₹${data.v_value} off`;
    const who = data.v_name ? `locked to ${data.v_name}` : "public — anyone can use it";
    await tgSend(chatId, `🎟️ Voucher created: ${data.v_code}\n${discTxt}, ${who}, valid ${days} day(s).`);
    await showMaintenanceMenu(chatId);
    await saveSession(supabase, chatId, "idle", {});
    return;
  }
}

// ═══════════════════════════════════════════════
// MAINTENANCE → CREATE EVENT FORM
// ═══════════════════════════════════════════════
// Creates a voucher_events row and hands back a shareable registration
// link (register.html?event=<id>) — anyone who fills in their name+WA on
// that link gets their own unique one-time voucher with this event's
// discount, region always "india" for this bot. See setup/add_voucher_events.sql.
async function handleEventformType(supabase: SB, chatId: number, data: SessionData, callbackData: string) {
  data.ef_type = callbackData.split(":")[2];
  await tgSend(chatId, data.ef_type === "percent" ? "Discount %? (e.g. 10)" : "Discount amount in ₹? (e.g. 200)");
  await saveSession(supabase, chatId, "eventform_value", data);
}

async function handleEventformText(supabase: SB, chatId: number, state: string, data: SessionData, text: string) {
  const t = text.trim();
  if (state === "eventform_title") {
    if (!t) {
      await tgSend(chatId, "Title can't be empty — type the event title:");
      return;
    }
    data.ef_title = t;
    await tgSend(chatId, "Discount type?", {
      inline_keyboard: [
        [{ text: "% Percent off", callback_data: "eventform:type:percent" }],
        [{ text: "₹ Flat amount off", callback_data: "eventform:type:flat" }],
      ],
    });
    await saveSession(supabase, chatId, "eventform_pick_type", data);
    return;
  }
  if (state === "eventform_value") {
    const val = parseFloat(t);
    if (!val || val <= 0 || (data.ef_type === "percent" && val > 100)) {
      await tgSend(chatId, "Enter a valid discount value:");
      return;
    }
    data.ef_value = val;
    await tgSend(chatId, "Voucher valid for how many days after each visitor registers? (leave blank for 7)");
    await saveSession(supabase, chatId, "eventform_days", data);
    return;
  }
  if (state === "eventform_days") {
    const days = t ? parseInt(t, 10) || 7 : 7;
    const { data: ev, error } = await supabase.rpc("admin_create_voucher_event", {
      p_title: data.ef_title,
      p_region: "india",
      p_discount_type: data.ef_type,
      p_discount_value: data.ef_value,
      p_valid_days: days,
      p_created_by: `telegram:${chatId}`,
    });
    if (error || !ev?.id) {
      await tgSend(chatId, "Couldn't create the event form — try again.");
      await showMaintenanceMenu(chatId);
      await saveSession(supabase, chatId, "idle", {});
      return;
    }
    const link = `${STOREFRONT_URL}/register.html?event=${ev.id}`;
    await tgSend(
      chatId,
      `📋 <a href="${link}">${escapeHtml(data.ef_title)}</a>\n\n` +
        `Share this link — each visitor who fills in their name + WhatsApp gets their own unique voucher ` +
        `(${data.ef_type === "percent" ? data.ef_value + "% off" : "₹" + data.ef_value + " off"}, valid ${days} day(s)).\n\n${link}`,
      undefined,
      "HTML",
    );
    await showMaintenanceMenu(chatId);
    await saveSession(supabase, chatId, "idle", {});
    return;
  }
}

// Manual on/off switch for public event-photo submission (event-photos.html
// on the storefront). Explicit here always wins over the event's own
// date_from/date_to window (see add_event_photo RPC) — lets staff shut it
// off early or open it outside the scheduled dates without editing the
// event itself.
async function handleEventPhotoToggle(supabase: SB, chatId: number, callbackData: string) {
  if (callbackData === "evphoto:menu") {
    const { data: row } = await supabase.from("settings").select("value").eq("key", "event_photo_submission_enabled").maybeSingle();
    const current = row?.value === "true" ? "ON" : row?.value === "false" ? "OFF" : "OFF (following event dates)";
    await tgSend(chatId, `📸 Public event-photo submission is currently: ${current}`, {
      inline_keyboard: [
        [{ text: "🟢 Turn ON", callback_data: "evphoto:on" }],
        [{ text: "🔴 Turn OFF", callback_data: "evphoto:off" }],
        [{ text: "◀ Back to menu", callback_data: "evphoto:exit" }],
      ],
    });
    return;
  }
  if (callbackData === "evphoto:on" || callbackData === "evphoto:off") {
    const value = callbackData === "evphoto:on" ? "true" : "false";
    // settings' primary key is `id`, not `key` — upsert needs an explicit
    // conflict target or it'll insert a duplicate row instead of updating.
    await supabase.from("settings").upsert({ key: "event_photo_submission_enabled", value }, { onConflict: "key" });
    await tgSend(chatId, `📸 Public event-photo submission is now ${value === "true" ? "🟢 ON" : "🔴 OFF"}.`);
    await showTopMenu(chatId);
    return;
  }
  if (callbackData === "evphoto:exit") {
    await showTopMenu(chatId);
  }
}

// Plain read-only stock list — no match/discrepancy questions, nothing
// written to the DB. Just "what do I have left to sell right now," for
// checking during Kiosk time without leaving the bot.
async function handleStockCheck(supabase: SB, chatId: number) {
  const { data: skus } = await supabase
    .from("inventory_skus")
    .select("id, name, sale_price, au_available")
    .order("name");
  const { data: units } = await supabase.from("inventory_units").select("sku_id").eq("status", "available");
  const availCount: Record<string, number> = {};
  (units ?? []).forEach((u: { sku_id: string }) => {
    availCount[u.sku_id] = (availCount[u.sku_id] ?? 0) + 1;
  });

  const inStock = (skus ?? []).filter((s: { id: string }) => (availCount[s.id] ?? 0) > 0);
  if (!inStock.length) {
    await tgSend(chatId, "Nothing in stock right now.");
    await showTopMenu(chatId);
    return;
  }

  const lines = inStock.map((s: { id: string; name: string; sale_price: number; au_available: boolean }) =>
    `${s.au_available ? "🇦🇺 " : ""}${s.name} — ${availCount[s.id]} left — ₹${s.sale_price}`
  );
  await tgSend(chatId, `📋 Current stock (${inStock.length} items):\n\n${lines.join("\n")}`);
  await showTopMenu(chatId);
}

// ═══════════════════════════════════════════════
// KIOSK MODE (record a sale) — mirrors admin.html's saveSale()
// Flow: item → quantity → stock check → pick that many physical pieces →
// Cart (Add/Delete/Checkout) → WhatsApp number → name → summary → coupon →
// confirm → payment mode → (Razorpay: real payment link, waits on the
// webhook; Cash/UPI: amount received → finalize) → invoice.
// ═══════════════════════════════════════════════
async function handleKiosk(
  supabase: SB,
  chatId: number,
  state: string,
  data: SessionData,
  callbackData: string,
) {
  if (callbackData === "kiosk:start") {
    data = { cart: [], page: 0 };
    await showItemPicker(supabase, chatId, data);
    await saveSession(supabase, chatId, "kiosk_pick_item", data);
    return;
  }

  // Available from any point in checkout up through the amount step —
  // keeps the cart and anything already entered, just goes back to add
  // more items. Re-reaching checkout afterward simply re-asks customer
  // info/discount/payment fresh (cheap to re-enter, far simpler and safer
  // than trying to selectively skip already-filled fields).
  if (callbackData === "kiosk:backtoitems") {
    data.page = 0;
    await showItemPicker(supabase, chatId, data);
    await saveSession(supabase, chatId, "kiosk_pick_item", data);
    return;
  }

  if (callbackData === "kiosk:cancelall") {
    await tgSend(chatId, "Sale cancelled — nothing was saved.");
    await showTopMenu(chatId);
    await saveSession(supabase, chatId, "idle", {});
    return;
  }

  if (state === "kiosk_pick_item") {
    if (callbackData.startsWith("kiosk:page:")) {
      data.page = parseInt(callbackData.split(":")[2]);
      await showItemPicker(supabase, chatId, data);
      await saveSession(supabase, chatId, "kiosk_pick_item", data);
      return;
    }
    if (callbackData.startsWith("kiosk:item:")) {
      const skuId = callbackData.split(":")[2];
      const { data: sku } = await supabase.from("inventory_skus").select("id, name").eq("id", skuId).single();
      if (!sku) {
        await tgSend(chatId, "That item is no longer available — pick another.");
        await showItemPicker(supabase, chatId, data);
        await saveSession(supabase, chatId, "kiosk_pick_item", data);
        return;
      }
      data.pendingSkuId = skuId;
      data.pendingSkuName = sku.name;
      await tgSend(chatId, `Quantity of "${sku.name}"?`, { inline_keyboard: [BACK_ROW, CANCEL_ROW] });
      await saveSession(supabase, chatId, "kiosk_pick_qty", data);
      return;
    }
    if (callbackData === "kiosk:clearsearch") {
      delete data.search_query;
      data.page = 0;
      await showItemPicker(supabase, chatId, data);
      await saveSession(supabase, chatId, "kiosk_pick_item", data);
      return;
    }
  }

  if (state === "kiosk_pick_unit" && callbackData.startsWith("kiosk:unit:")) {
    const unitId = callbackData.split(":")[2];
    const { data: unit } = await supabase
      .from("inventory_units")
      .select("unit_code, sku_id, inventory_skus(name, sale_price, display_variant)")
      .eq("id", unitId)
      .single();
    if (!unit) {
      await tgSend(chatId, "That piece is no longer available — pick another.");
      await showUnitPicker(supabase, chatId, data.pendingSkuId, data, data.qtyRemaining);
      return;
    }
    const sku = unit.inventory_skus;
    data.cart.push({
      unit_id: unitId,
      unit_code: unit.unit_code,
      sku_id: unit.sku_id,
      name: sku.name,
      variant: sku.display_variant,
      price: sku.sale_price,
    });
    data.qtyRemaining = (data.qtyRemaining ?? 1) - 1;
    if (data.qtyRemaining > 0) {
      await showUnitPicker(supabase, chatId, data.pendingSkuId, data, data.qtyRemaining);
      await saveSession(supabase, chatId, "kiosk_pick_unit", data);
      return;
    }
    data.pendingSkuId = undefined;
    data.pendingSkuName = undefined;
    data.qtyRemaining = undefined;
    await showCart(chatId, data);
    await saveSession(supabase, chatId, "kiosk_cart", data);
    return;
  }

  if (state === "kiosk_cart") {
    if (callbackData === "kiosk:more") {
      data.page = 0;
      await showItemPicker(supabase, chatId, data);
      await saveSession(supabase, chatId, "kiosk_pick_item", data);
      return;
    }
    if (callbackData.startsWith("kiosk:cartitem:")) {
      const skuId = callbackData.split(":")[2];
      await showCartItemMenu(supabase, chatId, data, skuId);
      return;
    }
    if (callbackData === "kiosk:checkout") {
      if (!data.cart.length) {
        await tgSend(chatId, "Cart is empty — add an item first.");
        await showCart(chatId, data);
        return;
      }
      await tgSend(chatId, "Customer's WhatsApp number?", { inline_keyboard: [BACK_ROW, CANCEL_ROW] });
      await saveSession(supabase, chatId, "kiosk_customer_wa", data);
      return;
    }
  }

  // Per-item submenu reached by tapping an item on the Cart screen —
  // change quantity, delete it entirely, or back out with no change.
  if (state === "kiosk_cart_item") {
    const skuId = data.editingSkuId;
    if (callbackData === "kiosk:cartitem:back") {
      await showCart(chatId, data);
      await saveSession(supabase, chatId, "kiosk_cart", data);
      return;
    }
    if (callbackData === "kiosk:cartitem:delete") {
      data.cart = data.cart.filter((c: { sku_id: string }) => c.sku_id !== skuId);
      data.editingSkuId = undefined;
      await showCart(chatId, data);
      await saveSession(supabase, chatId, "kiosk_cart", data);
      return;
    }
    if (callbackData === "kiosk:cartitem:editqty") {
      const { data: sku } = await supabase.from("inventory_skus").select("id, name").eq("id", skuId).single();
      // Drops this item's current pieces back out of the cart first — the
      // stock-availability check in the quantity step counts anything
      // still in data.cart as unavailable, so this SKU has to be cleared
      // before re-asking "how many," or it'd undercount by what's already
      // held. Nothing is written to the database either way; the cart only
      // exists in the session until checkout.
      data.cart = data.cart.filter((c: { sku_id: string }) => c.sku_id !== skuId);
      data.editingSkuId = undefined;
      if (!sku) {
        await tgSend(chatId, "That item is no longer available.");
        await showCart(chatId, data);
        await saveSession(supabase, chatId, "kiosk_cart", data);
        return;
      }
      data.pendingSkuId = skuId;
      data.pendingSkuName = sku.name;
      await tgSend(chatId, `New quantity of "${sku.name}"?`, { inline_keyboard: [BACK_ROW, CANCEL_ROW] });
      await saveSession(supabase, chatId, "kiosk_pick_qty", data);
      return;
    }
  }

  if (state === "kiosk_discount_pick") {
    if (callbackData === "kiosk:discount:none") {
      data.discount = 0;
      await showConfirmation(supabase, chatId, data);
      return;
    }
    if (callbackData === "kiosk:discount:custom") {
      const subtotal = data.cart.reduce((a: number, c: { price: number }) => a + c.price, 0);
      await tgSend(chatId, `Reply with a ₹ discount amount, or 0 if none. (Subtotal: ₹${subtotal})`, { inline_keyboard: [BACK_ROW, CANCEL_ROW] });
      await saveSession(supabase, chatId, "kiosk_discount_custom", data);
      return;
    }
    if (callbackData === "kiosk:discount:entercode") {
      await tgSend(chatId, "Type the customer's code (e.g. MSH-A3F92):", { inline_keyboard: [BACK_ROW, CANCEL_ROW] });
      await saveSession(supabase, chatId, "kiosk_discount_code_entry", data);
      return;
    }
    if (callbackData.startsWith("kiosk:coupon:")) {
      const couponId = callbackData.split(":")[2];
      const { data: coupon } = await supabase
        .from("coupons")
        .select("*")
        .eq("id", couponId)
        .single();
      if (!validateCoupon(coupon)) {
        await tgSend(chatId, "That coupon isn't available anymore — pick another option.");
        await showDiscountPicker(supabase, chatId, data);
        return;
      }
      await pickDiscountItem(supabase, chatId, data, coupon);
      return;
    }
  }

  if (state === "kiosk_confirm") {
    if (callbackData === "kiosk:confirm") {
      await askPaymentMode(supabase, chatId, data);
      return;
    }
    if (callbackData === "kiosk:cancel") {
      await tgSend(chatId, "Sale cancelled.");
      data = { cart: [], page: 0 };
      await showItemPicker(supabase, chatId, data);
      await saveSession(supabase, chatId, "kiosk_pick_item", data);
      return;
    }
  }

  if (state === "kiosk_payment_mode" && callbackData.startsWith("kiosk:pay:")) {
    const modeMap: Record<string, string> = { cash: "Cash", upi: "UPI Direct", razorpay: "Razorpay" };
    data.pay_mode = modeMap[callbackData.split(":")[2]];

    if (data.pay_mode === "Razorpay") {
      await sendRazorpayLink(supabase, chatId, data);
      return;
    }

    const total = orderTotal(data);
    await tgSend(chatId, `Amount received — ₹${total}?`, {
      inline_keyboard: [
        [{ text: `✅ Yes, ₹${total} in full`, callback_data: "kiosk:amount:full" }],
        BACK_ROW,
        CANCEL_ROW,
      ],
    });
    await tgSend(chatId, "Or reply with the actual amount if different.");
    await saveSession(supabase, chatId, "kiosk_amount", data);
    return;
  }

  if (state === "kiosk_amount" && callbackData === "kiosk:amount:full") {
    data.amount = orderTotal(data);
    await finalizeSale(supabase, chatId, data);
    // Kiosk mode is persistent — loop back to picking the next item instead
    // of dropping to idle, so staff can ring up sale after sale without
    // re-tapping "Kiosk mode" each time. "✕ Cancel sale" (present on every
    // kiosk screen) is the way out to the top menu.
    data = { cart: [], page: 0 };
    await showItemPicker(supabase, chatId, data);
    await saveSession(supabase, chatId, "kiosk_pick_item", data);
    return;
  }
}

async function showItemPicker(supabase: SB, chatId: number, data: SessionData) {
  const query = supabase
    .from("inventory_skus")
    .select("id, name, mrp, sale_price, display_variant, display_material, au_available");
  // A search query (typed by staff, see handleTextInput's kiosk_pick_item
  // case) filters by name/material/variant — same fields the storefront and
  // the AU bot's kioskSearch already search across, kept consistent.
  const searchQ: string | undefined = data.search_query;
  const { data: skus } = searchQ
    ? await query.or(
      `name.ilike.%${searchQ}%,display_material.ilike.%${searchQ}%,display_variant.ilike.%${searchQ}%`,
    )
    : await query;
  const { data: units } = await supabase
    .from("inventory_units")
    .select("id, sku_id")
    .eq("status", "available");

  // Units already sitting in the cart aren't actually sold yet (DB status
  // only flips on finalize), but they must not be offered again — otherwise
  // the same physical piece could be picked twice into one sale.
  const inCartUnitIds = new Set((data.cart ?? []).map((c: { unit_id: string }) => c.unit_id));

  const availCount: Record<string, number> = {};
  (units ?? []).forEach((u: { sku_id: string; id: string }) => {
    if (inCartUnitIds.has(u.id)) return;
    availCount[u.sku_id] = (availCount[u.sku_id] ?? 0) + 1;
  });
  const inStock = (skus ?? []).filter((s: { id: string }) => (availCount[s.id] ?? 0) > 0);

  const pageSize = 8;
  const page = data.page ?? 0;
  const pageItems = inStock.slice(page * pageSize, (page + 1) * pageSize);

  const buttons = pageItems.map(
    (s: { id: string; name: string; mrp: number; sale_price: number; au_available: boolean }) => {
      const auTag = s.au_available ? "🇦🇺 " : "";
      const mrpTxt = s.mrp && s.mrp !== s.sale_price ? `MRP ₹${s.mrp} → ` : "";
      return [{
        text: `${auTag}${s.name} (${availCount[s.id]} left) — ${mrpTxt}₹${s.sale_price}`,
        callback_data: `kiosk:item:${s.id}`,
      }];
    },
  );
  const navRow = [];
  if (page > 0) navRow.push({ text: "◀ Prev", callback_data: `kiosk:page:${page - 1}` });
  if ((page + 1) * pageSize < inStock.length) {
    navRow.push({ text: "Next ▶", callback_data: `kiosk:page:${page + 1}` });
  }
  if (navRow.length) buttons.push(navRow);
  if (searchQ) buttons.push([{ text: "✖ Clear search", callback_data: "kiosk:clearsearch" }]);
  buttons.push(CANCEL_ROW);

  let header = searchQ
    ? (inStock.length ? `Results for "${searchQ}":` : `No items matched "${searchQ}".`)
    : (inStock.length ? "Pick an item, or type a name to search:" : "Nothing in stock right now.");
  if (data.cart?.length) {
    const cartLines = data.cart
      .map((c: { name: string; price: number }) => `• ${c.name} — ₹${c.price}`)
      .join("\n");
    header = `In cart so far:\n${cartLines}\n\n${header}`;
  }

  await tgSend(chatId, header, { inline_keyboard: buttons });
}

async function showUnitPicker(supabase: SB, chatId: number, skuId: string, data: SessionData, remaining?: number) {
  const { data: units } = await supabase
    .from("inventory_units")
    .select("id, unit_code")
    .eq("sku_id", skuId)
    .eq("status", "available");
  const inCartUnitIds = new Set((data.cart ?? []).map((c: { unit_id: string }) => c.unit_id));
  const buttons = (units ?? [])
    .filter((u: { id: string }) => !inCartUnitIds.has(u.id))
    .map((u: { id: string; unit_code: string }) => [
      { text: u.unit_code, callback_data: `kiosk:unit:${u.id}` },
    ]);
  buttons.push(BACK_ROW);
  buttons.push(CANCEL_ROW);
  const progress = remaining && remaining > 1 ? ` (${remaining} more to pick)` : "";
  await tgSend(chatId, `Pick the specific piece${progress}:`, { inline_keyboard: buttons });
}

type CartLine = { unit_id: string; unit_code: string; sku_id: string; name: string; price: number };

// Groups the cart's individual physical pieces by SKU for display/editing —
// staff picked specific unit_codes to get here, but thinks of the cart in
// terms of "2 of this item," not by piece. Tapping a group opens
// showCartItemMenu (change qty / delete / no change), not a direct delete.
function groupCartBySku(cart: CartLine[]): { sku_id: string; name: string; qty: number; subtotal: number }[] {
  const groups = new Map<string, { sku_id: string; name: string; qty: number; subtotal: number }>();
  for (const c of cart) {
    const g = groups.get(c.sku_id) ?? { sku_id: c.sku_id, name: c.name, qty: 0, subtotal: 0 };
    g.qty += 1;
    g.subtotal += c.price;
    groups.set(c.sku_id, g);
  }
  return [...groups.values()];
}

// Explicit Cart screen between picking pieces and checkout — tap an item to
// edit/delete it, Add item, Checkout, or Cancel sale entirely.
async function showCart(chatId: number, data: SessionData) {
  if (!data.cart.length) {
    await tgSend(chatId, "Cart is empty.", {
      inline_keyboard: [[{ text: "➕ Add item", callback_data: "kiosk:more" }], CANCEL_ROW],
    });
    return;
  }
  const groups = groupCartBySku(data.cart);
  const cartTotal = groups.reduce((a, g) => a + g.subtotal, 0);
  const lines = groups.map((g) => `• ${g.name} × ${g.qty} — ₹${g.subtotal}`).join("\n");
  const itemButtons = groups.map((g) => [
    { text: `✏️ ${g.name} (${g.qty})`, callback_data: `kiosk:cartitem:${g.sku_id}` },
  ]);
  await tgSend(chatId, `Cart:\n\n${lines}\n\nSubtotal: ₹${cartTotal}`, {
    inline_keyboard: [
      ...itemButtons,
      [{ text: "➕ Add item", callback_data: "kiosk:more" }],
      [{ text: "✅ Checkout", callback_data: "kiosk:checkout" }],
      CANCEL_ROW,
    ],
  });
}

async function showCartItemMenu(supabase: SB, chatId: number, data: SessionData, skuId: string) {
  const group = groupCartBySku(data.cart).find((g) => g.sku_id === skuId);
  if (!group) {
    await showCart(chatId, data);
    await saveSession(supabase, chatId, "kiosk_cart", data);
    return;
  }
  data.editingSkuId = skuId;
  await tgSend(chatId, `"${group.name}" — ${group.qty} in cart (₹${group.subtotal})`, {
    inline_keyboard: [
      [{ text: "✏️ Change quantity", callback_data: "kiosk:cartitem:editqty" }],
      [{ text: "🗑 Delete this item", callback_data: "kiosk:cartitem:delete" }],
      [{ text: "◀ No change — back to cart", callback_data: "kiosk:cartitem:back" }],
      CANCEL_ROW,
    ],
  });
  await saveSession(supabase, chatId, "kiosk_cart_item", data);
}

async function handleTextInput(
  supabase: SB,
  chatId: number,
  state: string,
  data: SessionData,
  text: string,
) {
  if (state === "kiosk_pick_item") {
    data.search_query = text.trim();
    data.page = 0;
    await showItemPicker(supabase, chatId, data);
    await saveSession(supabase, chatId, "kiosk_pick_item", data);
    return;
  }

  if (state === "iglink_pick_item") {
    data.search_query = text.trim();
    data.page = 0;
    await showIglinkItemPicker(supabase, chatId, data);
    await saveSession(supabase, chatId, "iglink_pick_item", data);
    return;
  }

  if (state === "kiosk_pick_qty") {
    const requested = parseInt(text.trim(), 10);
    if (!requested || requested < 1) {
      await tgSend(chatId, "Enter a valid quantity (a number, 1 or more).");
      return;
    }
    const inCartUnitIds = new Set((data.cart ?? []).map((c: { unit_id: string }) => c.unit_id));
    const { data: units } = await supabase
      .from("inventory_units")
      .select("id")
      .eq("sku_id", data.pendingSkuId)
      .eq("status", "available");
    const availableCount = (units ?? []).filter((u: { id: string }) => !inCartUnitIds.has(u.id)).length;
    if (requested > availableCount) {
      await tgSend(chatId, `Only ${availableCount} available — enter a smaller quantity.`);
      return;
    }
    data.qtyRemaining = requested;
    await showUnitPicker(supabase, chatId, data.pendingSkuId, data, requested);
    await saveSession(supabase, chatId, "kiosk_pick_unit", data);
    return;
  }

  // WhatsApp number is captured before name (finalized flow order). Accepts
  // a bare 10-digit number or one already carrying a 91/+91 prefix; auto-
  // prefixes +91 either way and rejects anything that isn't exactly 10
  // digits underneath, so a mistyped number doesn't silently save wrong.
  if (state === "kiosk_customer_wa") {
    const digitsOnly = text.replace(/\D/g, "");
    const tenDigit = digitsOnly.length === 12 && digitsOnly.startsWith("91") ? digitsOnly.slice(2) : digitsOnly;
    if (tenDigit.length !== 10) {
      await tgSend(chatId, "That doesn't look like a valid 10-digit number — try again (e.g. 9876543210).");
      return;
    }
    data.customer_wa = "+91" + tenDigit;
    await tgSend(chatId, "Customer name?", { inline_keyboard: [BACK_ROW, CANCEL_ROW] });
    await saveSession(supabase, chatId, "kiosk_customer_name", data);
    return;
  }

  if (state === "kiosk_customer_name") {
    data.customer_name = text.trim();
    await showOrderSummary(chatId, data);
    await showDiscountPicker(supabase, chatId, data);
    return;
  }

  if (state === "kiosk_discount_custom") {
    const subtotal = data.cart.reduce((a: number, c: { price: number }) => a + c.price, 0);
    const parsed = parseFloat(text);
    data.discount = isNaN(parsed) ? 0 : Math.max(0, Math.min(parsed, subtotal));
    await showConfirmation(supabase, chatId, data);
    return;
  }

  if (state === "kiosk_discount_code_entry") {
    const code = text.trim().toUpperCase();
    const { data: coupon } = await supabase
      .from("coupons")
      .select("*")
      .ilike("code", code)
      .maybeSingle();
    if (!validateCoupon(coupon)) {
      await tgSend(chatId, "Code not found, already used, expired, or not active.");
      await showDiscountPicker(supabase, chatId, data);
      return;
    }
    await pickDiscountItem(supabase, chatId, data, coupon);
    return;
  }

  if (state === "kiosk_amount") {
    const total = orderTotal(data);
    const parsed = parseFloat(text);
    data.amount = isNaN(parsed) ? total : parsed;
    await finalizeSale(supabase, chatId, data);
    data = { cart: [], page: 0 };
    await showItemPicker(supabase, chatId, data);
    await saveSession(supabase, chatId, "kiosk_pick_item", data);
    return;
  }

  // No active flow expecting text input — treat it as a natural-language
  // question (stock/price/sales lookups, India-scoped only) instead of just
  // dumping them back to the menu.
  try {
    const answer = await askGemini(supabase, text, LOOKUP_CATALOG_REGIONAL, (sb, name, params) =>
      runLookup(sb, name, { ...params, region: "india" }));
    await tgSend(chatId, answer);
  } catch {
    await showTopMenu(chatId);
  }
}

// A coupon discount applies to exactly one item in the cart, not the whole
// order — matches how the discount is meant to be understood on the invoice
// (e.g. "5% off one item"), not a blanket order-wide reduction.
// deno-lint-ignore no-explicit-any
function validateCoupon(coupon: any): boolean {
  if (!coupon || !coupon.active || coupon.used) return false;
  if (!["india", "all"].includes(coupon.region)) return false;
  const today = new Date().toISOString().slice(0, 10);
  if (coupon.valid_from && coupon.valid_from > today) return false;
  if (coupon.valid_until && coupon.valid_until < today) return false;
  return true;
}

// Auto-applies to the highest-priced item in the cart — no extra question.
// A percent-off coupon gives the biggest rupee value against the pricier
// item, and this removes an interactive step (and a bug surface) entirely.
// deno-lint-ignore no-explicit-any
async function pickDiscountItem(supabase: SB, chatId: number, data: SessionData, coupon: any) {
  const target = data.cart.reduce(
    (max: { price: number }, c: { price: number }) => (c.price > max.price ? c : max),
    data.cart[0],
  );
  applyCouponToItem(data, coupon, target);
  await tgSend(chatId, `🎟️ Applied ${coupon.code} to ${target.name} — -₹${data.discount}`);
  await showConfirmation(supabase, chatId, data);
}

// deno-lint-ignore no-explicit-any
function applyCouponToItem(data: SessionData, coupon: any, item: { price: number; unit_id: string }) {
  const discount = coupon.discount_type === "percent"
    ? Math.round(item.price * (coupon.discount_value / 100))
    : coupon.discount_value;
  data.discount = Math.max(0, Math.min(discount, item.price));
  data.discountUnitId = item.unit_id;
  data.appliedCoupon = { code: coupon.code, wa: coupon.customer_wa };
}

function orderTotal(data: SessionData): number {
  const subtotal = data.cart.reduce((a: number, c: { price: number }) => a + c.price, 0);
  return Math.max(0, subtotal - (data.discount ?? 0));
}

// Telegram inline-keyboard buttons have no color/styling options at all —
// this is a hard platform limit, not something codeable around. Coupon
// options are visually set apart with a 🎟️ prefix instead.
//
// The button list only shows generic, admin-created coupons (seasonal
// offers etc.) — individual codes like stall-registration coupons can
// number in the dozens/hundreds and would make the list unusable, so
// those go through "Enter a code" instead, where the customer reads out
// their specific code and Shalini types it in directly.
async function showDiscountPicker(supabase: SB, chatId: number, data: SessionData) {
  const today = new Date().toISOString().slice(0, 10);
  const { data: coupons } = await supabase
    .from("coupons")
    .select("id, code, discount_type, discount_value, region, valid_from, valid_until")
    .eq("active", true)
    .eq("used", false)
    .eq("source", "admin")
    .in("region", ["india", "all"]);

  const validCoupons = (coupons ?? []).filter(
    (c: { valid_from: string | null; valid_until: string | null }) =>
      (!c.valid_from || c.valid_from <= today) && (!c.valid_until || c.valid_until >= today),
  );

  const buttons = validCoupons.map(
    (c: { id: string; code: string; discount_type: string; discount_value: number }) => {
      const label = c.discount_type === "percent" ? `${c.discount_value}% off` : `₹${c.discount_value} off`;
      return [{ text: `🎟️ ${c.code} — ${label}`, callback_data: `kiosk:coupon:${c.id}` }];
    },
  );
  buttons.push([{ text: "🔑 Enter a code", callback_data: "kiosk:discount:entercode" }]);
  buttons.push([{ text: "✏️ Custom discount amount", callback_data: "kiosk:discount:custom" }]);
  buttons.push([{ text: "➡️ No discount", callback_data: "kiosk:discount:none" }]);
  buttons.push(BACK_ROW);
  buttons.push(CANCEL_ROW);

  await tgSend(chatId, "Any discount for this sale?", { inline_keyboard: buttons });
  await saveSession(supabase, chatId, "kiosk_discount_pick", data);
}

// Cart-table snapshot shown right after name is captured, before the
// coupon question — the "final summary" step in the finalized flow spec.
async function showOrderSummary(chatId: number, data: SessionData) {
  const subtotal = data.cart.reduce((a: number, c: { price: number }) => a + c.price, 0);
  const lines = data.cart
    .map((c: { name: string; variant?: string; price: number }) => `${c.name}${c.variant ? " (" + c.variant + ")" : ""} — ₹${c.price}`)
    .join("\n");
  await tgSend(
    chatId,
    `Order summary:\n\n${lines}\n\nSubtotal: ₹${subtotal}\nCustomer: ${data.customer_name} (${data.customer_wa})`,
  );
}

async function askPaymentMode(supabase: SB, chatId: number, data: SessionData) {
  await tgSend(chatId, "Payment mode?", {
    inline_keyboard: [
      [{ text: "💵 Cash", callback_data: "kiosk:pay:cash" }],
      [{ text: "📲 UPI Direct", callback_data: "kiosk:pay:upi" }],
      [{ text: "💳 Razorpay", callback_data: "kiosk:pay:razorpay" }],
      BACK_ROW,
      CANCEL_ROW,
    ],
  });
  await saveSession(supabase, chatId, "kiosk_payment_mode", data);
}

// Shows the discount inline against the specific item it applies to,
// rather than as a separate order-wide line — matches how the coupon is
// actually applied (one item, not the whole cart).
function formatCartLines(data: SessionData): string {
  return data.cart
    .map((c: { unit_id: string; name: string; variant?: string; unit_code: string; price: number }) => {
      const base = `• ${c.name}${c.variant ? " (" + c.variant + ")" : ""} — ₹${c.price}`;
      if (data.discountUnitId === c.unit_id && data.discount) {
        return `${base}\n   ↳ -₹${data.discount} (${data.appliedCoupon?.code ?? "coupon"})`;
      }
      return base;
    })
    .join("\n");
}

// Confirms the order + total only — payment mode and amount received are
// asked afterward (in that order), per the finalized flow spec.
async function showConfirmation(supabase: SB, chatId: number, data: SessionData) {
  const subtotal = data.cart.reduce((a: number, c: { price: number }) => a + c.price, 0);
  const total = orderTotal(data);
  const lines = formatCartLines(data);
  await tgSend(
    chatId,
    `Confirm order?\n\n${lines}\n\nCustomer: ${data.customer_name} (${data.customer_wa})\nSubtotal: ₹${subtotal}\nTotal: ₹${total}`,
    {
      inline_keyboard: [
        [{ text: "✅ Confirm", callback_data: "kiosk:confirm" }],
        [{ text: "✕ Cancel", callback_data: "kiosk:cancel" }],
      ],
    },
  );
  await saveSession(supabase, chatId, "kiosk_confirm", data);
}

// Razorpay sales go through the exact same create-payment-link Edge
// Function the storefront uses, and only get written to `sales` when
// razorpay-webhook confirms the payment — never recorded here as if
// already paid. Kiosk mode stays persistent: the sale is left pending
// while the next customer is served; the webhook messages this chat_id
// back once the payment actually lands (see razorpay-webhook/index.ts).
async function sendRazorpayLink(supabase: SB, chatId: number, data: SessionData) {
  const total = orderTotal(data);
  const unit_ids = data.cart.map((c: { unit_id: string }) => c.unit_id);
  const res = await fetch(`${Deno.env.get("SUPABASE_URL")}/functions/v1/create-payment-link`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}`,
    },
    body: JSON.stringify({
      items: data.cart.map((c: { name: string }) => ({ name: c.name })),
      total,
      customer: { name: data.customer_name, wa: data.customer_wa },
      unit_ids,
      currency: "INR",
      coupon: data.appliedCoupon ? { code: data.appliedCoupon.code, wa: data.appliedCoupon.wa } : null,
      source: "telegram_kiosk",
      telegram_chat_id: chatId,
    }),
  });
  const linkData = await res.json();
  if (!res.ok || !linkData.short_url) {
    await tgSend(chatId, `Couldn't create the Razorpay link: ${linkData?.error ?? "unknown error"} — try Cash/UPI instead, or retry.`);
    await askPaymentMode(supabase, chatId, data);
    return;
  }

  const waDigits = String(data.customer_wa ?? "").replace(/\D/g, "");
  const waMsg = encodeURIComponent(`Hi ${data.customer_name}! Please pay ₹${total} for your Meensha order here: ${linkData.short_url}`);
  const waLink = waDigits ? `https://wa.me/${waDigits}?text=${waMsg}` : null;

  await tgSend(
    chatId,
    `💳 Razorpay link created — ₹${total}\n${linkData.short_url}` +
      (waLink ? `\n\nTap to send to customer: ${waLink}` : "") +
      `\n\nYou'll get a message here the moment it's paid.`,
  );

  data = { cart: [], page: 0 };
  await showItemPicker(supabase, chatId, data);
  await saveSession(supabase, chatId, "kiosk_pick_item", data);
}

async function finalizeSale(supabase: SB, chatId: number, data: SessionData) {
  const total = orderTotal(data);
  const paid = data.amount ?? total;

  const { data: ctrRow } = await supabase
    .from("settings")
    .select("value")
    .eq("key", "inv_counter")
    .single();
  const nextCtr = (parseInt(ctrRow?.value ?? "1000") || 1000) + 1;
  await supabase.from("settings").update({ value: String(nextCtr) }).eq("key", "inv_counter");
  const inv = "MSH-" + nextCtr;

  const { data: saleRow } = await supabase
    .from("sales")
    .insert({
      inv,
      date: new Date().toISOString().slice(0, 10),
      customer: { name: data.customer_name, wa: data.customer_wa },
      items: data.cart.map((c: { unit_id: string; name: string; variant?: string; unit_code: string; price: number }) => ({
        name: c.name,
        variant: c.variant || "",
        sku_code: c.unit_code,
        price: c.price,
        discount: data.discountUnitId === c.unit_id ? data.discount : 0,
      })),
      total,
      paid,
      balance: total - paid,
      pay_mode: data.pay_mode,
      delivery_mode: "offline",
      shipping_status: "na",
      created_by: "telegram_bot",
      source: "telegram",
    })
    .select()
    .single();

  if (saleRow) {
    for (const item of data.cart) {
      await supabase.rpc("claim_unit", { p_unit_id: item.unit_id, p_sale_id: saleRow.id });
    }
  }

  if (data.appliedCoupon) {
    await supabase.rpc("consume_coupon", {
      p_code: data.appliedCoupon.code,
      p_wa: data.appliedCoupon.wa,
    });
  }

  const lines = formatCartLines(data);
  const waDigits = String(data.customer_wa ?? "").replace(/\D/g, "");
  // The customer-facing message links to the real branded invoice
  // (invoice.html, public/unauthenticated — NOT admin.html, which requires
  // staff login and can't be opened by a customer) instead of re-typing an
  // order summary as plain text. invoice.html requires both the invoice
  // number and the matching WhatsApp number to actually show anything.
  const invoiceUrl = `https://meensha.in/invoice.html?invoice=${encodeURIComponent(inv)}&wa=${waDigits}`;
  const waMsg = encodeURIComponent(
    `Hi ${data.customer_name}! Thank you for your Meensha order. Your invoice (${inv}) is here: ${invoiceUrl}`,
  );
  const waLink = waDigits ? `https://wa.me/${waDigits}?text=${waMsg}` : null;

  await tgSend(
    chatId,
    `✅ Sale recorded — ${inv}\n\n${lines}\n\nTotal: ₹${total}\nPaid: ₹${paid}\nBalance: ₹${total - paid}` +
      (waLink ? `\n\nTap to send invoice to customer: ${waLink}` : "") +
      `\n\n🧾 View/print invoice yourself: ${invoiceUrl}`,
  );
  await notifyMonitor(supabase, `🇮🇳 Sale ${inv} — ₹${total} (${data.pay_mode || "?"}), via India Kiosk bot`);
}

// ═══════════════════════════════════════════════
// ENTER INVENTORY — vendor search/create, item entry loop, a summary/edit
// screen, then submit_purchase_intake_batch. Nothing here writes real
// inventory: it's staged (stock_intake_drafts) until approved on the web
// dashboard's Approvals tab (admin_approve_purchase_batch), which creates
// the purchase + sellable units and routes any flagged-defective pieces to
// inventory_returns_pending instead. Persistent like Kiosk mode — after a
// successful submit, loops back to vendor search for the next purchase
// instead of the top menu; "✕ Exit" (on every screen) is the way out.
// ═══════════════════════════════════════════════
async function handleInventory(
  supabase: SB,
  chatId: number,
  state: string,
  data: SessionData,
  callbackData: string,
) {
  if (callbackData === "inv:start") {
    data = { items: [] };
    await tgSend(chatId, "Search vendor by name or WhatsApp number:", {
      inline_keyboard: [[{ text: "➕ New Vendor", callback_data: "inv:newvendor" }], INV_EXIT_ROW],
    });
    await saveSession(supabase, chatId, "inv_vendor_search", data);
    return;
  }

  if (callbackData === "inv:exit") {
    await tgSend(chatId, "Exited Enter Inventory — nothing was saved.");
    await showTopMenu(chatId);
    await saveSession(supabase, chatId, "idle", {});
    return;
  }

  if (callbackData === "inv:newvendor") {
    data.newVendor = {};
    await tgSend(chatId, "New vendor — Name?", { inline_keyboard: [INV_EXIT_ROW] });
    await saveSession(supabase, chatId, "inv_vendor_new_name", data);
    return;
  }

  if (callbackData.startsWith("inv:vendor:")) {
    const vendorId = callbackData.split(":")[2];
    const { data: v } = await supabase.from("vendors").select("id,name").eq("id", vendorId).single();
    if (!v) {
      await tgSend(chatId, "That vendor is gone — try search again.");
      return;
    }
    data.vendor_uuid = v.id;
    data.vendor_name = v.name;
    await startItemEntry(supabase, chatId, data);
    return;
  }

  if (callbackData === "inv:defect:no") {
    await finishCurrentItem(supabase, chatId, data);
    return;
  }
  if (callbackData === "inv:defect:yes") {
    await tgSend(chatId, `How many of the ${data.curItem.qty} are defective?`, { inline_keyboard: [INV_EXIT_ROW] });
    await saveSession(supabase, chatId, "inv_item_defect_qty", data);
    return;
  }

  if (callbackData === "inv:additem") {
    await startItemEntry(supabase, chatId, data);
    return;
  }
  if (callbackData === "inv:review") {
    await showInvSummary(supabase, chatId, data);
    return;
  }

  if (callbackData.startsWith("inv:removerow:")) {
    const idx = parseInt(callbackData.split(":")[2]);
    data.items.splice(idx, 1);
    await showInvSummary(supabase, chatId, data);
    return;
  }
  if (callbackData.startsWith("inv:editrow:")) {
    data.editIdx = parseInt(callbackData.split(":")[2]);
    await tgSend(chatId, "Edit which field?", {
      inline_keyboard: [
        [{ text: "Name", callback_data: "inv:editfield:name" }, { text: "Material", callback_data: "inv:editfield:material" }],
        [{ text: "Variant", callback_data: "inv:editfield:variant" }, { text: "Cost", callback_data: "inv:editfield:cost" }],
        [{ text: "Qty", callback_data: "inv:editfield:qty" }, { text: "Sale price", callback_data: "inv:editfield:mrp" }],
        [{ text: "◀ Back to summary", callback_data: "inv:review" }],
        INV_EXIT_ROW,
      ],
    });
    await saveSession(supabase, chatId, "inv_edit_pick_field", data);
    return;
  }
  if (callbackData.startsWith("inv:editfield:")) {
    data.editField = callbackData.split(":")[2];
    await tgSend(chatId, `New value for ${data.editField}?`, { inline_keyboard: [INV_EXIT_ROW] });
    await saveSession(supabase, chatId, "inv_edit_value", data);
    return;
  }

  if (callbackData === "inv:submit") {
    if (!data.items?.length) {
      await tgSend(chatId, "Add at least one item first.");
      return;
    }
    await tgSend(chatId, "Amount paid (₹)?", { inline_keyboard: [INV_EXIT_ROW] });
    await saveSession(supabase, chatId, "inv_payment_amount", data);
    return;
  }
  if (callbackData.startsWith("inv:paymode:")) {
    data.paymentMode = callbackData.split(":")[2];
    await tgSend(
      chatId,
      `Split — Shalini's share (₹)? Total paid: ₹${data.paymentAmount}. Type 'skip' for an even 50/50 split.`,
      { inline_keyboard: [INV_EXIT_ROW] },
    );
    await saveSession(supabase, chatId, "inv_payment_split", data);
    return;
  }

  if (callbackData === "inv:finalsubmit") {
    const items = data.items.map((it: SessionData) => ({
      proposed_name: it.name,
      proposed_material: it.material,
      proposed_variant: it.variant,
      proposed_sale_price: it.mrp,
      purchase_price: it.cost,
      qty: it.qty,
      photo_urls: it.photos || [],
      is_defective: !!it.is_defective,
      defect_qty: it.defect_qty || null,
      defect_reason: it.defect_reason || null,
    }));
    const payment = { mode: data.paymentMode, amount_paid: data.paymentAmount, split: data.paymentSplit };
    const { error } = await supabase.rpc("submit_purchase_intake_batch", {
      p_vendor_uuid: data.vendor_uuid,
      p_items: items,
      p_payment: payment,
      p_submitted_by: `chat_id:${chatId}`,
      p_region: "india",
    });
    if (error) {
      await tgSend(chatId, "Couldn't submit that purchase — try again, or check with admin.");
      return;
    }
    const vendorName = data.vendor_name;
    await tgSend(chatId, `✅ Submitted for approval (${items.length} items) — admin will review on the web dashboard before it's live.`);
    await notifyMonitor(supabase, `🧾 Purchase submitted for approval — ${vendorName}, ${items.length} items, via India bot`);
    data = { items: [] };
    await tgSend(chatId, "Search vendor by name or WhatsApp number for the next purchase:", {
      inline_keyboard: [[{ text: "➕ New Vendor", callback_data: "inv:newvendor" }], INV_EXIT_ROW],
    });
    await saveSession(supabase, chatId, "inv_vendor_search", data);
    return;
  }
}

async function startItemEntry(supabase: SB, chatId: number, data: SessionData) {
  data.curItem = {};
  await tgSend(chatId, `Vendor: ${data.vendor_name}\n\nItem name?`, { inline_keyboard: [INV_EXIT_ROW] });
  await saveSession(supabase, chatId, "inv_item_name", data);
}

// Splits a partially-defective line into two staged rows (one good, one
// defective) — admin_approve_purchase_batch treats each stock_intake_drafts
// row as entirely good or entirely defective, so a "3 good, 1 defective"
// entry becomes two rows here rather than one row with a defect count.
async function finishCurrentItem(supabase: SB, chatId: number, data: SessionData) {
  const item = data.curItem;
  if (item.defect_qty && item.defect_qty > 0) {
    const goodQty = item.qty - item.defect_qty;
    if (goodQty > 0) {
      data.items.push({ ...item, qty: goodQty, is_defective: false, defect_qty: null, defect_reason: null });
    }
    data.items.push({ ...item, qty: item.defect_qty, is_defective: true });
  } else {
    data.items.push({ ...item, is_defective: false });
  }
  delete data.curItem;
  await showItemAddedMenu(supabase, chatId, data);
}

async function showItemAddedMenu(supabase: SB, chatId: number, data: SessionData) {
  await tgSend(chatId, "Item added.", {
    inline_keyboard: [
      [{ text: "➕ Add another item", callback_data: "inv:additem" }],
      [{ text: "📋 Review purchase so far", callback_data: "inv:review" }],
      INV_EXIT_ROW,
    ],
  });
  await saveSession(supabase, chatId, "inv_item_added", data);
}

async function showInvSummary(supabase: SB, chatId: number, data: SessionData) {
  if (!data.items?.length) {
    await tgSend(chatId, "No items staged yet.", {
      inline_keyboard: [[{ text: "➕ Add item", callback_data: "inv:additem" }], INV_EXIT_ROW],
    });
    return;
  }
  const lines = data.items
    .map((it: SessionData, i: number) =>
      `${i + 1}. ${it.name}${it.variant ? ` (${it.variant})` : ""} — ₹${it.cost} x${it.qty}` +
      (it.is_defective ? ` ⚠️ defective${it.defect_reason ? ": " + it.defect_reason : ""}` : ""))
    .join("\n");
  const buttons = data.items.map((_: SessionData, i: number) => [
    { text: `✏️ Edit #${i + 1}`, callback_data: `inv:editrow:${i}` },
    { text: `🗑️ Remove #${i + 1}`, callback_data: `inv:removerow:${i}` },
  ]);
  buttons.push([{ text: "➕ Add another item", callback_data: "inv:additem" }]);
  buttons.push([{ text: "✅ Confirm & submit purchase", callback_data: "inv:submit" }]);
  buttons.push(INV_EXIT_ROW);
  await tgSend(chatId, `Purchase so far — Vendor: ${data.vendor_name}\n\n${lines}`, { inline_keyboard: buttons });
  await saveSession(supabase, chatId, "inv_summary", data);
}

async function showFinalConfirm(supabase: SB, chatId: number, data: SessionData) {
  const total = data.items.reduce((a: number, it: SessionData) => a + it.cost * it.qty, 0);
  await tgSend(
    chatId,
    `Submit this purchase to the live system?\n\nVendor: ${data.vendor_name}\nItems: ${data.items.length}\nTotal cost: ₹${total}\nPaid: ₹${data.paymentAmount} (${data.paymentMode})\nSplit: Shalini ₹${data.paymentSplit.shalini} / Meenakshi ₹${data.paymentSplit.meenakshi}\n\nThis submits for admin approval — nothing is live inventory until approved.`,
    {
      inline_keyboard: [
        [{ text: "✅ Submit", callback_data: "inv:finalsubmit" }],
        [{ text: "◀ Back to summary", callback_data: "inv:review" }],
        INV_EXIT_ROW,
      ],
    },
  );
  await saveSession(supabase, chatId, "inv_final_confirm", data);
}

async function handleInventoryText(supabase: SB, chatId: number, state: string, data: SessionData, text: string) {
  const skip = text.trim().toLowerCase() === "skip";

  if (state === "inv_vendor_search") {
    const q = text.trim();
    const { data: matches } = await supabase
      .from("vendors")
      .select("id,name,company_name,wa_number")
      .or(`name.ilike.%${q}%,company_name.ilike.%${q}%,wa_number.ilike.%${q}%`)
      .limit(8);
    if (!matches?.length) {
      await tgSend(chatId, `No vendors matched "${q}".`, {
        inline_keyboard: [[{ text: "➕ New Vendor", callback_data: "inv:newvendor" }], INV_EXIT_ROW],
      });
      return;
    }
    const buttons = matches.map((v: { id: string; name: string; company_name?: string }) => [
      { text: `${v.name}${v.company_name ? " (" + v.company_name + ")" : ""}`, callback_data: `inv:vendor:${v.id}` },
    ]);
    buttons.push([{ text: "➕ New Vendor", callback_data: "inv:newvendor" }]);
    buttons.push(INV_EXIT_ROW);
    await tgSend(chatId, `Matches for "${q}":`, { inline_keyboard: buttons });
    return;
  }

  if (state === "inv_vendor_new_name") {
    if (!text.trim()) {
      await tgSend(chatId, "Name can't be empty — vendor name?");
      return;
    }
    data.newVendor.name = text.trim();
    await tgSend(chatId, "Company name? Type 'skip' if none.", { inline_keyboard: [INV_EXIT_ROW] });
    await saveSession(supabase, chatId, "inv_vendor_new_company", data);
    return;
  }
  if (state === "inv_vendor_new_company") {
    data.newVendor.company_name = skip ? null : text.trim();
    await tgSend(chatId, "WhatsApp number? Type 'skip' if none.", { inline_keyboard: [INV_EXIT_ROW] });
    await saveSession(supabase, chatId, "inv_vendor_new_wa", data);
    return;
  }
  if (state === "inv_vendor_new_wa") {
    data.newVendor.wa_number = skip ? null : text.trim();
    await tgSend(chatId, "Place? Type 'skip' if none.", { inline_keyboard: [INV_EXIT_ROW] });
    await saveSession(supabase, chatId, "inv_vendor_new_place", data);
    return;
  }
  if (state === "inv_vendor_new_place") {
    data.newVendor.place = skip ? null : text.trim();
    const { data: vid } = await supabase.rpc("next_vendor_id");
    const { data: created, error } = await supabase
      .from("vendors")
      .insert({
        vendor_id: vid,
        name: data.newVendor.name,
        company_name: data.newVendor.company_name,
        wa_number: data.newVendor.wa_number,
        place: data.newVendor.place,
        status: "active",
      })
      .select()
      .single();
    if (error || !created) {
      await tgSend(chatId, "Couldn't save that vendor — try again.");
      return;
    }
    data.vendor_uuid = created.id;
    data.vendor_name = created.name;
    delete data.newVendor;
    await tgSend(chatId, `✅ Vendor added: ${created.name} (${vid})`);
    await startItemEntry(supabase, chatId, data);
    return;
  }

  if (state === "inv_item_name") {
    if (!text.trim()) {
      await tgSend(chatId, "Name can't be empty — item name?");
      return;
    }
    data.curItem.name = text.trim();
    await tgSend(chatId, "Material? Type 'skip' if none.", { inline_keyboard: [INV_EXIT_ROW] });
    await saveSession(supabase, chatId, "inv_item_material", data);
    return;
  }
  if (state === "inv_item_material") {
    data.curItem.material = skip ? null : text.trim();
    await tgSend(chatId, "Variant? Type 'skip' if none.", { inline_keyboard: [INV_EXIT_ROW] });
    await saveSession(supabase, chatId, "inv_item_variant", data);
    return;
  }
  if (state === "inv_item_variant") {
    data.curItem.variant = skip ? null : text.trim();
    await tgSend(chatId, "Cost per piece (₹)?", { inline_keyboard: [INV_EXIT_ROW] });
    await saveSession(supabase, chatId, "inv_item_cost", data);
    return;
  }
  if (state === "inv_item_cost") {
    const cost = parseFloat(text);
    if (!cost || cost <= 0) {
      await tgSend(chatId, "Enter a valid cost per piece (₹)?");
      return;
    }
    data.curItem.cost = cost;
    await tgSend(chatId, "Quantity?", { inline_keyboard: [INV_EXIT_ROW] });
    await saveSession(supabase, chatId, "inv_item_qty", data);
    return;
  }
  if (state === "inv_item_qty") {
    const qty = parseInt(text);
    if (!qty || qty <= 0) {
      await tgSend(chatId, "Enter a valid quantity?");
      return;
    }
    data.curItem.qty = qty;
    const suggestion = await suggestMrp(supabase, data.curItem.name, data.curItem.material, data.curItem.variant, data.curItem.cost);
    await tgSend(
      chatId,
      `${suggestion ? `Suggested sale price: ${suggestion}\n\n` : ""}Type the sale price to use (₹), or 'skip' to leave blank.`,
      { inline_keyboard: [INV_EXIT_ROW] },
    );
    await saveSession(supabase, chatId, "inv_item_mrp", data);
    return;
  }
  if (state === "inv_item_mrp") {
    data.curItem.mrp = skip ? null : parseFloat(text) || null;
    data.curItem.photos = [];
    await tgSend(chatId, "Send 1-4 photos of this item, then type 'done'.", { inline_keyboard: [INV_EXIT_ROW] });
    await saveSession(supabase, chatId, "inv_item_photos", data);
    return;
  }
  if (state === "inv_item_photos") {
    if (text.trim().toLowerCase() === "done") {
      if (!data.curItem.photos?.length) {
        await tgSend(chatId, "At least one photo is required — send a photo, then type 'done'.");
        return;
      }
      await tgSend(chatId, "Any defective pieces in this batch — flag for return to vendor now?", {
        inline_keyboard: [
          [{ text: "⚠️ Yes", callback_data: "inv:defect:yes" }, { text: "No", callback_data: "inv:defect:no" }],
          INV_EXIT_ROW,
        ],
      });
      await saveSession(supabase, chatId, "inv_item_defect_check", data);
    }
    return;
  }
  if (state === "inv_item_defect_qty") {
    const q = parseInt(text);
    if (!q || q <= 0 || q > data.curItem.qty) {
      await tgSend(chatId, `Enter a valid defective quantity (1-${data.curItem.qty})?`);
      return;
    }
    data.curItem.defect_qty = q;
    await tgSend(chatId, "Reason?", { inline_keyboard: [INV_EXIT_ROW] });
    await saveSession(supabase, chatId, "inv_item_defect_reason", data);
    return;
  }
  if (state === "inv_item_defect_reason") {
    data.curItem.defect_reason = text.trim();
    await finishCurrentItem(supabase, chatId, data);
    return;
  }

  if (state === "inv_edit_value") {
    const field = data.editField;
    const item = data.items[data.editIdx];
    if (["cost", "qty", "mrp"].includes(field)) item[field] = parseFloat(text) || item[field];
    else item[field] = text.trim();
    delete data.editField;
    delete data.editIdx;
    await showInvSummary(supabase, chatId, data);
    return;
  }

  if (state === "inv_payment_amount") {
    const amt = parseFloat(text);
    if (!amt || amt <= 0) {
      await tgSend(chatId, "Enter a valid amount (₹)?");
      return;
    }
    data.paymentAmount = amt;
    await tgSend(chatId, "Payment mode?", {
      inline_keyboard: [
        [{ text: "UPI", callback_data: "inv:paymode:upi" }, { text: "Cash", callback_data: "inv:paymode:cash" }],
        [{ text: "Bank Transfer", callback_data: "inv:paymode:bank" }, { text: "Cheque", callback_data: "inv:paymode:cheque" }],
        INV_EXIT_ROW,
      ],
    });
    await saveSession(supabase, chatId, "inv_payment_mode", data);
    return;
  }
  if (state === "inv_payment_split") {
    let shalini: number, meenakshi: number;
    if (skip) {
      shalini = data.paymentAmount / 2;
      meenakshi = data.paymentAmount / 2;
    } else {
      shalini = parseFloat(text) || 0;
      meenakshi = data.paymentAmount - shalini;
    }
    data.paymentSplit = { shalini, meenakshi };
    await showFinalConfirm(supabase, chatId, data);
    return;
  }
}

async function handleInventoryPhoto(supabase: SB, chatId: number, data: SessionData, photoSizes: { file_id: string }[]) {
  if (!data.curItem) return;
  const largest = photoSizes[photoSizes.length - 1];
  const result = await uploadTelegramPhoto(largest.file_id);
  if ("error" in result) {
    await tgSend(chatId, `Couldn't save that photo — ${result.error}`);
    return;
  }
  data.curItem.photos = [...(data.curItem.photos || []), result.url].slice(0, 4);
  await saveSession(supabase, chatId, "inv_item_photos", data);
  await tgSend(chatId, `Photo ${data.curItem.photos.length}/4 saved. Send another, or type 'done'.`);
}

// No search grounding (unlike admin.html's callGeminiSearch) — a plain
// estimate from the model's general knowledge is enough for a "starting
// suggestion, editable" prompt; staff always type the real value next.
async function suggestMrp(
  supabase: SB,
  name: string,
  material: string | null,
  variant: string | null,
  cost: number,
): Promise<string | null> {
  try {
    const { data: keyRow } = await supabase.from("settings").select("value").eq("key", "gemini_key").maybeSingle();
    const apiKey = keyRow?.value;
    if (!apiKey) return null;
    const prompt = `Estimate a fair retail sale price in INR for a handloom saree: "${name}" ${material || ""} ${variant ? "(" + variant + ")" : ""}, cost price ₹${cost}. Reply with ONLY a number, no currency symbol, no other text.`;
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
      },
    );
    if (!res.ok) return null;
    const json = await res.json();
    const raw = json?.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
    const num = parseFloat((raw || "").replace(/[^\d.]/g, ""));
    return num ? `₹${num}` : null;
  } catch {
    return null;
  }
}

// ═══════════════════════════════════════════════
// GODOWN CHECK (stock audit) — EOD reconciliation + ad-hoc spot check.
// Both paths converge on the same match/discrepancy step, then log any
// discrepancy to vendor_issues (same table/fields admin.html's Vendor
// Issues tab uses) so it shows up there for follow-up. Returning a damaged
// piece to the vendor now reuses the same inventory_returns_pending flow as
// Enter Inventory's intake-time defect flagging (see admin.html's "Return
// to seller" action) — this
// just logs the issue for now, same as manually logging one in admin.html.
// ═══════════════════════════════════════════════
type GodownItem = { sku_id: string; name: string; au: boolean; avail: number; soldToday?: number };

async function handleGodown(
  supabase: SB,
  chatId: number,
  state: string,
  data: SessionData,
  callbackData: string,
) {
  if (callbackData === "godown:exit") {
    await tgSend(chatId, "Exited godown check.");
    await showTopMenu(chatId);
    await saveSession(supabase, chatId, "idle", {});
    return;
  }

  if (callbackData === "godown:start") {
    data = {};
    await tgSend(chatId, "📦 Godown check — what do you want to do?", {
      inline_keyboard: [
        [{ text: "📊 End-of-day reconciliation", callback_data: "godown:eod" }],
        [{ text: "🔍 Spot check an item", callback_data: "godown:spot" }],
        GODOWN_EXIT_ROW,
      ],
    });
    await saveSession(supabase, chatId, "godown_menu", data);
    return;
  }

  if (callbackData === "godown:eod") {
    await startGodownEod(supabase, chatId, data);
    return;
  }

  if (callbackData === "godown:spot") {
    await tgSend(chatId, "Type an item name to search:", { inline_keyboard: [GODOWN_EXIT_ROW] });
    await saveSession(supabase, chatId, "godown_spot_search", data);
    return;
  }

  if (callbackData.startsWith("godown:spotpick:")) {
    const skuId = callbackData.split(":")[2];
    const { data: sku } = await supabase
      .from("inventory_skus")
      .select("id, name, au_available")
      .eq("id", skuId)
      .single();
    const { data: units } = await supabase
      .from("inventory_units")
      .select("id")
      .eq("sku_id", skuId)
      .eq("status", "available");
    data.spotItem = { sku_id: sku.id, name: sku.name, au: sku.au_available, avail: (units ?? []).length };
    await showGodownItem(supabase, chatId, data, data.spotItem);
    await saveSession(supabase, chatId, "godown_spot_item", data);
    return;
  }

  if ((state === "godown_eod_item" || state === "godown_spot_item") && callbackData === "godown:match") {
    await advanceGodown(supabase, chatId, state, data);
    return;
  }

  if ((state === "godown_eod_item" || state === "godown_spot_item") && callbackData === "godown:discrepancy") {
    data.discFromState = state;
    data.discItem = state === "godown_eod_item" ? data.eodList[data.eodIdx] : data.spotItem;
    await tgSend(chatId, "What kind of discrepancy?", {
      inline_keyboard: [
        [{ text: "📉 Missing", callback_data: "godown:disc:missing" }],
        [{ text: "🔨 Damaged", callback_data: "godown:disc:damage" }],
        [{ text: "📈 Extra", callback_data: "godown:disc:extra" }],
        GODOWN_EXIT_ROW,
      ],
    });
    await saveSession(supabase, chatId, "godown_discrepancy_type", data);
    return;
  }

  if (state === "godown_discrepancy_type" && callbackData.startsWith("godown:disc:")) {
    const typeMap: Record<string, string> = { missing: "shortage", damage: "damage", extra: "other" };
    data.discType = typeMap[callbackData.split(":")[2]] ?? "other";
    data.selectedUnitIds = [];
    // "Extra" means ground stock the system doesn't know about at all —
    // there's no existing unit record to tie it to, so skip straight to
    // the note. Missing/Damaged are both about a specific physical piece,
    // so offer to pick which one(s) first.
    if (data.discType === "other") {
      await promptGodownNote(chatId);
      await saveSession(supabase, chatId, "godown_discrepancy_note", data);
    } else {
      await showGodownUnitPicker(supabase, chatId, data);
    }
    return;
  }

  if (state === "godown_unit_pick" && callbackData.startsWith("godown:unitpick:")) {
    const val = callbackData.split(":")[2];
    if (val === "done") {
      await promptGodownNote(chatId);
      await saveSession(supabase, chatId, "godown_discrepancy_note", data);
      return;
    }
    const selected: string[] = data.selectedUnitIds ?? [];
    data.selectedUnitIds = selected.includes(val) ? selected.filter((x: string) => x !== val) : [...selected, val];
    await showGodownUnitPicker(supabase, chatId, data);
    return;
  }

  if (state === "godown_discrepancy_note" && (callbackData === "godown:disc:skip" || callbackData === "godown:disc:notedone")) {
    await finalizeGodownDiscrepancy(supabase, chatId, data, "");
    return;
  }
}

async function promptGodownNote(chatId: number) {
  await tgSend(chatId, "Add a note, attach a photo, or tap Skip:", {
    inline_keyboard: [[{ text: "⏭ Skip", callback_data: "godown:disc:skip" }], GODOWN_EXIT_ROW],
  });
}

async function showGodownUnitPicker(supabase: SB, chatId: number, data: SessionData) {
  const item: GodownItem = data.discItem;
  const { data: units } = await supabase
    .from("inventory_units")
    .select("id, unit_code")
    .eq("sku_id", item.sku_id)
    .eq("status", "available");
  const selected: string[] = data.selectedUnitIds ?? [];
  const buttons = (units ?? []).map((u: { id: string; unit_code: string }) => [{
    text: `${selected.includes(u.id) ? "✅ " : ""}${u.unit_code}`,
    callback_data: `godown:unitpick:${u.id}`,
  }]);
  buttons.push([{ text: `➡️ Done (${selected.length} selected)`, callback_data: "godown:unitpick:done" }]);
  buttons.push(GODOWN_EXIT_ROW);
  await tgSend(chatId, `Which piece(s) of "${item.name}" is this about? (optional — tap Done to skip)`, { inline_keyboard: buttons });
  await saveSession(supabase, chatId, "godown_unit_pick", data);
}

async function handleGodownPhoto(supabase: SB, chatId: number, data: SessionData, photoSizes: { file_id: string }[]) {
  const largest = photoSizes[photoSizes.length - 1];
  const result = await uploadTelegramPhoto(largest.file_id);
  if ("error" in result) {
    await tgSend(chatId, `Couldn't save that photo — ${result.error}`);
    return;
  }
  data.discPhotoUrl = result.url;
  await tgSend(chatId, "📷 Photo attached. Add a text note too, or tap Done to save.", {
    inline_keyboard: [[{ text: "✅ Done", callback_data: "godown:disc:notedone" }], GODOWN_EXIT_ROW],
  });
  await saveSession(supabase, chatId, "godown_discrepancy_note", data);
}

// Mirrors the download-then-reupload pattern from the Enter Inventory plan's
// photo handling (not yet built there, but the pattern is simple enough to
// use here now): resolve Telegram's file_id to a real URL, fetch the bytes,
// re-upload to the same item-photos bucket admin.html already uses.
async function uploadTelegramPhoto(fileId: string): Promise<{ url: string } | { error: string }> {
  const fileRes = await fetch(`${TG_API}/getFile?file_id=${fileId}`);
  const fileJson = await fileRes.json();
  const filePath = fileJson?.result?.file_path;
  if (!filePath) return { error: `Telegram getFile failed: ${JSON.stringify(fileJson).slice(0, 200)}` };

  const imgRes = await fetch(`https://api.telegram.org/file/bot${BOT_TOKEN}/${filePath}`);
  if (!imgRes.ok) return { error: `Telegram file download failed: ${imgRes.status}` };
  const imgBuf = await imgRes.arrayBuffer();

  const objectName = `${Date.now()}-inventory-telegram.jpg`;
  const uploadRes = await fetch(
    `${Deno.env.get("SUPABASE_URL")}/storage/v1/object/item-photos/${objectName}`,
    {
      method: "POST",
      headers: {
        apikey: Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
        Authorization: `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}`,
        "Content-Type": "image/jpeg",
        "x-upsert": "true",
      },
      body: imgBuf,
    },
  );
  if (!uploadRes.ok) {
    const body = await uploadRes.text();
    return { error: `Storage upload failed: ${uploadRes.status} ${body.slice(0, 200)}` };
  }
  return { url: `${Deno.env.get("SUPABASE_URL")}/storage/v1/object/public/item-photos/${objectName}` };
}

// Shared by the Skip button, the "Done" button after a photo, and typed
// text (handleGodownText) — the one place that actually writes the
// vendor_issues row, whichever way the note step was completed.
async function finalizeGodownDiscrepancy(supabase: SB, chatId: number, data: SessionData, note: string) {
  const item: GodownItem = data.discItem;
  const selectedUnitIds: string[] = data.selectedUnitIds ?? [];

  const { data: unitRow } = await supabase
    .from("inventory_units")
    .select("vendor_code")
    .eq("sku_id", item.sku_id)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  const vendorCode: string | null = unitRow?.vendor_code ?? null;
  let vendorUuid: string | null = null;
  if (vendorCode) {
    const { data: vRow } = await supabase.from("vendors").select("id").eq("vendor_id", vendorCode).maybeSingle();
    vendorUuid = vRow?.id ?? null;
  }

  const cleanNote = note.trim();
  const photoLine = data.discPhotoUrl ? `\nPhoto: ${data.discPhotoUrl}` : "";
  const source = data.discFromState === "godown_eod_item" ? "EOD reconciliation" : "spot check";
  const description = `${cleanNote || "(no note)"}${photoLine} — found during ${source} via Telegram bot`;

  if (vendorUuid) {
    await supabase.from("vendor_issues").insert({
      vendor_uuid: vendorUuid,
      vendor_code: vendorCode,
      sku_id: item.sku_id,
      batch: null,
      unit_ids: selectedUnitIds,
      issue_date: new Date().toISOString().slice(0, 10),
      issue_type: data.discType ?? "other",
      description,
      status: "open",
      created_by: "telegram_bot",
    });
    const pieceNote = selectedUnitIds.length ? ` (${selectedUnitIds.length} piece${selectedUnitIds.length > 1 ? "s" : ""})` : "";
    await tgSend(chatId, `⚠️ Logged: ${item.name}${pieceNote} — added to Vendor Issues for follow-up.`);
  } else {
    await tgSend(chatId, `⚠️ Couldn't resolve a vendor for ${item.name} — please log this one manually in admin.html's Vendor Issues.`);
  }

  // Damaged pieces: flip their status so they stop showing as sellable —
  // "damaged" is already a valid inventory_units status, no schema change
  // needed. Missing pieces aren't touched — there's no "missing" status,
  // and guessing wrong (it could just be misplaced) is worse than leaving
  // it as a logged issue only.
  if (data.discType === "damage" && selectedUnitIds.length) {
    await supabase.from("inventory_units").update({ status: "damaged", updated_at: new Date().toISOString() }).in("id", selectedUnitIds);
  }

  data.discPhotoUrl = undefined;
  data.selectedUnitIds = undefined;
  await advanceGodown(supabase, chatId, data.discFromState, data);
}

async function handleGodownText(supabase: SB, chatId: number, state: string, data: SessionData, text: string) {
  if (state === "godown_spot_search") {
    const q = text.trim();
    const { data: skus } = await supabase
      .from("inventory_skus")
      .select("id, name, au_available")
      .ilike("name", `%${q}%`);
    if (!skus?.length) {
      await tgSend(chatId, "No items matched that name — try again, or Exit.", { inline_keyboard: [GODOWN_EXIT_ROW] });
      return;
    }
    const { data: units } = await supabase.from("inventory_units").select("sku_id").eq("status", "available");
    const availCount: Record<string, number> = {};
    (units ?? []).forEach((u: { sku_id: string }) => {
      availCount[u.sku_id] = (availCount[u.sku_id] ?? 0) + 1;
    });
    const buttons = skus.map((s: { id: string; name: string; au_available: boolean }) => [{
      text: `${s.au_available ? "🇦🇺 " : ""}${s.name} (${availCount[s.id] ?? 0} in stock)`,
      callback_data: `godown:spotpick:${s.id}`,
    }]);
    buttons.push(GODOWN_EXIT_ROW);
    await tgSend(chatId, "Matching items:", { inline_keyboard: buttons });
    return;
  }

  if (state === "godown_discrepancy_note") {
    await finalizeGodownDiscrepancy(supabase, chatId, data, text.trim());
    return;
  }
}

async function startGodownEod(supabase: SB, chatId: number, data: SessionData) {
  const today = new Date().toISOString().slice(0, 10);
  const { data: todaySales } = await supabase.from("sales").select("items").eq("date", today);

  // sales.items[].sku_code is actually the physical unit_code (see
  // finalizeSale above), not a stable SKU identifier — group by product
  // name instead, which is what's actually stable per SKU.
  const nameCounts: Record<string, number> = {};
  (todaySales ?? []).forEach((s: { items: { name: string }[] }) => {
    (s.items ?? []).forEach((it: { name: string }) => {
      nameCounts[it.name] = (nameCounts[it.name] ?? 0) + 1;
    });
  });
  const soldNames = Object.keys(nameCounts);
  if (!soldNames.length) {
    await tgSend(chatId, "No sales recorded today — nothing to reconcile yet.");
    await showTopMenu(chatId);
    await saveSession(supabase, chatId, "idle", {});
    return;
  }

  const { data: skus } = await supabase.from("inventory_skus").select("id, name, au_available").in("name", soldNames);
  const { data: units } = await supabase.from("inventory_units").select("sku_id").eq("status", "available");
  const availCount: Record<string, number> = {};
  (units ?? []).forEach((u: { sku_id: string }) => {
    availCount[u.sku_id] = (availCount[u.sku_id] ?? 0) + 1;
  });

  data.eodList = (skus ?? []).map((s: { id: string; name: string; au_available: boolean }) => ({
    sku_id: s.id,
    name: s.name,
    au: s.au_available,
    soldToday: nameCounts[s.name] ?? 0,
    avail: availCount[s.id] ?? 0,
  }));
  data.eodIdx = 0;
  await showGodownItem(supabase, chatId, data, data.eodList[0]);
  await saveSession(supabase, chatId, "godown_eod_item", data);
}

async function showGodownItem(supabase: SB, chatId: number, data: SessionData, item: GodownItem) {
  const auTag = item.au ? "🇦🇺 " : "";
  const soldLine = item.soldToday !== undefined ? `Sold today: ${item.soldToday}\n` : "";
  await tgSend(
    chatId,
    `${auTag}${item.name}\n${soldLine}Expected in stock: ${item.avail}\n\nDoes the physical count match?`,
    {
      inline_keyboard: [
        [{ text: "✅ Matches", callback_data: "godown:match" }],
        [{ text: "⚠️ Discrepancy", callback_data: "godown:discrepancy" }],
        GODOWN_EXIT_ROW,
      ],
    },
  );
}

// Shared "what happens after this item is resolved" step for both the EOD
// list-walk and the spot-check single-item flow — matched or logged, either
// way this decides whether to show the next EOD item or re-prompt spot search.
async function advanceGodown(supabase: SB, chatId: number, fromState: string, data: SessionData) {
  if (fromState === "godown_eod_item") {
    data.eodIdx = (data.eodIdx ?? 0) + 1;
    const list = data.eodList ?? [];
    if (data.eodIdx >= list.length) {
      await tgSend(chatId, "✅ End-of-day reconciliation complete.");
      await showTopMenu(chatId);
      await saveSession(supabase, chatId, "idle", {});
      return;
    }
    await showGodownItem(supabase, chatId, data, list[data.eodIdx]);
    await saveSession(supabase, chatId, "godown_eod_item", data);
    return;
  }
  await tgSend(chatId, "Type another item name to search, or Exit.", { inline_keyboard: [GODOWN_EXIT_ROW] });
  await saveSession(supabase, chatId, "godown_spot_search", data);
}

// ═══════════════════════════════════════════════
// SALES HISTORY (read-only) — browse recent sales, resend an invoice.
// India-scoped: only sales recorded via this bot or admin.html's manual
// entry for India stock, matching every other lookup on this bot (Kiosk,
// natural-language Q&A) — AU sales stay on the AU bot.
// ═══════════════════════════════════════════════
const HIST_PAGE_SIZE = 5;

async function handleSalesHistory(supabase: SB, chatId: number, data: SessionData, callbackData: string) {
  if (callbackData === "hist:start") {
    data.histOffset = 0;
    await showSalesHistoryPage(supabase, chatId, data);
    await saveSession(supabase, chatId, "hist_list", data);
    return;
  }
  if (callbackData.startsWith("hist:page:")) {
    data.histOffset = parseInt(callbackData.split(":")[2]);
    await showSalesHistoryPage(supabase, chatId, data);
    await saveSession(supabase, chatId, "hist_list", data);
    return;
  }
  if (callbackData.startsWith("hist:view:")) {
    const saleId = callbackData.split(":")[2];
    await showSaleSummary(supabase, chatId, saleId);
    return;
  }
  if (callbackData.startsWith("hist:invoice:")) {
    const saleId = callbackData.split(":")[2];
    await sendHistoryInvoiceLink(supabase, chatId, saleId);
    return;
  }
  if (callbackData === "hist:back") {
    await showSalesHistoryPage(supabase, chatId, data);
    await saveSession(supabase, chatId, "hist_list", data);
    return;
  }
  if (callbackData === "hist:exit") {
    await showTopMenu(chatId);
    await saveSession(supabase, chatId, "idle", {});
    return;
  }
}

async function showSalesHistoryPage(supabase: SB, chatId: number, data: SessionData) {
  const offset = data.histOffset ?? 0;
  const { data: rows, count } = await supabase
    .from("sales")
    .select("id, inv, date, customer, total", { count: "exact" })
    .order("created_at", { ascending: false })
    .range(offset, offset + HIST_PAGE_SIZE - 1);

  if (!rows?.length) {
    await tgSend(chatId, offset === 0 ? "No sales recorded yet." : "No more sales.", {
      inline_keyboard: [[{ text: "✕ Exit", callback_data: "hist:exit" }]],
    });
    return;
  }

  const buttons = rows.map((s: { id: string; inv: string; date: string; customer: { name?: string }; total: number }) => [
    { text: `${s.inv} · ${s.customer?.name ?? "—"} · ₹${s.total} · ${s.date}`, callback_data: `hist:view:${s.id}` },
  ]);
  const navRow = [];
  if (offset > 0) navRow.push({ text: "◀ Prev 5", callback_data: `hist:page:${Math.max(0, offset - HIST_PAGE_SIZE)}` });
  if ((count ?? 0) > offset + HIST_PAGE_SIZE) navRow.push({ text: "Next 5 ▶", callback_data: `hist:page:${offset + HIST_PAGE_SIZE}` });
  if (navRow.length) buttons.push(navRow);
  buttons.push([{ text: "✕ Exit", callback_data: "hist:exit" }]);

  await tgSend(chatId, "🧾 Recent sales — tap one for details:", { inline_keyboard: buttons });
}

async function showSaleSummary(supabase: SB, chatId: number, saleId: string) {
  const { data: s } = await supabase
    .from("sales")
    .select("inv, date, customer, items, total, paid, balance, pay_mode")
    .eq("id", saleId)
    .single();
  if (!s) {
    await tgSend(chatId, "That sale couldn't be found — it may have been removed.", {
      inline_keyboard: [[{ text: "◀ Back to list", callback_data: "hist:back" }]],
    });
    return;
  }
  const lines = (s.items ?? [])
    .map((it: { name: string; variant?: string; price: number }) => `• ${it.name}${it.variant ? " (" + it.variant + ")" : ""} — ₹${it.price}`)
    .join("\n");
  await tgSend(
    chatId,
    `${s.inv} — ${s.date}\nCustomer: ${s.customer?.name ?? "—"} (${s.customer?.wa ?? "—"})\n\n${lines}\n\nTotal: ₹${s.total}\nPaid: ₹${s.paid}\nBalance: ₹${s.balance}\nPayment: ${s.pay_mode ?? "—"}`,
    {
      inline_keyboard: [
        [{ text: "🧾 Send Invoice", callback_data: `hist:invoice:${saleId}` }],
        [{ text: "◀ Back to list", callback_data: "hist:back" }],
      ],
    },
  );
}

async function sendHistoryInvoiceLink(supabase: SB, chatId: number, saleId: string) {
  const { data: s } = await supabase.from("sales").select("inv, customer, total, paid").eq("id", saleId).single();
  if (!s) {
    await tgSend(chatId, "That sale couldn't be found.");
    return;
  }
  const waDigits = String(s.customer?.wa ?? "").replace(/\D/g, "");
  const invoiceUrl = `https://meensha.in/invoice.html?invoice=${encodeURIComponent(s.inv)}&wa=${waDigits}`;
  const waMsg = encodeURIComponent(
    `Hi ${s.customer?.name ?? ""}! Here's your Meensha invoice ${s.inv}: ${invoiceUrl}`,
  );
  const waLink = waDigits ? `https://wa.me/${waDigits}?text=${waMsg}` : null;
  await tgSend(
    chatId,
    `🧾 View/print invoice yourself: ${invoiceUrl}` + (waLink ? `\n\nTap to send to customer: ${waLink}` : ""),
    { inline_keyboard: [[{ text: "◀ Back to list", callback_data: "hist:back" }]] },
  );
}
