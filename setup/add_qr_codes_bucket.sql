-- Storage bucket for the UPI QR code image staff upload via the Telegram
-- bot's Maintenance menu (telegram-bot/index.ts, maint:setqr). Public bucket
-- so the storefront (index.html) and the bot's own sendPhoto call can both
-- read it back by URL, same pattern as the item-photos bucket
-- (create_storage_bucket.sql). Only one object ever lives here — a fixed
-- name (upi-qr.jpg) that gets overwritten each time staff set a new QR.

INSERT INTO storage.buckets (id, name, public)
VALUES ('qr-codes', 'qr-codes', true)
ON CONFLICT (id) DO NOTHING;

-- Uploads only ever happen from the telegram-bot Edge Function (service_role,
-- bypasses RLS) — public read is all that's needed here.
DROP POLICY IF EXISTS "qr_codes_public_read" ON storage.objects;
CREATE POLICY "qr_codes_public_read" ON storage.objects
  FOR SELECT TO public
  USING (bucket_id = 'qr-codes');

-- Verify:
-- SELECT id, name, public FROM storage.buckets WHERE id = 'qr-codes';
