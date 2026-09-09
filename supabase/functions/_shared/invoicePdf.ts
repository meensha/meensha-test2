// Small helper for turning a sales.invoice_pdf_path (a Storage object path
// in the private `invoices` bucket) into a short-lived signed URL. Reused
// by generate-invoice-pdf itself (to hand back a usable link) and by the
// callers that need one for a WhatsApp draft message (admin.html, the
// Telegram bots) without duplicating the Storage call everywhere.
// deno-lint-ignore no-explicit-any
type SB = any;

export async function getInvoiceSignedUrl(
  supabase: SB,
  path: string,
  expirySeconds = 60 * 60 * 24 * 30, // 30 days
): Promise<string | null> {
  if (!path) return null;
  try {
    const { data, error } = await supabase.storage
      .from("invoices")
      .createSignedUrl(path, expirySeconds);
    if (error || !data?.signedUrl) return null;
    return data.signedUrl;
  } catch {
    return null;
  }
}
