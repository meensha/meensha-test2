// Meensha Australia staff bot (@meenshaozbot).
// Separate Edge Function from the India bot (supabase/functions/telegram-bot/) —
// own token, own webhook secret, own auth/session tables (telegram_allowed_users_au,
// telegram_sessions_au). Region is always 'australia' — no region-select step
// anywhere, since this whole bot only ever operates in AU: pricing reads
// sale_price_aud, inventory search filters au_available=true, Stock Intake
// drafts always submit with region='australia'.
//
// Design (v1 spec, refined this session — see MEENSHA_TELEGRAM_BOT_V2_PLAN in
// the Homelab project's plan file for the full critique/rationale):
//   - Kiosk mode: photo-based search results (not plain text), quantity via
//     auto-picked units (reserve_unit/claim_unit), full checkout with coupon
//     support (validate_coupon/consume_coupon, region-checked), manual
//     payment confirmation (staff witnesses in-person payment directly).
//   - Stock Intake: DRAFT-first, not direct write — submit_stock_intake_draft
//     RPC, real inventory only created once approved on the web dashboard.
//   - Reports: lightweight, AU-scoped only (this bot's own region) — the
//     fuller cross-region audit/tech-health view lives in @meenshabot, not here.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { askGemini } from "../_shared/askGemini.ts";
import { LOOKUP_CATALOG_REGIONAL, runLookup } from "../_shared/knowledgeBase.ts";
import { handleRequestAction } from "../_shared/requestActions.ts";
import { logActivity } from "../_shared/activityLog.ts";

const BOT_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN_AU")!;
const TG_API = `https://api.telegram.org/bot${BOT_TOKEN}`;
const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SB_SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

// Module-scope client so tgSend/tgSendPhoto (no supabase param) can log
// outbound messages — see logMessage(). Feeds MeenshaMonitor's on-demand
// "show me X's chat" lookup (chat_transcript in knowledgeBase.ts).
const logClient = createClient(SB_URL, SB_SERVICE_KEY);
async function logMessage(chatId: number | string, direction: "in" | "out", text: string) {
  try {
    await logClient.from("bot_message_log").insert({ bot: "au", chat_id: String(chatId), direction, text });
  } catch { /* best-effort */ }
}

function fmtAud(n: number) {
  return `A$${(n ?? 0).toFixed(2)}`;
}

function cartTotal(cart: any[]): number {
  return (cart ?? []).reduce((sum: number, item: any) => sum + item.sku.sale_price_aud * item.qty, 0);
}

// Mirrors the storefront's couponDiscountBase (index.html) — a category
// filter matches against item names, whole-cart discount otherwise.
function couponDiscountBase(cart: any[], categoryFilter: string | null): number {
  const matching = categoryFilter
    ? (cart ?? []).filter((item: any) => (item.sku.name ?? "").toLowerCase().includes(categoryFilter.toLowerCase()))
    : (cart ?? []);
  return matching.reduce((sum: number, item: any) => sum + item.sku.sale_price_aud * item.qty, 0);
}

function effectiveTotal(data: any): number {
  const sub = cartTotal(data.cart ?? []);
  return Math.max(0, sub - (data.coupon_discount || 0));
}

async function showKioskConfirm(supabase: any, chatId: number, data: any) {
  await saveSession(supabase, chatId, "kiosk_confirm", data);
  const total = effectiveTotal(data);
  await tgSend(chatId, `Confirm sale: ${fmtAud(data.amount_paid ?? total)} via ${data.payment_mode}?`, {
    inline_keyboard: [[{ text: "✅ Confirm", callback_data: "kiosk:confirm" }, { text: "❌ Cancel", callback_data: "kiosk:cancel" }]],
  });
}

async function tgSend(chatId: number | string, text: string, keyboard?: any) {
  await fetch(`${TG_API}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: "Markdown", reply_markup: keyboard }),
  });
  await logMessage(chatId, "out", text);
}


async function tgSendPhoto(chatId: number | string, photoUrl: string, caption: string, keyboard?: any) {
  await fetch(`${TG_API}/sendPhoto`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, photo: photoUrl, caption, parse_mode: "Markdown", reply_markup: keyboard }),
  });
  await logMessage(chatId, "out", caption ? `[photo] ${caption}` : "[photo]");
}

async function saveSession(supabase: any, chatId: number, state: string, data: object) {
  await supabase.from("telegram_sessions_au").upsert({
    chat_id: chatId, state, data, updated_at: new Date().toISOString(),
  });
}

async function showTopMenu(chatId: number) {
  await tgSend(chatId, "🇦🇺 *Meensha Australia*\nWhat would you like to do?", {
    inline_keyboard: [
      [{ text: "🛍️ Kiosk mode (sale)", callback_data: "kiosk:start" }],
      [{ text: "📦 Stock intake (draft)", callback_data: "intake:start" }],
      [{ text: "➕ Enter inventory (vendor purchase)", callback_data: "inv:start" }],
      [{ text: "📊 Reports", callback_data: "reports:start" }],
      [{ text: "🎟️ Vouchers", callback_data: "vouchers:menu" }],
      [{ text: "📦 Godown check", callback_data: "godown:start" }],
      [{ text: "🔧 Maintenance", callback_data: "maint:menu" }],
    ],
  });
}

async function showVouchersMenu(chatId: number) {
  await tgSend(chatId, "Vouchers:", {
    inline_keyboard: [
      [{ text: "🎟️ Create voucher", callback_data: "vouchers:create" }],
      [{ text: "📋 Create event form", callback_data: "vouchers:eventform" }],
      [{ text: "◀ Back to menu", callback_data: "vouchers:back" }],
    ],
  });
}

const STOREFRONT_URL = "https://meensha.in";

function daysFromNow(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}

// ── Vouchers ─────────────────────────────────────────────────────────────────
// Same admin_create_coupon / admin_create_voucher_event RPCs admin.html and
// the India bot use — region is always "australia" here. See
// setup/add_voucher_events.sql for the event-form schema.

async function handleVoucherType(supabase: any, chatId: number, data: any, callbackData: string) {
  const vType = callbackData.split(":")[2];
  await saveSession(supabase, chatId, "voucher_value", { ...data, v_type: vType });
  await tgSend(chatId, vType === "percent" ? "Discount %? (e.g. 10)" : "Discount amount in A$? (e.g. 20)");
}

async function handleVoucherText(supabase: any, chatId: number, state: string, data: any, text: string) {
  const t = text.trim();
  if (state === "voucher_code") {
    if (!t) { await tgSend(chatId, "Code can't be empty — type a voucher code:"); return; }
    await saveSession(supabase, chatId, "voucher_pick_type", { ...data, v_code: t.toUpperCase() });
    await tgSend(chatId, "Discount type?", { inline_keyboard: [
      [{ text: "% Percent off", callback_data: "voucher:type:percent" }],
      [{ text: "A$ Flat amount off", callback_data: "voucher:type:flat" }],
    ] });
    return;
  }
  if (state === "voucher_value") {
    const val = parseFloat(t);
    if (!val || val <= 0 || (data.v_type === "percent" && val > 100)) { await tgSend(chatId, "Enter a valid discount value:"); return; }
    await saveSession(supabase, chatId, "voucher_name", { ...data, v_value: val });
    await tgSend(chatId, "For one specific customer? Type their name, or 'skip' for a public code anyone can use.");
    return;
  }
  if (state === "voucher_name") {
    if (t.toLowerCase() === "skip") {
      await saveSession(supabase, chatId, "voucher_days", { ...data, v_name: null, v_wa: null });
      await tgSend(chatId, "Valid for how many days? (leave blank for 7)");
      return;
    }
    await saveSession(supabase, chatId, "voucher_wa", { ...data, v_name: t });
    await tgSend(chatId, "Their WhatsApp number?");
    return;
  }
  if (state === "voucher_wa") {
    await saveSession(supabase, chatId, "voucher_days", { ...data, v_wa: t });
    await tgSend(chatId, "Valid for how many days? (leave blank for 7)");
    return;
  }
  if (state === "voucher_days") {
    const { data: auSkus } = await supabase.from("inventory_skus").select("id").eq("au_available", true);
    const auSkuIds = (auSkus ?? []).map((s: { id: string }) => s.id);
    let hasStock = false;
    if (auSkuIds.length) {
      const { count } = await supabase.from("inventory_units").select("id", { count: "exact", head: true })
        .eq("status", "available").in("sku_id", auSkuIds);
      hasStock = (count ?? 0) > 0;
    }
    if (!hasStock) {
      await tgSend(chatId, "❌ Invalid — currently there is no stock in the inventory on AUS site. Add inventory before creating vouchers.");
      await logActivity(supabase, "au", chatId, "voucher_blocked_no_stock", data.v_code);
      await showVouchersMenu(chatId);
      await saveSession(supabase, chatId, "idle", {});
      return;
    }
    const days = t ? parseInt(t, 10) || 7 : 7;
    const { data: coupon, error } = await supabase.rpc("admin_create_coupon", {
      p_code: data.v_code, p_customer_name: data.v_name, p_customer_wa: data.v_wa,
      p_discount_type: data.v_type, p_discount_value: data.v_value, p_region: "australia",
      p_valid_from: daysFromNow(0), p_valid_until: daysFromNow(days),
    });
    if (error || !coupon) {
      await tgSend(chatId, `Couldn't create the voucher — code "${data.v_code}" may already exist.`);
    } else {
      const discTxt = data.v_type === "percent" ? `${data.v_value}% off` : `${fmtAud(data.v_value)} off`;
      const who = data.v_name ? `locked to ${data.v_name}` : "public — anyone can use it";
      await tgSend(chatId, `🎟️ Voucher created: ${data.v_code}\n${discTxt}, ${who}, valid ${days} day(s).`);
      await logActivity(supabase, "au", chatId, "voucher", data.v_code);
    }
    await showVouchersMenu(chatId);
    await saveSession(supabase, chatId, "idle", {});
    return;
  }
}

async function handleEventformType(supabase: any, chatId: number, data: any, callbackData: string) {
  const efType = callbackData.split(":")[2];
  await saveSession(supabase, chatId, "eventform_value", { ...data, ef_type: efType });
  await tgSend(chatId, efType === "percent" ? "Discount %? (e.g. 10)" : "Discount amount in A$? (e.g. 20)");
}

async function handleEventformText(supabase: any, chatId: number, state: string, data: any, text: string) {
  const t = text.trim();
  if (state === "eventform_title") {
    if (!t) { await tgSend(chatId, "Title can't be empty — type the event title:"); return; }
    await saveSession(supabase, chatId, "eventform_pick_type", { ...data, ef_title: t });
    await tgSend(chatId, "Discount type?", { inline_keyboard: [
      [{ text: "% Percent off", callback_data: "eventform:type:percent" }],
      [{ text: "A$ Flat amount off", callback_data: "eventform:type:flat" }],
    ] });
    return;
  }
  if (state === "eventform_value") {
    const val = parseFloat(t);
    if (!val || val <= 0 || (data.ef_type === "percent" && val > 100)) { await tgSend(chatId, "Enter a valid discount value:"); return; }
    await saveSession(supabase, chatId, "eventform_days", { ...data, ef_value: val });
    await tgSend(chatId, "Voucher valid for how many days after each visitor registers? (leave blank for 7)");
    return;
  }
  if (state === "eventform_days") {
    const days = t ? parseInt(t, 10) || 7 : 7;
    const { data: ev, error } = await supabase.rpc("admin_create_voucher_event", {
      p_title: data.ef_title, p_region: "australia", p_discount_type: data.ef_type,
      p_discount_value: data.ef_value, p_valid_days: days, p_created_by: `telegram_au:${chatId}`,
    });
    if (error || !ev?.id) {
      await tgSend(chatId, "Couldn't create the event form — try again.");
    } else {
      const link = `${STOREFRONT_URL}/register.html?event=${ev.id}`;
      const discTxt = data.ef_type === "percent" ? `${data.ef_value}% off` : `${fmtAud(data.ef_value)} off`;
      await tgSend(chatId, `📋 [${data.ef_title}](${link})\n\nShare this link — each visitor who fills in their name + WhatsApp gets their own unique voucher (${discTxt}, valid ${days} day(s)).\n\n${link}`);
      await logActivity(supabase, "au", chatId, "event_form", data.ef_title);
    }
    await showVouchersMenu(chatId);
    await saveSession(supabase, chatId, "idle", {});
    return;
  }
}

// ── Kiosk mode ──────────────────────────────────────────────────────────────

async function kioskSearch(supabase: any, chatId: number, query: string) {
  const { data: skus } = await supabase
    .from("inventory_skus")
    .select("id,name,material,variant,sale_price_aud,photos")
    .eq("au_available", true)
    .or(`name.ilike.%${query}%,material.ilike.%${query}%,variant.ilike.%${query}%`)
    .limit(5);

  if (!skus || skus.length === 0) {
    await tgSend(chatId, `No AU items matched "${query}". Try a different name, or check spelling.`);
    return;
  }

  for (const s of skus) {
    const { data: units } = await supabase
      .from("inventory_units").select("id").eq("sku_id", s.id).eq("status", "available");
    const avail = units?.length ?? 0;
    const caption = `*${s.name}*${s.variant ? " — " + s.variant : ""}\n${s.material ?? ""}\n${fmtAud(s.sale_price_aud)} · ${avail} available`;
    const photo = (s.photos && s.photos[0]) || null;
    const keyboard = { inline_keyboard: [[{ text: avail > 0 ? "➕ Add to sale" : "❌ Out of stock", callback_data: avail > 0 ? `kiosk:pick:${s.id}` : "kiosk:noop" }]] };
    if (photo) await tgSendPhoto(chatId, photo, caption, keyboard);
    else await tgSend(chatId, caption, keyboard);
  }
}

async function kioskAddToCart(supabase: any, chatId: number, data: any, skuId: string) {
  const { data: sku } = await supabase.from("inventory_skus").select("*").eq("id", skuId).single();
  const { data: units } = await supabase
    .from("inventory_units").select("id").eq("sku_id", skuId).eq("status", "available").limit(20);

  const cart = data.cart ?? [];
  await saveSession(supabase, chatId, "kiosk_qty", { ...data, cart, pending_sku: sku, pending_units: units });
  const maxQty = units?.length ?? 0;
  await tgSend(chatId, `How many *${sku.name}*? (up to ${maxQty} available)`, {
    inline_keyboard: [
      [1, 2, 3].filter((n) => n <= maxQty).map((n) => ({ text: String(n), callback_data: `kiosk:qty:${n}` })),
    ].filter((row) => row.length > 0),
  });
}

async function kioskConfirmQty(supabase: any, chatId: number, data: any, qty: number) {
  const units = data.pending_units ?? [];
  if (qty > units.length) {
    await tgSend(chatId, `Only ${units.length} available — try a smaller number.`);
    return;
  }
  // Reserve immediately so a second staff member using this bot concurrently
  // can't also sell the same physical piece mid-checkout.
  const chosen = units.slice(0, qty);
  for (const u of chosen) await supabase.rpc("reserve_unit", { p_unit_id: u.id, p_minutes: 15 });

  const cart = [...(data.cart ?? []), { sku: data.pending_sku, unit_ids: chosen.map((u: any) => u.id), qty }];
  const total = cart.reduce((sum: number, item: any) => sum + item.sku.sale_price_aud * item.qty, 0);
  const lines = cart.map((item: any) => `• ${item.sku.name} ×${item.qty} — ${fmtAud(item.sku.sale_price_aud * item.qty)}`);

  await saveSession(supabase, chatId, "kiosk_cart", { cart });
  await tgSend(chatId, `*Cart*\n${lines.join("\n")}\n\nTotal: ${fmtAud(total)}`, {
    inline_keyboard: [
      [{ text: "➕ Add another item", callback_data: "kiosk:search_again" }],
      [{ text: "✅ Checkout", callback_data: "kiosk:checkout" }],
      [{ text: "❌ Cancel sale", callback_data: "kiosk:cancel" }],
    ],
  });
}

async function kioskCancelSale(supabase: any, chatId: number, data: any) {
  // Release any reserved units back to available — don't leave them locked.
  for (const item of data.cart ?? []) {
    for (const unitId of item.unit_ids) {
      await supabase.from("inventory_units").update({ status: "available", reserved_until: null }).eq("id", unitId).eq("status", "reserved");
    }
  }
  await saveSession(supabase, chatId, "idle", {});
  await tgSend(chatId, "Sale cancelled, items released back to stock.");
  await showTopMenu(chatId);
}

async function kioskFinalize(supabase: any, chatId: number, data: any) {
  const cart = data.cart ?? [];
  // Re-verify every unit is still reserved by us (not expired/claimed elsewhere)
  // before committing — the whole point of the reservation step.
  for (const item of cart) {
    for (const unitId of item.unit_ids) {
      const { data: u } = await supabase.from("inventory_units").select("status").eq("id", unitId).single();
      if (u?.status !== "reserved") {
        await tgSend(chatId, `⚠️ One item became unavailable during checkout. Please restart this sale.`);
        await saveSession(supabase, chatId, "idle", {});
        await showTopMenu(chatId);
        return;
      }
    }
  }

  // sub/discount are NOT real columns on `sales` (verified against the live
  // schema) — only total/paid/balance exist, so a coupon discount is baked
  // straight into `total` before it's written.
  const total = effectiveTotal(data);

  const { data: invRow } = await supabase.from("settings").select("value").eq("key", "inv_counter").single();
  const invNum = (parseInt(invRow?.value ?? "1000", 10) || 1000) + 1;
  await supabase.from("settings").update({ value: String(invNum) }).eq("key", "inv_counter");

  const items = cart.map((item: any) => ({
    name: item.sku.name, qty: item.qty, amount: item.sku.sale_price_aud * item.qty,
  }));

  const { data: sale } = await supabase.from("sales").insert({
    inv: `MSH-AU-${invNum}`, date: new Date().toISOString().slice(0, 10),
    customer: { name: data.customer_name, wa: data.customer_wa },
    items, total, paid: data.amount_paid ?? total,
    balance: total - (data.amount_paid ?? total),
    pay_mode: data.payment_mode, delivery_mode: "offline", shipping_status: "na",
    taxes: [], // kiosk/storefront sales are never taxed — only admin.html's manual entry has a tax toggle
    created_by: "telegram_bot_au", source: "telegram_au",
  }).select().single();

  for (const item of cart) {
    for (const unitId of item.unit_ids) await supabase.rpc("claim_unit", { p_unit_id: unitId, p_sale_id: sale.id });
  }

  if (data.coupon_code) await supabase.rpc("consume_coupon", { p_code: data.coupon_code, p_wa: data.customer_wa });

  // Best-effort PDF generation — awaited so the WhatsApp draft below can
  // include the link, but never lets a PDF failure block the sale itself.
  let pdfUrl: string | null = null;
  try {
    const pdfRes = await fetch(`${SB_URL}/functions/v1/generate-invoice-pdf`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${SB_SERVICE_KEY}` },
      body: JSON.stringify({ sale_id: sale.id }),
    });
    const pdfJson = await pdfRes.json();
    if (pdfJson?.ok) pdfUrl = pdfJson.url ?? null;
  } catch { /* best-effort, never blocks the sale */ }

  const waDigits = (data.customer_wa ?? "").replace(/\D/g, "");
  // Links to the real branded invoice (invoice.html, public/unauthenticated
  // — not admin.html, which requires staff login) instead of re-typing the
  // order as plain WhatsApp text.
  const invoiceUrl = `https://meensha.in/invoice.html?invoice=${encodeURIComponent(sale.inv)}&wa=${waDigits}`;
  const waMsg = encodeURIComponent(`Hi ${data.customer_name}! Thank you for your Meensha order. Your invoice (${sale.inv}) is here: ${invoiceUrl}` + (pdfUrl ? `\n\nPDF: ${pdfUrl}` : ""));
  await saveSession(supabase, chatId, "idle", {});
  await tgSend(chatId, `✅ Sale complete — ${sale.inv}\nTotal: ${fmtAud(total)}\n\n[Tap to send invoice to customer](https://wa.me/${waDigits}?text=${waMsg})\n\n🧾 View/print invoice yourself: ${invoiceUrl}`, {
    inline_keyboard: [[{ text: "🆕 Start new sale", callback_data: "kiosk:start" }]],
  });
  await logActivity(supabase, "au", chatId, "sale", data.payment_mode, total);
}

// ── Stock Intake (draft-only) ───────────────────────────────────────────────

async function intakeSearchExisting(supabase: any, chatId: number, name: string) {
  const { data: matches } = await supabase
    .from("inventory_skus").select("id,name,material,variant").eq("au_available", true)
    .ilike("name", `%${name}%`).limit(5);

  const buttons = (matches ?? []).map((m: any) => [{ text: `${m.name} (${m.material ?? "?"})`, callback_data: `intake:match:${m.id}` }]);
  buttons.push([{ text: "➕ This is a new item", callback_data: "intake:new" }]);
  await tgSend(chatId, matches?.length ? "Found similar existing items — is this one of these?" : "No similar item found.", { inline_keyboard: buttons });
}

// ── Reports (AU-scoped only) ─────────────────────────────────────────────────

async function reportToday(supabase: any, chatId: number) {
  const today = new Date().toISOString().slice(0, 10);
  const { data: sales } = await supabase.from("sales").select("total").eq("date", today).eq("source", "telegram_au");
  const total = (sales ?? []).reduce((s: number, r: any) => s + Number(r.total), 0);
  await tgSend(chatId, `*Today's AU Sales*\n${fmtAud(total)} across ${sales?.length ?? 0} sale(s)`);
}

async function reportStock(supabase: any, chatId: number) {
  const { data: skus } = await supabase.from("inventory_skus").select("id,name").eq("au_available", true);
  const { data: units } = await supabase.from("inventory_units").select("sku_id,status");
  let inStock = 0, lowStock = 0, outOfStock = 0;
  const LOW_STOCK_THRESHOLD = 2; // no configurable field exists yet — see plan doc note
  for (const s of skus ?? []) {
    const avail = (units ?? []).filter((u: any) => u.sku_id === s.id && u.status === "available").length;
    if (avail === 0) outOfStock++;
    else if (avail <= LOW_STOCK_THRESHOLD) lowStock++;
    else inStock++;
  }
  await tgSend(chatId, `*AU Stock Summary*\nProducts: ${skus?.length ?? 0}\nHealthy stock: ${inStock}\nLow stock (≤${LOW_STOCK_THRESHOLD}): ${lowStock}\nOut of stock: ${outOfStock}`);
}

// ── Text input router (for whatever step is mid-flow) ───────────────────────

async function handleTextInput(supabase: any, chatId: number, state: string, data: any, text: string) {
  if (!text) return;
  if (state.startsWith("voucher_")) return handleVoucherText(supabase, chatId, state, data, text);
  if (state.startsWith("eventform_")) return handleEventformText(supabase, chatId, state, data, text);
  switch (state) {
    case "kiosk_search":
      await kioskSearch(supabase, chatId, text);
      break;
    case "kiosk_customer_name":
      await saveSession(supabase, chatId, "kiosk_customer_wa", { ...data, customer_name: text });
      await tgSend(chatId, "Customer WhatsApp number?");
      break;
    case "kiosk_customer_wa":
      await saveSession(supabase, chatId, "kiosk_coupon_code", { ...data, customer_wa: text });
      await tgSend(chatId, "Coupon code? Type a code, or 'skip' if none.");
      break;
    case "kiosk_coupon_code": {
      const code = text.trim();
      if (code.toLowerCase() === "skip") {
        await saveSession(supabase, chatId, "kiosk_amount", data);
        await tgSend(chatId, `Amount received? (leave blank for full amount — total is ${fmtAud(effectiveTotal(data))})`);
        break;
      }
      const { data: res } = await supabase.rpc("validate_coupon", {
        p_code: code.toUpperCase(),
        p_wa: data.customer_wa,
        p_region: "australia",
      });
      if (!res?.valid) {
        await tgSend(chatId, `${res?.message || "Invalid coupon"} — type another code, or 'skip'.`);
        break;
      }
      const base = couponDiscountBase(data.cart ?? [], res.category_filter || null);
      if (res.category_filter && base === 0) {
        await tgSend(chatId, `${res.code} requires a matching item (${res.category_filter}) in the cart — type another code, or 'skip'.`);
        break;
      }
      const discount = res.discount_type === "percent"
        ? base * (parseFloat(res.discount_value) / 100)
        : parseFloat(res.discount_value);
      const newData = { ...data, coupon_code: res.code, coupon_discount: Math.min(discount, base) };
      await saveSession(supabase, chatId, "kiosk_amount", newData);
      await tgSend(chatId, `✅ ${res.code} applied — new total ${fmtAud(effectiveTotal(newData))}\n\nAmount received? (leave blank for full amount)`);
      break;
    }
    case "kiosk_amount": {
      const amt = text.trim() ? parseFloat(text) : undefined;
      await saveSession(supabase, chatId, "kiosk_payment_mode", { ...data, amount_paid: amt });
      await tgSend(chatId, "Payment mode?", { inline_keyboard: [[
        { text: "💵 Cash", callback_data: "kiosk:mode:Cash" },
        { text: "📱 Card", callback_data: "kiosk:mode:Card" },
        { text: "🔁 Other", callback_data: "kiosk:mode:other" },
      ]] });
      break;
    }
    case "kiosk_payment_mode_other": {
      const mode = text.trim();
      if (!mode) { await tgSend(chatId, "How was it paid? (e.g. Bank Transfer, PayID)"); break; }
      await showKioskConfirm(supabase, chatId, { ...data, payment_mode: mode });
      break;
    }
    case "intake_search":
      await intakeSearchExisting(supabase, chatId, text);
      break;
    case "intake_new_name":
      await saveSession(supabase, chatId, "intake_material", { ...data, proposed_name: text });
      await tgSend(chatId, "Material?");
      break;
    case "intake_material":
      await saveSession(supabase, chatId, "intake_variant", { ...data, proposed_material: text });
      await tgSend(chatId, "Variant/colour?");
      break;
    case "intake_variant":
      await saveSession(supabase, chatId, "intake_qty", { ...data, proposed_variant: text });
      await tgSend(chatId, "Quantity?");
      break;
    case "intake_qty":
      await saveSession(supabase, chatId, "intake_purchase_price", { ...data, qty: parseInt(text, 10) || 1 });
      await tgSend(chatId, "Purchase price in INR? (This is the sourcing cost, not the AUD sale price — sourcing is always in India regardless of market. Type 'skip' if you don't know it yet.)");
      break;
    case "intake_purchase_price": {
      if (text.toLowerCase() === "skip") {
        await saveSession(supabase, chatId, "intake_sale_price", { ...data, purchase_price: null });
        await tgSend(chatId, "Proposed sale price (A$)? Type 'skip' to leave blank.");
        break;
      }
      const price = parseFloat(text);
      if (isNaN(price) || price < 0) {
        await tgSend(chatId, "Enter a valid number (e.g. 1200), or type 'skip' if you don't know it yet.");
        break;
      }
      await saveSession(supabase, chatId, "intake_sale_price", { ...data, purchase_price: price });
      await tgSend(chatId, "Proposed sale price (A$)? Type 'skip' to leave blank.");
      break;
    }
    case "intake_sale_price": {
      if (text.toLowerCase() === "skip") {
        await saveSession(supabase, chatId, "intake_notes", { ...data, proposed_sale_price: null });
        await tgSend(chatId, "Any notes? Type 'skip' if none.");
        break;
      }
      const price = parseFloat(text);
      if (isNaN(price) || price < 0) {
        await tgSend(chatId, "Enter a valid number, or type 'skip' if you don't know it yet.");
        break;
      }
      await saveSession(supabase, chatId, "intake_notes", { ...data, proposed_sale_price: price });
      await tgSend(chatId, "Any notes? Type 'skip' if none.");
      break;
    }
    case "intake_notes": {
      const notes = text.toLowerCase() === "skip" ? null : text;
      await saveSession(supabase, chatId, "intake_photos", { ...data, notes, photos: [] });
      await tgSend(chatId, "Send 1-2 photos of ONLY this item (nothing else in frame), then type 'done'.");
      break;
    }
    case "intake_photos":
      if (text.toLowerCase() === "done") {
        if (!(data.photos ?? []).length) {
          await tgSend(chatId, "At least one photo is required before submitting.");
          return;
        }
        await submitDraft(supabase, chatId, data);
      }
      break;
    default:
      try {
        const answer = await askGemini(supabase, text, LOOKUP_CATALOG_REGIONAL, (sb, name, params) =>
          runLookup(sb, name, { ...params, region: "australia" }));
        await tgSend(chatId, answer);
      } catch {
        await tgSend(chatId, "Not sure what to do with that — try /start.");
      }
  }
}

async function submitDraft(supabase: any, chatId: number, data: any) {
  const { data: draft } = await supabase.rpc("submit_stock_intake_draft", {
    p_region: "australia",
    p_sku_id: data.matched_sku_id ?? null,
    p_proposed_name: data.proposed_name ?? null,
    p_proposed_material: data.proposed_material ?? null,
    p_proposed_variant: data.proposed_variant ?? null,
    p_purchase_price: data.purchase_price ?? null,
    p_proposed_sale_price: data.proposed_sale_price ?? null,
    p_notes: data.notes ?? null,
    p_photo_urls: data.photos ?? [], // supabase-js serializes jsonb params itself — don't pre-stringify
    p_qty: data.qty ?? 1,
    p_submitted_by: `chat_id:${chatId}`,
  });
  await saveSession(supabase, chatId, "idle", {});
  await tgSend(chatId, `✅ Draft submitted for approval (${data.proposed_name ?? "matched item"}).\nAdmin will review on the web dashboard.`, {
    inline_keyboard: [[{ text: "🆕 Start new", callback_data: "intake:start" }]],
  });
  await logActivity(supabase, "au", chatId, "stock_intake", data.proposed_name ?? "matched item");
}

async function handlePhoto(supabase: any, chatId: number, state: string, data: any, photoSizes: any[]) {
  if (state !== "intake_photos" || !photoSizes?.length) return;
  const largest = photoSizes[photoSizes.length - 1];
  const fileInfo = await fetch(`${TG_API}/getFile?file_id=${largest.file_id}`).then((r) => r.json());
  const filePath = fileInfo?.result?.file_path;
  if (!filePath) return;
  const fileBytes = await fetch(`https://api.telegram.org/file/bot${BOT_TOKEN}/${filePath}`).then((r) => r.arrayBuffer());
  const objectName = `${Date.now()}-telegram-au.jpg`;
  await fetch(`${SB_URL}/storage/v1/object/item-photos/${objectName}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${SB_SERVICE_KEY}`, "Content-Type": "image/jpeg" },
    body: fileBytes,
  });
  const publicUrl = `${SB_URL}/storage/v1/object/public/item-photos/${objectName}`;
  const photos = [...(data.photos ?? []), publicUrl];
  await saveSession(supabase, chatId, "intake_photos", { ...data, photos });
  await tgSend(chatId, `Photo ${photos.length} received. Send another, or type 'done'.`);
}

// ── Main entry ───────────────────────────────────────────────────────────────

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });

  const secret = req.headers.get("X-Telegram-Bot-Api-Secret-Token");
  if (secret !== Deno.env.get("TELEGRAM_WEBHOOK_SECRET_AU")) {
    return new Response("Forbidden", { status: 403 });
  }

  const supabase = createClient(SB_URL, SB_SERVICE_KEY);
  const update = await req.json();
  const msg = update.message ?? update.callback_query?.message;
  const chatId = msg?.chat?.id;
  if (!chatId) return new Response("ok", { status: 200 });

  const { data: allowed } = await supabase
    .from("telegram_allowed_users_au").select("*").eq("chat_id", String(chatId)).eq("active", true).maybeSingle();
  if (!allowed) {
    // Self-service allowlist: the first 3 distinct chats to message this bot
    // get auto-approved, no admin step needed — every sale they make is
    // already logged to bot_activity_log regardless (see logActivity calls
    // below), rolled into a MeenshaMonitor session summary, so there's a
    // visible backup trail even without manual vetting. Lowered from 4 to 3
    // (1 existing user + 2 new seats for this rollout). Past 3 active
    // users, new chats still need admin approval as before.
    const { count } = await supabase
      .from("telegram_allowed_users_au").select("chat_id", { count: "exact", head: true }).eq("active", true);
    if ((count ?? 0) < 3) {
      const from = update.message?.from ?? update.callback_query?.from;
      const label = [from?.first_name, from?.last_name].filter(Boolean).join(" ") || from?.username || `Chat ${chatId}`;
      await supabase.from("telegram_allowed_users_au").insert({ chat_id: String(chatId), label, active: true });
      await tgSend(chatId, `✅ You're approved to use this bot (${label}).`);
    } else {
      await tgSend(chatId, `Not authorized yet. Ask admin to approve chat_id: ${chatId}`);
      return new Response("ok", { status: 200 });
    }
  }

  const { data: session } = await supabase.from("telegram_sessions_au").select("*").eq("chat_id", chatId).maybeSingle();
  const state = session?.state ?? "idle";
  const data = session?.data ?? {};

  const text = update.message?.text;
  const callbackData = update.callback_query?.data;
  const photo = update.message?.photo;

  await logMessage(chatId, "in", text ?? callbackData ?? (photo?.length ? "[photo]" : "[unrecognized]"));

  if (text === "/start") {
    await showTopMenu(chatId);
    await saveSession(supabase, chatId, "idle", {});
  } else if (state === "idle" && !callbackData && text !== undefined && !photo) {
    // Idle + free text that isn't /start: treat as a natural-language
    // question (stock/price/sales lookups, AU-scoped only) instead of
    // just dumping them back to the menu.
    try {
      const answer = await askGemini(supabase, text, LOOKUP_CATALOG_REGIONAL, (sb, name, params) =>
        runLookup(sb, name, { ...params, region: "australia" }));
      await tgSend(chatId, answer);
    } catch {
      await showTopMenu(chatId);
      await saveSession(supabase, chatId, "idle", {});
    }
  } else if (callbackData === "kiosk:start") {
    await saveSession(supabase, chatId, "kiosk_search", { cart: [] });
    await tgSend(chatId, "Type a product name to search AU stock:");
  } else if (callbackData?.startsWith("kiosk:pick:")) {
    await kioskAddToCart(supabase, chatId, data, callbackData.split(":")[2]);
  } else if (callbackData?.startsWith("kiosk:qty:")) {
    await kioskConfirmQty(supabase, chatId, data, parseInt(callbackData.split(":")[2], 10));
  } else if (callbackData === "kiosk:search_again") {
    await saveSession(supabase, chatId, "kiosk_search", data);
    await tgSend(chatId, "Type another product name to search:");
  } else if (callbackData === "kiosk:checkout") {
    await saveSession(supabase, chatId, "kiosk_customer_name", data);
    await tgSend(chatId, "Customer name?");
  } else if (callbackData === "kiosk:cancel") {
    await kioskCancelSale(supabase, chatId, data);
  } else if (callbackData === "kiosk:mode:other") {
    await saveSession(supabase, chatId, "kiosk_payment_mode_other", data);
    await tgSend(chatId, "How was it paid? (e.g. Bank Transfer, PayID)");
  } else if (callbackData?.startsWith("kiosk:mode:")) {
    const mode = callbackData.split(":")[2];
    await showKioskConfirm(supabase, chatId, { ...data, payment_mode: mode });
  } else if (callbackData === "kiosk:confirm") {
    await kioskFinalize(supabase, chatId, data);
  } else if (callbackData === "intake:start") {
    await saveSession(supabase, chatId, "intake_search", {});
    await tgSend(chatId, "Type the item name to check for an existing match:");
  } else if (callbackData?.startsWith("intake:match:")) {
    await saveSession(supabase, chatId, "intake_qty", { ...data, matched_sku_id: callbackData.split(":")[2] });
    await tgSend(chatId, "Quantity?");
  } else if (callbackData === "intake:new") {
    await saveSession(supabase, chatId, "intake_new_name", data);
    await tgSend(chatId, "New item name?");
  } else if (callbackData === "reports:start") {
    await tgSend(chatId, "Reports:", { inline_keyboard: [
      [{ text: "Today's Sales", callback_data: "reports:today" }],
      [{ text: "Stock Summary", callback_data: "reports:stock" }],
      [{ text: "🧾 Sales History", callback_data: "hist:start" }],
    ] });
  } else if (callbackData === "reports:today") {
    await reportToday(supabase, chatId);
  } else if (callbackData === "reports:stock") {
    await reportStock(supabase, chatId);
  } else if (callbackData?.startsWith("hist:")) {
    await handleSalesHistory(supabase, chatId, data, callbackData);
  } else if (callbackData?.startsWith("inv:")) {
    await handleInventoryAu(supabase, chatId, state, data, callbackData);
  } else if (callbackData?.startsWith("godown:")) {
    await handleGodown(supabase, chatId, state, data, callbackData);
  } else if (callbackData?.startsWith("maint:")) {
    await handleMaintenanceAu(supabase, chatId, callbackData, data);
  } else if (callbackData === "vouchers:menu") {
    await showVouchersMenu(chatId);
  } else if (callbackData === "vouchers:back") {
    await showTopMenu(chatId);
    await saveSession(supabase, chatId, "idle", {});
  } else if (callbackData === "vouchers:create") {
    await saveSession(supabase, chatId, "voucher_code", {});
    await tgSend(chatId, "Voucher code? (e.g. SYDNEY10)");
  } else if (callbackData === "vouchers:eventform") {
    await saveSession(supabase, chatId, "eventform_title", {});
    await tgSend(chatId, "Event title? (e.g. Sydney Pop-Up)");
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
    await handleInventoryPhotoAu(supabase, chatId, data, photo);
  } else if (text && state.startsWith("godown_")) {
    await handleGodownText(supabase, chatId, state, data, text);
  } else if (text && state.startsWith("inv_")) {
    await handleInventoryTextAu(supabase, chatId, state, data, text);
  } else if (text && state === "maint_note_text") {
    await handleMaintenanceTextAu(supabase, chatId, text);
  } else if (photo) {
    await handlePhoto(supabase, chatId, state, data, photo);
  } else {
    await handleTextInput(supabase, chatId, state, data, text);
  }

  if (update.callback_query) {
    await fetch(`${TG_API}/answerCallbackQuery`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ callback_query_id: update.callback_query.id }),
    });
  }

  return new Response("ok", { status: 200 });
});

// ── Sales History (ported from telegram-bot/index.ts, AU-scoped) ───────────
const HIST_PAGE_SIZE_AU = 5;

async function handleSalesHistory(supabase: any, chatId: number, data: any, callbackData: string) {
  if (callbackData === "hist:start") {
    data.histOffset = 0;
    await showSalesHistoryPage(supabase, chatId, data);
    await saveSession(supabase, chatId, "hist_list", data);
    return;
  }
  if (callbackData.startsWith("hist:page:")) {
    data.histOffset = parseInt(callbackData.split(":")[2], 10);
    await showSalesHistoryPage(supabase, chatId, data);
    await saveSession(supabase, chatId, "hist_list", data);
    return;
  }
  if (callbackData.startsWith("hist:view:")) {
    await showSaleSummary(supabase, chatId, callbackData.split(":")[2]);
    return;
  }
  if (callbackData.startsWith("hist:invoice:")) {
    await sendHistoryInvoiceLink(supabase, chatId, callbackData.split(":")[2]);
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

async function showSalesHistoryPage(supabase: any, chatId: number, data: any) {
  const offset = data.histOffset ?? 0;
  const { data: rows, count } = await supabase
    .from("sales")
    .select("id, inv, date, customer, total", { count: "exact" })
    .eq("source", "telegram_au")
    .order("created_at", { ascending: false })
    .range(offset, offset + HIST_PAGE_SIZE_AU - 1);

  if (!rows?.length) {
    await tgSend(chatId, offset === 0 ? "No sales recorded yet." : "No more sales.", {
      inline_keyboard: [[{ text: "✕ Exit", callback_data: "hist:exit" }]],
    });
    return;
  }

  const buttons = rows.map((s: any) => [
    { text: `${s.inv} · ${s.customer?.name ?? "—"} · ${fmtAud(s.total)} · ${s.date}`, callback_data: `hist:view:${s.id}` },
  ]);
  const navRow = [];
  if (offset > 0) navRow.push({ text: "◀ Prev 5", callback_data: `hist:page:${Math.max(0, offset - HIST_PAGE_SIZE_AU)}` });
  if ((count ?? 0) > offset + HIST_PAGE_SIZE_AU) navRow.push({ text: "Next 5 ▶", callback_data: `hist:page:${offset + HIST_PAGE_SIZE_AU}` });
  if (navRow.length) buttons.push(navRow);
  buttons.push([{ text: "✕ Exit", callback_data: "hist:exit" }]);

  await tgSend(chatId, "🧾 Recent sales — tap one for details:", { inline_keyboard: buttons });
}

async function showSaleSummary(supabase: any, chatId: number, saleId: string) {
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
    .map((it: any) => `• ${it.name}${it.variant ? " (" + it.variant + ")" : ""} — ${fmtAud(it.price)}`)
    .join("\n");
  await tgSend(
    chatId,
    `${s.inv} — ${s.date}\nCustomer: ${s.customer?.name ?? "—"} (${s.customer?.wa ?? "—"})\n\n${lines}\n\nTotal: ${fmtAud(s.total)}\nPaid: ${fmtAud(s.paid)}\nBalance: ${fmtAud(s.balance)}\nPayment: ${s.pay_mode ?? "—"}`,
    {
      inline_keyboard: [
        [{ text: "🧾 Send Invoice", callback_data: `hist:invoice:${saleId}` }],
        [{ text: "◀ Back to list", callback_data: "hist:back" }],
      ],
    },
  );
}

async function sendHistoryInvoiceLink(supabase: any, chatId: number, saleId: string) {
  const { data: s } = await supabase.from("sales").select("inv, customer, total, paid, invoice_pdf_path").eq("id", saleId).single();
  if (!s) {
    await tgSend(chatId, "That sale couldn't be found.");
    return;
  }
  let pdfUrl: string | null = null;
  try {
    const pdfRes = await fetch(`${SB_URL}/functions/v1/generate-invoice-pdf`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${SB_SERVICE_KEY}` },
      body: JSON.stringify({ sale_id: saleId }),
    });
    const pdfJson = await pdfRes.json();
    if (pdfJson?.ok) pdfUrl = pdfJson.url ?? null;
  } catch { /* best-effort, never blocks the history lookup */ }
  const waDigits = String(s.customer?.wa ?? "").replace(/\D/g, "");
  const invoiceUrl = `https://meensha.in/invoice.html?invoice=${encodeURIComponent(s.inv)}&wa=${waDigits}`;
  const waMsg = encodeURIComponent(
    `Hi ${s.customer?.name ?? ""}! Here's your Meensha invoice ${s.inv}: ${invoiceUrl}` + (pdfUrl ? `\n\nPDF: ${pdfUrl}` : ""),
  );
  const waLink = waDigits ? `https://wa.me/${waDigits}?text=${waMsg}` : null;
  await tgSend(
    chatId,
    `🧾 View/print invoice yourself: ${invoiceUrl}` + (waLink ? `\n\nTap to send to customer: ${waLink}` : ""),
    { inline_keyboard: [[{ text: "◀ Back to list", callback_data: "hist:back" }]] },
  );
}

// ── Godown check (ported from telegram-bot/index.ts, AU-scoped) ────────────
const GODOWN_EXIT_ROW_AU = [{ text: "✕ Exit", callback_data: "godown:exit" }];

async function handleGodown(supabase: any, chatId: number, state: string, data: any, callbackData: string) {
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
        GODOWN_EXIT_ROW_AU,
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
    await tgSend(chatId, "Type an item name to search:", { inline_keyboard: [GODOWN_EXIT_ROW_AU] });
    await saveSession(supabase, chatId, "godown_spot_search", data);
    return;
  }

  if (callbackData.startsWith("godown:spotpick:")) {
    const skuId = callbackData.split(":")[2];
    const { data: sku } = await supabase.from("inventory_skus").select("id, name").eq("id", skuId).single();
    const { data: units } = await supabase.from("inventory_units").select("id").eq("sku_id", skuId).eq("status", "available");
    data.spotItem = { sku_id: sku.id, name: sku.name, avail: (units ?? []).length };
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
        GODOWN_EXIT_ROW_AU,
      ],
    });
    await saveSession(supabase, chatId, "godown_discrepancy_type", data);
    return;
  }

  if (state === "godown_discrepancy_type" && callbackData.startsWith("godown:disc:")) {
    const typeMap: Record<string, string> = { missing: "shortage", damage: "damage", extra: "other" };
    data.discType = typeMap[callbackData.split(":")[2]] ?? "other";
    data.selectedUnitIds = [];
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
    inline_keyboard: [[{ text: "⏭ Skip", callback_data: "godown:disc:skip" }], GODOWN_EXIT_ROW_AU],
  });
}

async function showGodownUnitPicker(supabase: any, chatId: number, data: any) {
  const item = data.discItem;
  const { data: units } = await supabase.from("inventory_units").select("id, unit_code").eq("sku_id", item.sku_id).eq("status", "available");
  const selected: string[] = data.selectedUnitIds ?? [];
  const buttons = (units ?? []).map((u: any) => [{
    text: `${selected.includes(u.id) ? "✅ " : ""}${u.unit_code}`,
    callback_data: `godown:unitpick:${u.id}`,
  }]);
  buttons.push([{ text: `➡️ Done (${selected.length} selected)`, callback_data: "godown:unitpick:done" }]);
  buttons.push(GODOWN_EXIT_ROW_AU);
  await tgSend(chatId, `Which piece(s) of "${item.name}" is this about? (optional — tap Done to skip)`, { inline_keyboard: buttons });
  await saveSession(supabase, chatId, "godown_unit_pick", data);
}

async function handleGodownPhoto(supabase: any, chatId: number, data: any, photoSizes: any[]) {
  const largest = photoSizes[photoSizes.length - 1];
  const result = await uploadTelegramPhotoGodown(largest.file_id);
  if ("error" in result) {
    await tgSend(chatId, `Couldn't save that photo — ${result.error}`);
    return;
  }
  data.discPhotoUrl = result.url;
  await tgSend(chatId, "📷 Photo attached. Add a text note too, or tap Done to save.", {
    inline_keyboard: [[{ text: "✅ Done", callback_data: "godown:disc:notedone" }], GODOWN_EXIT_ROW_AU],
  });
  await saveSession(supabase, chatId, "godown_discrepancy_note", data);
}

async function uploadTelegramPhotoGodown(fileId: string, bucket = "item-photos", objectName = `${Date.now()}-inventory-telegram-au.jpg`): Promise<{ url: string } | { error: string }> {
  const fileRes = await fetch(`${TG_API}/getFile?file_id=${fileId}`);
  const fileJson = await fileRes.json();
  const filePath = fileJson?.result?.file_path;
  if (!filePath) return { error: `Telegram getFile failed: ${JSON.stringify(fileJson).slice(0, 200)}` };
  const imgRes = await fetch(`https://api.telegram.org/file/bot${BOT_TOKEN}/${filePath}`);
  if (!imgRes.ok) return { error: `Telegram file download failed: ${imgRes.status}` };
  const imgBuf = await imgRes.arrayBuffer();
  const uploadRes = await fetch(`${SB_URL}/storage/v1/object/${bucket}/${objectName}`, {
    method: "POST",
    headers: { apikey: SB_SERVICE_KEY, Authorization: `Bearer ${SB_SERVICE_KEY}`, "Content-Type": "image/jpeg", "x-upsert": "true" },
    body: imgBuf,
  });
  if (!uploadRes.ok) {
    const body = await uploadRes.text();
    return { error: `Storage upload failed: ${uploadRes.status} ${body.slice(0, 200)}` };
  }
  return { url: `${SB_URL}/storage/v1/object/public/${bucket}/${objectName}` };
}

async function finalizeGodownDiscrepancy(supabase: any, chatId: number, data: any, note: string) {
  const item = data.discItem;
  const selectedUnitIds: string[] = data.selectedUnitIds ?? [];

  const { data: unitRow } = await supabase.from("inventory_units").select("vendor_code").eq("sku_id", item.sku_id).order("created_at", { ascending: false }).limit(1).maybeSingle();
  const vendorCode: string | null = unitRow?.vendor_code ?? null;
  let vendorUuid: string | null = null;
  if (vendorCode) {
    const { data: vRow } = await supabase.from("vendors").select("id").eq("vendor_id", vendorCode).maybeSingle();
    vendorUuid = vRow?.id ?? null;
  }

  const cleanNote = note.trim();
  const photoLine = data.discPhotoUrl ? `\nPhoto: ${data.discPhotoUrl}` : "";
  const source = data.discFromState === "godown_eod_item" ? "EOD reconciliation" : "spot check";
  const description = `${cleanNote || "(no note)"}${photoLine} — found during ${source} via Telegram bot (AU)`;

  if (vendorUuid) {
    await supabase.from("vendor_issues").insert({
      vendor_uuid: vendorUuid, vendor_code: vendorCode, sku_id: item.sku_id, batch: null,
      unit_ids: selectedUnitIds, issue_date: new Date().toISOString().slice(0, 10),
      issue_type: data.discType ?? "other", description, status: "open", created_by: "telegram_bot_au",
    });
    const pieceNote = selectedUnitIds.length ? ` (${selectedUnitIds.length} piece${selectedUnitIds.length > 1 ? "s" : ""})` : "";
    await tgSend(chatId, `⚠️ Logged: ${item.name}${pieceNote} — added to Vendor Issues for follow-up.`);
  } else {
    await tgSend(chatId, `⚠️ Couldn't resolve a vendor for ${item.name} — please log this one manually in admin.html's Vendor Issues.`);
  }

  if (data.discType === "damage" && selectedUnitIds.length) {
    await supabase.from("inventory_units").update({ status: "damaged", updated_at: new Date().toISOString() }).in("id", selectedUnitIds);
  }

  data.discPhotoUrl = undefined;
  data.selectedUnitIds = undefined;
  await advanceGodown(supabase, chatId, data.discFromState, data);
}

async function handleGodownText(supabase: any, chatId: number, state: string, data: any, text: string) {
  if (state === "godown_spot_search") {
    const q = text.trim();
    const { data: skus } = await supabase.from("inventory_skus").select("id, name").eq("au_available", true).ilike("name", `%${q}%`);
    if (!skus?.length) {
      await tgSend(chatId, "No AU items matched that name — try again, or Exit.", { inline_keyboard: [GODOWN_EXIT_ROW_AU] });
      return;
    }
    const { data: units } = await supabase.from("inventory_units").select("sku_id").eq("status", "available");
    const availCount: Record<string, number> = {};
    (units ?? []).forEach((u: any) => { availCount[u.sku_id] = (availCount[u.sku_id] ?? 0) + 1; });
    const buttons = skus.map((s: any) => [{ text: `${s.name} (${availCount[s.id] ?? 0} in stock)`, callback_data: `godown:spotpick:${s.id}` }]);
    buttons.push(GODOWN_EXIT_ROW_AU);
    await tgSend(chatId, "Matching items:", { inline_keyboard: buttons });
    return;
  }

  if (state === "godown_discrepancy_note") {
    await finalizeGodownDiscrepancy(supabase, chatId, data, text.trim());
    return;
  }
}

async function startGodownEod(supabase: any, chatId: number, data: any) {
  const today = new Date().toISOString().slice(0, 10);
  const { data: todaySales } = await supabase.from("sales").select("items").eq("date", today).eq("source", "telegram_au");

  const nameCounts: Record<string, number> = {};
  (todaySales ?? []).forEach((s: any) => {
    (s.items ?? []).forEach((it: any) => { nameCounts[it.name] = (nameCounts[it.name] ?? 0) + 1; });
  });
  const soldNames = Object.keys(nameCounts);
  if (!soldNames.length) {
    await tgSend(chatId, "No AU sales recorded today — nothing to reconcile yet.");
    await showTopMenu(chatId);
    await saveSession(supabase, chatId, "idle", {});
    return;
  }

  const { data: skus } = await supabase.from("inventory_skus").select("id, name").eq("au_available", true).in("name", soldNames);
  const { data: units } = await supabase.from("inventory_units").select("sku_id").eq("status", "available");
  const availCount: Record<string, number> = {};
  (units ?? []).forEach((u: any) => { availCount[u.sku_id] = (availCount[u.sku_id] ?? 0) + 1; });

  data.eodList = (skus ?? []).map((s: any) => ({
    sku_id: s.id, name: s.name, soldToday: nameCounts[s.name] ?? 0, avail: availCount[s.id] ?? 0,
  }));
  data.eodIdx = 0;
  await showGodownItem(supabase, chatId, data, data.eodList[0]);
  await saveSession(supabase, chatId, "godown_eod_item", data);
}

async function showGodownItem(supabase: any, chatId: number, data: any, item: any) {
  const soldLine = item.soldToday !== undefined ? `Sold today: ${item.soldToday}\n` : "";
  await tgSend(chatId, `🇦🇺 ${item.name}\n${soldLine}Expected in stock: ${item.avail}\n\nDoes the physical count match?`, {
    inline_keyboard: [
      [{ text: "✅ Matches", callback_data: "godown:match" }],
      [{ text: "⚠️ Discrepancy", callback_data: "godown:discrepancy" }],
      GODOWN_EXIT_ROW_AU,
    ],
  });
}

async function advanceGodown(supabase: any, chatId: number, fromState: string, data: any) {
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
  await tgSend(chatId, "Type another item name to search, or Exit.", { inline_keyboard: [GODOWN_EXIT_ROW_AU] });
  await saveSession(supabase, chatId, "godown_spot_search", data);
}

// ── Maintenance menu (ported subset — AU-relevant items only; India's
// "Pending AU costs" is India-side reconciliation about AU intake and
// doesn't apply here; UPI QR and Insta-link weren't ported this pass) ──────
async function showMaintenanceMenuAu(chatId: number) {
  await tgSend(chatId, "Maintenance:", {
    inline_keyboard: [
      [{ text: "📝 Add a note", callback_data: "maint:note" }],
      [{ text: "◀ Back to menu", callback_data: "maint:back" }],
    ],
  });
}

async function handleMaintenanceAu(supabase: any, chatId: number, callbackData: string, data: any) {
  if (callbackData === "maint:menu") {
    await showMaintenanceMenuAu(chatId);
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
}

async function handleMaintenanceTextAu(supabase: any, chatId: number, text: string) {
  const note = text.trim();
  if (!note) {
    await tgSend(chatId, "Note can't be empty — type your note:");
    return;
  }
  await supabase.from("bot_notes").insert({ text: note, submitted_by: `chat_id_au:${chatId}` });
  await tgSend(chatId, "📝 Note saved — it'll show on the dashboard.");
  await showMaintenanceMenuAu(chatId);
  await saveSession(supabase, chatId, "idle", {});
}

// ── Enter Inventory (vendor-batch, ported from telegram-bot/index.ts) ──────
// Replaces the old single-item Stock Intake flow above (intake:* — left
// untouched/still reachable) with the same staged vendor-batch flow India
// got: vendor search/create → item entry loop (+ defect flagging, split
// into a good row + defective row) → summary (edit/remove/add) → payment →
// submit_purchase_intake_batch (region "australia") → admin approval on the
// web dashboard, same as India. Nothing here is live inventory until
// approved — admin_approve_purchase_batch (shared RPC) handles both regions.
const INV_EXIT_ROW_AU = [{ text: "✕ Exit", callback_data: "inv:exit" }];

async function handleInventoryAu(supabase: any, chatId: number, state: string, data: any, callbackData: string) {
  if (callbackData === "inv:start") {
    data = { items: [] };
    await tgSend(chatId, "Search vendor by name or WhatsApp number:", {
      inline_keyboard: [[{ text: "➕ New Vendor", callback_data: "inv:newvendor" }], INV_EXIT_ROW_AU],
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
    await tgSend(chatId, "New vendor — Name?", { inline_keyboard: [INV_EXIT_ROW_AU] });
    await saveSession(supabase, chatId, "inv_vendor_new_name", data);
    return;
  }
  if (callbackData.startsWith("inv:vendor:")) {
    const vendorId = callbackData.split(":")[2];
    const { data: v } = await supabase.from("vendors").select("id,name").eq("id", vendorId).single();
    if (!v) { await tgSend(chatId, "That vendor is gone — try search again."); return; }
    data.vendor_uuid = v.id;
    data.vendor_name = v.name;
    await startItemEntryAu(supabase, chatId, data);
    return;
  }
  if (callbackData === "inv:defect:no") { await finishCurrentItemAu(supabase, chatId, data); return; }
  if (callbackData === "inv:defect:yes") {
    await tgSend(chatId, `How many of the ${data.curItem.qty} are defective?`, { inline_keyboard: [INV_EXIT_ROW_AU] });
    await saveSession(supabase, chatId, "inv_item_defect_qty", data);
    return;
  }
  if (callbackData === "inv:additem") { await startItemEntryAu(supabase, chatId, data); return; }
  if (callbackData === "inv:review") { await showInvSummaryAu(supabase, chatId, data); return; }
  if (callbackData.startsWith("inv:removerow:")) {
    data.items.splice(parseInt(callbackData.split(":")[2], 10), 1);
    await showInvSummaryAu(supabase, chatId, data);
    return;
  }
  if (callbackData.startsWith("inv:editrow:")) {
    data.editIdx = parseInt(callbackData.split(":")[2], 10);
    await tgSend(chatId, "Edit which field?", {
      inline_keyboard: [
        [{ text: "Name", callback_data: "inv:editfield:name" }, { text: "Material", callback_data: "inv:editfield:material" }],
        [{ text: "Variant", callback_data: "inv:editfield:variant" }, { text: "Cost", callback_data: "inv:editfield:cost" }],
        [{ text: "Qty", callback_data: "inv:editfield:qty" }, { text: "Sale price", callback_data: "inv:editfield:mrp" }],
        [{ text: "◀ Back to summary", callback_data: "inv:review" }],
        INV_EXIT_ROW_AU,
      ],
    });
    await saveSession(supabase, chatId, "inv_edit_pick_field", data);
    return;
  }
  if (callbackData.startsWith("inv:editfield:")) {
    data.editField = callbackData.split(":")[2];
    await tgSend(chatId, `New value for ${data.editField}?`, { inline_keyboard: [INV_EXIT_ROW_AU] });
    await saveSession(supabase, chatId, "inv_edit_value", data);
    return;
  }
  if (callbackData === "inv:submit") {
    if (!data.items?.length) { await tgSend(chatId, "Add at least one item first."); return; }
    await tgSend(chatId, "Amount paid (₹ — vendor cost is always INR, even for AU purchases)?", { inline_keyboard: [INV_EXIT_ROW_AU] });
    await saveSession(supabase, chatId, "inv_payment_amount", data);
    return;
  }
  if (callbackData.startsWith("inv:paymode:")) {
    data.paymentMode = callbackData.split(":")[2];
    await tgSend(chatId, `Split — Meenakshi's share (₹)? Total paid: ₹${data.paymentAmount}. Type 'skip' for an even 50/50 split.`, { inline_keyboard: [INV_EXIT_ROW_AU] });
    await saveSession(supabase, chatId, "inv_payment_split", data);
    return;
  }
  if (callbackData === "inv:finalsubmit") {
    const items = data.items.map((it: any) => ({
      proposed_name: it.name, proposed_material: it.material, proposed_variant: it.variant,
      proposed_sale_price: it.mrp, purchase_price: it.cost, qty: it.qty, photo_urls: it.photos || [],
      is_defective: !!it.is_defective, defect_qty: it.defect_qty || null, defect_reason: it.defect_reason || null,
    }));
    const payment = { mode: data.paymentMode, amount_paid: data.paymentAmount, split: data.paymentSplit };
    const { error } = await supabase.rpc("submit_purchase_intake_batch", {
      p_vendor_uuid: data.vendor_uuid, p_items: items, p_payment: payment,
      p_submitted_by: `chat_id:${chatId}`, p_region: "australia",
    });
    if (error) { await tgSend(chatId, "Couldn't submit that purchase — try again, or check with admin."); return; }
    const vendorName = data.vendor_name;
    await tgSend(chatId, `✅ Submitted for approval (${items.length} items) — admin will review on the web dashboard before it's live.`);
    await logActivity(supabase, "au", chatId, "stock_intake", `${vendorName}, ${items.length} items`);
    data = { items: [] };
    await tgSend(chatId, "Search vendor by name or WhatsApp number for the next purchase:", {
      inline_keyboard: [[{ text: "➕ New Vendor", callback_data: "inv:newvendor" }], INV_EXIT_ROW_AU],
    });
    await saveSession(supabase, chatId, "inv_vendor_search", data);
    return;
  }
}

async function startItemEntryAu(supabase: any, chatId: number, data: any) {
  data.curItem = {};
  await tgSend(chatId, `Vendor: ${data.vendor_name}\n\nItem name?`, { inline_keyboard: [INV_EXIT_ROW_AU] });
  await saveSession(supabase, chatId, "inv_item_name", data);
}

async function finishCurrentItemAu(supabase: any, chatId: number, data: any) {
  const item = data.curItem;
  if (item.defect_qty && item.defect_qty > 0) {
    const goodQty = item.qty - item.defect_qty;
    if (goodQty > 0) data.items.push({ ...item, qty: goodQty, is_defective: false, defect_qty: null, defect_reason: null });
    data.items.push({ ...item, qty: item.defect_qty, is_defective: true });
  } else {
    data.items.push({ ...item, is_defective: false });
  }
  delete data.curItem;
  await showItemAddedMenuAu(supabase, chatId, data);
}

async function showItemAddedMenuAu(supabase: any, chatId: number, data: any) {
  await tgSend(chatId, "Item added.", {
    inline_keyboard: [
      [{ text: "➕ Add another item", callback_data: "inv:additem" }],
      [{ text: "📋 Review purchase so far", callback_data: "inv:review" }],
      INV_EXIT_ROW_AU,
    ],
  });
  await saveSession(supabase, chatId, "inv_item_added", data);
}

async function showInvSummaryAu(supabase: any, chatId: number, data: any) {
  if (!data.items?.length) {
    await tgSend(chatId, "No items staged yet.", { inline_keyboard: [[{ text: "➕ Add item", callback_data: "inv:additem" }], INV_EXIT_ROW_AU] });
    return;
  }
  const lines = data.items
    .map((it: any, i: number) => `${i + 1}. ${it.name}${it.variant ? ` (${it.variant})` : ""} — ₹${it.cost} x${it.qty}` + (it.is_defective ? ` ⚠️ defective${it.defect_reason ? ": " + it.defect_reason : ""}` : ""))
    .join("\n");
  const buttons = data.items.map((_: any, i: number) => [
    { text: `✏️ Edit #${i + 1}`, callback_data: `inv:editrow:${i}` },
    { text: `🗑️ Remove #${i + 1}`, callback_data: `inv:removerow:${i}` },
  ]);
  buttons.push([{ text: "➕ Add another item", callback_data: "inv:additem" }]);
  buttons.push([{ text: "✅ Confirm & submit purchase", callback_data: "inv:submit" }]);
  buttons.push(INV_EXIT_ROW_AU);
  await tgSend(chatId, `Purchase so far — Vendor: ${data.vendor_name}\n\n${lines}`, { inline_keyboard: buttons });
  await saveSession(supabase, chatId, "inv_summary", data);
}

async function showFinalConfirmAu(supabase: any, chatId: number, data: any) {
  const total = data.items.reduce((a: number, it: any) => a + it.cost * it.qty, 0);
  await tgSend(
    chatId,
    `Submit this purchase to the live system?\n\nVendor: ${data.vendor_name}\nItems: ${data.items.length}\nTotal cost: ₹${total} (vendor cost, always INR)\nPaid: ₹${data.paymentAmount} (${data.paymentMode})\nSplit: Meenakshi ₹${data.paymentSplit.meenakshi} / Shalini ₹${data.paymentSplit.shalini}\n\nThis submits for admin approval — nothing is live inventory until approved.`,
    {
      inline_keyboard: [
        [{ text: "✅ Submit", callback_data: "inv:finalsubmit" }],
        [{ text: "◀ Back to summary", callback_data: "inv:review" }],
        INV_EXIT_ROW_AU,
      ],
    },
  );
  await saveSession(supabase, chatId, "inv_final_confirm", data);
}

async function handleInventoryTextAu(supabase: any, chatId: number, state: string, data: any, text: string) {
  const skip = text.trim().toLowerCase() === "skip";

  if (state === "inv_vendor_search") {
    const q = text.trim();
    const { data: matches } = await supabase.from("vendors").select("id,name,company_name,wa_number").or(`name.ilike.%${q}%,company_name.ilike.%${q}%,wa_number.ilike.%${q}%`).limit(8);
    if (!matches?.length) {
      await tgSend(chatId, `No vendors matched "${q}".`, { inline_keyboard: [[{ text: "➕ New Vendor", callback_data: "inv:newvendor" }], INV_EXIT_ROW_AU] });
      return;
    }
    const buttons = matches.map((v: any) => [{ text: `${v.name}${v.company_name ? " (" + v.company_name + ")" : ""}`, callback_data: `inv:vendor:${v.id}` }]);
    buttons.push([{ text: "➕ New Vendor", callback_data: "inv:newvendor" }]);
    buttons.push(INV_EXIT_ROW_AU);
    await tgSend(chatId, `Matches for "${q}":`, { inline_keyboard: buttons });
    return;
  }
  if (state === "inv_vendor_new_name") {
    if (!text.trim()) { await tgSend(chatId, "Name can't be empty — vendor name?"); return; }
    data.newVendor.name = text.trim();
    await tgSend(chatId, "Company name? Type 'skip' if none.", { inline_keyboard: [INV_EXIT_ROW_AU] });
    await saveSession(supabase, chatId, "inv_vendor_new_company", data);
    return;
  }
  if (state === "inv_vendor_new_company") {
    data.newVendor.company_name = skip ? null : text.trim();
    await tgSend(chatId, "WhatsApp number? Type 'skip' if none.", { inline_keyboard: [INV_EXIT_ROW_AU] });
    await saveSession(supabase, chatId, "inv_vendor_new_wa", data);
    return;
  }
  if (state === "inv_vendor_new_wa") {
    data.newVendor.wa_number = skip ? null : text.trim();
    await tgSend(chatId, "Place? Type 'skip' if none.", { inline_keyboard: [INV_EXIT_ROW_AU] });
    await saveSession(supabase, chatId, "inv_vendor_new_place", data);
    return;
  }
  if (state === "inv_vendor_new_place") {
    data.newVendor.place = skip ? null : text.trim();
    const { data: vid } = await supabase.rpc("next_vendor_id");
    const { data: created, error } = await supabase.from("vendors").insert({
      vendor_id: vid, name: data.newVendor.name, company_name: data.newVendor.company_name,
      wa_number: data.newVendor.wa_number, place: data.newVendor.place, status: "active",
    }).select().single();
    if (error || !created) { await tgSend(chatId, "Couldn't save that vendor — try again."); return; }
    data.vendor_uuid = created.id;
    data.vendor_name = created.name;
    delete data.newVendor;
    await tgSend(chatId, `✅ Vendor added: ${created.name} (${vid})`);
    await startItemEntryAu(supabase, chatId, data);
    return;
  }
  if (state === "inv_item_name") {
    if (!text.trim()) { await tgSend(chatId, "Name can't be empty — item name?"); return; }
    data.curItem.name = text.trim();
    await tgSend(chatId, "Material? Type 'skip' if none.", { inline_keyboard: [INV_EXIT_ROW_AU] });
    await saveSession(supabase, chatId, "inv_item_material", data);
    return;
  }
  if (state === "inv_item_material") {
    data.curItem.material = skip ? null : text.trim();
    await tgSend(chatId, "Variant? Type 'skip' if none.", { inline_keyboard: [INV_EXIT_ROW_AU] });
    await saveSession(supabase, chatId, "inv_item_variant", data);
    return;
  }
  if (state === "inv_item_variant") {
    data.curItem.variant = skip ? null : text.trim();
    await tgSend(chatId, "Cost per piece (₹ — vendor cost is always INR, even for AU purchases)?", { inline_keyboard: [INV_EXIT_ROW_AU] });
    await saveSession(supabase, chatId, "inv_item_cost", data);
    return;
  }
  if (state === "inv_item_cost") {
    const cost = parseFloat(text);
    if (!cost || cost <= 0) { await tgSend(chatId, "Enter a valid cost per piece (₹)?"); return; }
    data.curItem.cost = cost;
    await tgSend(chatId, "Quantity?", { inline_keyboard: [INV_EXIT_ROW_AU] });
    await saveSession(supabase, chatId, "inv_item_qty", data);
    return;
  }
  if (state === "inv_item_qty") {
    const qty = parseInt(text, 10);
    if (!qty || qty <= 0) { await tgSend(chatId, "Enter a valid quantity?"); return; }
    data.curItem.qty = qty;
    const suggestion = await suggestMrpAu(supabase, data.curItem.name, data.curItem.material, data.curItem.variant, data.curItem.cost);
    await tgSend(chatId, `${suggestion ? `Suggested sale price: ${suggestion}\n\n` : ""}Type the sale price to use (A$), or 'skip' to leave blank.`, { inline_keyboard: [INV_EXIT_ROW_AU] });
    await saveSession(supabase, chatId, "inv_item_mrp", data);
    return;
  }
  if (state === "inv_item_mrp") {
    data.curItem.mrp = skip ? null : parseFloat(text) || null;
    data.curItem.photos = [];
    await tgSend(chatId, "Send 1-4 photos of this item, then type 'done'.", { inline_keyboard: [INV_EXIT_ROW_AU] });
    await saveSession(supabase, chatId, "inv_item_photos", data);
    return;
  }
  if (state === "inv_item_photos") {
    if (text.trim().toLowerCase() === "done") {
      if (!data.curItem.photos?.length) { await tgSend(chatId, "At least one photo is required — send a photo, then type 'done'."); return; }
      await tgSend(chatId, "Any defective pieces in this batch — flag for return to vendor now?", {
        inline_keyboard: [[{ text: "⚠️ Yes", callback_data: "inv:defect:yes" }, { text: "No", callback_data: "inv:defect:no" }], INV_EXIT_ROW_AU],
      });
      await saveSession(supabase, chatId, "inv_item_defect_check", data);
    }
    return;
  }
  if (state === "inv_item_defect_qty") {
    const q = parseInt(text, 10);
    if (!q || q <= 0 || q > data.curItem.qty) { await tgSend(chatId, `Enter a valid defective quantity (1-${data.curItem.qty})?`); return; }
    data.curItem.defect_qty = q;
    await tgSend(chatId, "Reason?", { inline_keyboard: [INV_EXIT_ROW_AU] });
    await saveSession(supabase, chatId, "inv_item_defect_reason", data);
    return;
  }
  if (state === "inv_item_defect_reason") {
    data.curItem.defect_reason = text.trim();
    await finishCurrentItemAu(supabase, chatId, data);
    return;
  }
  if (state === "inv_edit_value") {
    const field = data.editField;
    const item = data.items[data.editIdx];
    if (["cost", "qty", "mrp"].includes(field)) item[field] = parseFloat(text) || item[field];
    else item[field] = text.trim();
    delete data.editField;
    delete data.editIdx;
    await showInvSummaryAu(supabase, chatId, data);
    return;
  }
  if (state === "inv_payment_amount") {
    const amt = parseFloat(text);
    if (!amt || amt <= 0) { await tgSend(chatId, "Enter a valid amount (₹)?"); return; }
    data.paymentAmount = amt;
    await tgSend(chatId, "Payment mode?", {
      inline_keyboard: [
        [{ text: "Cash", callback_data: "inv:paymode:cash" }, { text: "Card", callback_data: "inv:paymode:card" }],
        [{ text: "Bank Transfer", callback_data: "inv:paymode:bank" }, { text: "Other", callback_data: "inv:paymode:other" }],
        INV_EXIT_ROW_AU,
      ],
    });
    await saveSession(supabase, chatId, "inv_payment_mode", data);
    return;
  }
  if (state === "inv_payment_split") {
    let meenakshi: number, shalini: number;
    if (skip) { meenakshi = data.paymentAmount / 2; shalini = data.paymentAmount / 2; }
    else { meenakshi = parseFloat(text) || 0; shalini = data.paymentAmount - meenakshi; }
    data.paymentSplit = { meenakshi, shalini };
    await showFinalConfirmAu(supabase, chatId, data);
    return;
  }
}

async function handleInventoryPhotoAu(supabase: any, chatId: number, data: any, photoSizes: any[]) {
  if (!data.curItem) return;
  const largest = photoSizes[photoSizes.length - 1];
  const result = await uploadTelegramPhotoGodown(largest.file_id, "item-photos", `${Date.now()}-inventory-telegram-au.jpg`);
  if ("error" in result) { await tgSend(chatId, `Couldn't save that photo — ${result.error}`); return; }
  data.curItem.photos = [...(data.curItem.photos || []), result.url].slice(0, 4);
  await saveSession(supabase, chatId, "inv_item_photos", data);
  await tgSend(chatId, `Photo ${data.curItem.photos.length}/4 saved. Send another, or type 'done'.`);
}

async function suggestMrpAu(supabase: any, name: string, material: string | null, variant: string | null, cost: number): Promise<string | null> {
  try {
    const { data: keyRow } = await supabase.from("settings").select("value").eq("key", "gemini_key").maybeSingle();
    const apiKey = keyRow?.value;
    if (!apiKey) return null;
    const prompt = `Estimate a fair retail sale price in AUD for a handloom saree to be sold in Australia: "${name}" ${material || ""} ${variant ? "(" + variant + ")" : ""}, vendor cost price (India, INR) ₹${cost}. Reply with ONLY a number (AUD), no currency symbol, no other text.`;
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
    });
    if (!res.ok) return null;
    const json = await res.json();
    const raw = json?.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
    const num = parseFloat((raw || "").replace(/[^\d.]/g, ""));
    return num ? fmtAud(num) : null;
  } catch {
    return null;
  }
}
