-- Links a Razorpay-paid sale to a real customers row when the buyer already
-- has one (find-only by WhatsApp number, see razorpay-webhook), instead of
-- only the loose `customer` jsonb blob it already carries. Cash/UPI
-- Direct/Other kiosk sales are left unlinked (customer_id NULL) — this is a
-- Razorpay/credit-card-specific behavior per the shop owner, not a change
-- to how all sales are recorded.
--
-- Deliberately sales-only, not orders too: `orders` is just the transient
-- pre-payment staging row `create-payment-link` creates, never updated with
-- a customer_id anywhere — `sales` (the actual completed purchase) is where
-- this linking belongs.
ALTER TABLE sales ADD COLUMN IF NOT EXISTS customer_id uuid REFERENCES customers(id);

NOTIFY pgrst, 'reload schema';
