// Receives Razorpay's `payment_link.paid` webhook. Verifies the signature,
// marks the matching `orders` row paid, converts the reserved inventory units
// to sold, and inserts a matching `sales` row so the order flows into the
// existing Sales Register / Daily Payment Summary / P&L exactly like a
// manually-recorded sale.
//
// Required secret: RAZORPAY_WEBHOOK_SECRET (from the webhook's setup page in
// the Razorpay Dashboard — different from the API key secret).
// Configure this function's URL as the webhook endpoint in Razorpay, event:
// payment_link.paid

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { findCustomerByWa } from "../_shared/customerLink.ts";

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  const rawBody = await req.text();
  const signature = req.headers.get("x-razorpay-signature") || "";
  const webhookSecret = Deno.env.get("RAZORPAY_WEBHOOK_SECRET")!;

  const valid = await verifySignature(rawBody, signature, webhookSecret);
  if (!valid) {
    return new Response("Invalid signature", { status: 401 });
  }

  const payload = JSON.parse(rawBody);
  if (payload.event !== "payment_link.paid") {
    // Acknowledge other events without acting on them.
    return new Response("ok", { status: 200 });
  }

  const linkEntity = payload.payload?.payment_link?.entity;
  const paymentEntity = payload.payload?.payment?.entity;
  const referenceId = linkEntity?.reference_id;
  if (!referenceId) {
    return new Response("Missing reference_id", { status: 400 });
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  const { data: order, error: orderErr } = await supabase
    .from("orders")
    .select("*")
    .eq("id", referenceId)
    .single();
  if (orderErr || !order) {
    return new Response("Order not found", { status: 404 });
  }
  if (order.status === "paid") {
    // Already processed (Razorpay may retry webhooks) — idempotent no-op.
    return new Response("ok", { status: 200 });
  }

  await supabase
    .from("orders")
    .update({ status: "paid", updated_at: new Date().toISOString() })
    .eq("id", referenceId);

  // Next invoice number, same counter admin.html's saveSale() uses.
  const { data: ctrRows } = await supabase
    .from("settings")
    .select("value")
    .eq("key", "inv_counter")
    .single();
  const nextCtr = (parseInt(ctrRows?.value || "1000") || 1000) + 1;
  await supabase
    .from("settings")
    .update({ value: String(nextCtr) })
    .eq("key", "inv_counter");
  const inv = "MSH-" + nextCtr;

  const razorpayFee = Math.round(order.total * 0.02);

  // Every Razorpay-paid sale (storefront or telegram_kiosk) links to a
  // customers row when the buyer already has one (matched by WA number) —
  // customers.email/password_hash are NOT NULL, so a first-time buyer with
  // no account simply gets no customer_id, same as any Cash/UPI sale.
  const customerId = await findCustomerByWa(supabase, order.customer?.wa);

  const { data: saleRows, error: saleErr } = await supabase
    .from("sales")
    .insert({
      inv,
      date: new Date().toISOString().slice(0, 10),
      customer: order.customer,
      customer_id: customerId,
      items: order.items,
      total: order.total,
      paid: order.total,
      balance: 0,
      pay_mode: "Razorpay",
      razorpay_fee: razorpayFee,
      notes: "Online order via storefront cart",
      delivery_mode: "offline",
      shipping_status: "na",
      taxes: [], // kiosk/storefront sales are never taxed — only admin.html's manual entry has a tax toggle
      created_by: "storefront",
      source: "storefront",
    })
    .select()
    .single();

  if (!saleErr && saleRows) {
    for (const unitId of order.unit_ids || []) {
      await supabase.rpc("claim_unit", {
        p_unit_id: unitId,
        p_sale_id: saleRows.id,
      });
    }
  }

  if (order.coupon?.code && order.coupon?.wa) {
    await supabase.rpc("consume_coupon", {
      p_code: order.coupon.code,
      p_wa: order.coupon.wa,
    });
  }

  // Best-effort invoice PDF generation — must not push this handler's
  // response past Razorpay's webhook timeout, but a plain un-awaited fetch
  // risks the Edge Function isolate being torn down before it completes.
  // EdgeRuntime.waitUntil is Supabase's documented way to let background
  // work finish after the response is already sent.
  if (!saleErr && saleRows) {
    const pdfPromise = fetch(`${Deno.env.get("SUPABASE_URL")}/functions/v1/generate-invoice-pdf`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}`,
      },
      body: JSON.stringify({ sale_id: saleRows.id }),
    }).catch(() => { /* best-effort, never blocks the webhook response */ });
    // @ts-ignore -- EdgeRuntime is a Supabase-provided global, not in Deno's own types
    if (typeof EdgeRuntime !== "undefined") EdgeRuntime.waitUntil(pdfPromise);
  }

  // Kiosk-initiated Razorpay sales don't finalize in the bot itself — the
  // staff member sent a payment link and moved on. This is the only place
  // that knows the payment actually landed, so it's the only place that can
  // tell them to hand over the item.
  if (order.source === "telegram_kiosk" && order.telegram_chat_id) {
    try {
      const botToken = Deno.env.get("TELEGRAM_BOT_TOKEN");
      if (botToken) {
        await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chat_id: order.telegram_chat_id,
            text: `✅ Payment received — ₹${order.total} from ${order.customer?.name ?? "customer"} (Invoice ${inv}). You can hand over the item now.`,
          }),
        });
      }
    } catch { /* payment is already recorded regardless — this is best-effort */ }
  }

  return new Response("ok", { status: 200 });
});

async function verifySignature(
  body: string,
  signature: string,
  secret: string,
): Promise<boolean> {
  if (!signature || !secret) return false;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sigBuf = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(body),
  );
  const expected = Array.from(new Uint8Array(sigBuf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  // Constant-time-ish comparison
  if (expected.length !== signature.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) {
    diff |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
  }
  return diff === 0;
}
