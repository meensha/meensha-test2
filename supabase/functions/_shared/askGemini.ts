// Clarify-then-answer flow for the natural-language Q&A feature.
// Tries OpenRouter first (if settings.openrouter_key is set), falling back
// to Gemini (settings.gemini_key, the original/only provider before this)
// if OpenRouter isn't configured or its call fails. Both read fresh from
// settings on every call (same convention as everything else in this
// project that reads live config rather than baking in a secret) — nothing
// changes for existing setups until an openrouter_key is actually added.
//
// Design: the LLM is NEVER given database access or asked to write SQL. It
// only ever sees a fixed list of named, parameterized lookups (see
// knowledgeBase.ts) and picks one — or asks a clarifying question first if
// the request doesn't map cleanly onto any of them. Only the small, already-
// retrieved result of that one lookup gets sent back to the LLM for phrasing
// — never the raw database, never more than what's needed to answer this
// one question.

// deno-lint-ignore no-explicit-any
type SB = any;
import type { LookupDef, LookupName } from "./knowledgeBase.ts";

async function callGemini(apiKey: string, prompt: string): Promise<string> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
  });
  if (!res.ok) throw new Error(`Gemini error: ${res.status}`);
  const data = await res.json();
  return data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || "";
}

async function callOpenRouter(apiKey: string, model: string, prompt: string): Promise<string> {
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model, messages: [{ role: "user", content: prompt }] }),
  });
  if (!res.ok) throw new Error(`OpenRouter error: ${res.status}`);
  const data = await res.json();
  return data?.choices?.[0]?.message?.content?.trim() || "";
}

// Tries OpenRouter first when configured, silently falls back to Gemini —
// callers never see which provider actually answered.
async function callLLM(supabase: SB, prompt: string): Promise<string> {
  const { data: rows } = await supabase.from("settings").select("key,value").in("key", ["openrouter_key", "openrouter_model", "gemini_key"]);
  const byKey: Record<string, string> = {};
  (rows || []).forEach((r: { key: string; value: string }) => byKey[r.key] = r.value);

  if (byKey.openrouter_key) {
    try {
      return await callOpenRouter(byKey.openrouter_key, byKey.openrouter_model || "openai/gpt-4o-mini", prompt);
    } catch { /* fall through to Gemini below */ }
  }
  if (!byKey.gemini_key) throw new Error("No AI provider configured");
  return await callGemini(byKey.gemini_key, prompt);
}

export async function askGemini(
  supabase: SB,
  question: string,
  catalog: LookupDef[],
  runLookup: (supabase: SB, name: LookupName, params: Record<string, string>) => Promise<string>,
): Promise<string> {
  const { data: keyRows } = await supabase.from("settings").select("key").in("key", ["openrouter_key", "gemini_key"]);
  if (!keyRows?.length) return "AI lookup isn't configured yet (no OpenRouter or Gemini key set in admin).";

  const catalogText = catalog.map((l) => `- ${l.name}: ${l.description}. Params: ${JSON.stringify(l.params)}`).join("\n");
  const routePrompt = `You are a lookup router for a saree e-commerce business's staff Telegram bot. A staff member asked a question. You have access to these lookups ONLY — you cannot answer from general knowledge, you cannot make up numbers:

${catalogText}

Question: "${question}"

Reply with ONLY one JSON object, no markdown, no explanation:
- If the question clearly maps to one lookup: {"action":"lookup","name":"<lookup name>","params":{...}}
- If it's too vague to pick params confidently (e.g. period or item unclear): {"action":"clarify","question":"<one short clarifying question>"}
- If it's not something any of these lookups can answer at all: {"action":"decline","reason":"<why>"}`;

  let routed: { action: string; name?: string; params?: Record<string, string>; question?: string; reason?: string };
  try {
    const raw = await callLLM(supabase, routePrompt);
    const jsonText = raw.replace(/^```json\s*|```\s*$/g, "").trim();
    routed = JSON.parse(jsonText);
  } catch {
    return "Sorry, couldn't understand that — try asking more simply, e.g. \"ajrak stock\" or \"sales this week\".";
  }

  if (routed.action === "clarify") return routed.question || "Could you clarify what you mean?";
  if (routed.action === "decline") return routed.reason || "I can only answer stock, sales, and site-health questions.";
  if (routed.action !== "lookup" || !routed.name) return "Sorry, couldn't process that.";

  const lookupResult = await runLookup(supabase, routed.name as LookupName, routed.params || {});

  const phrasePrompt = `A staff member asked: "${question}"\n\nHere is the real data (from the live database) to answer it with:\n${lookupResult}\n\nReply with a short, plain, friendly answer using ONLY the data above — don't invent anything not shown. Keep it to 2-4 lines, no markdown formatting.`;
  try {
    return await callLLM(supabase, phrasePrompt);
  } catch {
    return lookupResult; // fall back to the raw data if every provider call fails
  }
}

// ── Social media boost assistant (free-form guidance layer) ────────────────
// Separate from askGemini() above on purpose: askGemini() is a fixed-lookup
// router that never lets the LLM free-chat. This one does — scoped by
// instructions (not by a lookup catalog) to Instagram/social-growth guidance
// only, since the whole feature is Shalini asking "what next" style
// questions about the IG setup checklist (see telegram-bot/index.ts's
// sendSocialBoostNudge/getIgSetupChecklist), not fixed stock/sales data.
// Reuses callLLM() so it honors the same OpenRouter-then-Gemini fallback.
export async function askSocialBoostAssistant(
  supabase: SB,
  question: string,
  checklist: { id: string; label: string; done: boolean }[],
): Promise<string> {
  const done = checklist.filter((c) => c.done).map((c) => c.label);
  const pending = checklist.filter((c) => !c.done).map((c) => c.label);
  const prompt = `You are a friendly guide helping a saree shop's staff member grow traffic to their Instagram page and website. You are NOT a general-purpose assistant — only answer questions about Instagram/social media growth, the Instagram Graph API setup checklist below, or driving traffic to their online store. For anything else, politely say you can only help with social media growth topics.

Instagram Graph API setup checklist — already done: ${done.length ? done.join(", ") : "none yet"}. Still pending: ${pending.length ? pending.join(", ") : "none, all done"}.

Staff member asked: "${question}"

Give a short, practical, encouraging answer (3-6 lines, no markdown formatting). If the question is about one of the pending setup steps, walk them through it concretely (where to tap/click, what to look for) rather than giving generic advice.`;

  try {
    return await callLLM(supabase, prompt);
  } catch {
    return "Sorry, I couldn't reach the AI assistant right now — try again in a bit, or check the pending steps list above.";
  }
}

// ── Vision extraction (Stock Intake guided flow) ───────────────────────────
// Separate from askGemini()'s fixed-lookup Q&A router above — this sends the
// invoice photo itself to Gemini (inline base64, same
// generativelanguage.googleapis.com endpoint callGemini() already uses, just
// a vision-capable model + image parts) and asks for structured JSON back.
// OpenRouter is only ever used for text in this codebase (see callLLM()
// above), so vision always goes straight to Gemini — reads settings.gemini_key
// fresh, same lookup pattern as callLLM()/suggestMrp().
export type InvoiceLineItem = {
  description: string;
  hsn?: string | null;
  qty: number;
  rate: number;
  amount: number;
};
export type InvoiceDraft = {
  vendor_name: string | null;
  invoice_number: string | null;
  date: string | null;
  items: InvoiceLineItem[];
  total: number | null;
};

export async function extractInvoiceData(
  supabase: SB,
  images: { mimeType: string; data: string }[],
): Promise<InvoiceDraft | null> {
  if (!images.length) return null;
  const { data: keyRow } = await supabase.from("settings").select("value").eq("key", "gemini_key").maybeSingle();
  const apiKey = keyRow?.value;
  if (!apiKey) return null;

  const prompt = `You are reading one or more photos of a vendor invoice for a saree wholesale business. Extract: vendor name, invoice number, date (YYYY-MM-DD if you can tell), line items (description, HSN code if visible, quantity, rate, amount), and the grand total.
Reply with ONLY one JSON object, no markdown, no explanation, in exactly this shape:
{"vendor_name":string|null,"invoice_number":string|null,"date":string|null,"items":[{"description":string,"hsn":string|null,"qty":number,"rate":number,"amount":number}],"total":number|null}
If a field isn't visible or legible, use null for that field. Omit a line item only if it's completely unreadable.`;

  // deno-lint-ignore no-explicit-any
  const parts: any[] = [{ text: prompt }];
  for (const img of images) parts.push({ inlineData: { mimeType: img.mimeType, data: img.data } });

  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ contents: [{ parts }] }) },
    );
    if (!res.ok) return null;
    const json = await res.json();
    const raw = json?.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
    if (!raw) return null;
    const jsonText = raw.replace(/^```json\s*|```\s*$/g, "").trim();
    const parsed = JSON.parse(jsonText);
    if (!Array.isArray(parsed.items)) return null;
    return parsed as InvoiceDraft;
  } catch {
    return null;
  }
}
