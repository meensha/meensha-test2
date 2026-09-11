// Shared by razorpay-webhook and telegram-bot: normalizes a WhatsApp number
// to the same canonical form stored in customers.wa (digits-only, country
// code + number, e.g. "918709525218" — see index.html's signup comment
// around the `cc + waNational` line), then looks up the matching customers
// row for a Razorpay-paid sale. Both bots/webhook are India-only, so a bare
// 10-digit number is assumed to be missing the "91" country code.
// deno-lint-ignore no-explicit-any
type SB = any;

export function normalizeWa(raw: string): string {
  const digits = (raw || "").replace(/\D/g, "");
  if (digits.length === 10) return "91" + digits;
  return digits;
}

// Find-only, deliberately not find-or-create: customers.email and
// customers.password_hash are both NOT NULL — every real row is created via
// the site's own email+password signup (verify_customer_signup_otp), so a
// Razorpay/kiosk sale (WA number + name only, no email) can link to an
// account that already exists but must never fabricate a bare one just to
// get an id. A brand-new buyer simply gets no customer_id, same as Cash/UPI.
// Returns the customer id, or null if wa is empty/invalid/not found.
export async function findCustomerByWa(
  supabase: SB,
  waRaw: string,
): Promise<string | null> {
  const wa = normalizeWa(waRaw);
  if (!wa) return null;

  const { data: existing } = await supabase
    .from("customers")
    .select("id")
    .eq("wa", wa)
    .maybeSingle();
  return existing?.id ?? null;
}
