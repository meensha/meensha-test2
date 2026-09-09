-- Adds a generic, admin-only tax structure to `sales` (replaces the
-- GST-only gst_pct/gst_amt fields going forward — those are left in place,
-- unused, so old rows aren't touched) plus storage for the generated
-- invoice PDF. Empty `taxes` array = no tax line shown anywhere, which is
-- the default for every sale (kiosk bots and the storefront always insert
-- taxes: [] — only admin.html's manual-sale form has a tax toggle).
ALTER TABLE sales ADD COLUMN IF NOT EXISTS taxes jsonb DEFAULT '[]'::jsonb;
ALTER TABLE sales ADD COLUMN IF NOT EXISTS subtotal numeric;
ALTER TABLE sales ADD COLUMN IF NOT EXISTS invoice_pdf_path text;

-- NOTE (manual step, not covered by this migration): create a Supabase
-- Storage bucket named `invoices`, private (not public), before deploying
-- the generate-invoice-pdf Edge Function — it uploads each PDF there and
-- admin.html/invoice.html read it back via a short-lived signed URL.

NOTIFY pgrst, 'reload schema';
