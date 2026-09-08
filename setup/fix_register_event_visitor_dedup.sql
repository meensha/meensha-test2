-- Same bug as fix_register_visitor_dedup.sql, reintroduced when
-- register_event_visitor was written by copying the pre-fix pattern:
-- `existing IS NOT NULL` on a composite (row) type requires ALL fields to
-- be non-null to be true, but a fresh coupon's `used_at` (and possibly
-- `category_filter`) is always NULL — so the dedup check silently failed
-- for every real match, minting a fresh duplicate coupon on every repeat
-- registration for the same event+WhatsApp number instead of returning
-- the existing one. Fixed the same way: PL/pgSQL's FOUND flag.

CREATE OR REPLACE FUNCTION register_event_visitor(p_event_id uuid, p_name text, p_wa text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions AS $$
DECLARE
  ev voucher_events;
  wa_digits text := regexp_replace(p_wa, '[^0-9]', '', 'g');
  existing coupons;
  new_code text;
  c coupons;
BEGIN
  SELECT * INTO ev FROM voucher_events WHERE id = p_event_id AND active;
  IF ev IS NULL THEN
    RETURN jsonb_build_object('error', 'This event link is no longer active.');
  END IF;
  IF p_name IS NULL OR trim(p_name) = '' OR length(wa_digits) < 10 THEN
    RETURN jsonb_build_object('error', 'Enter a valid name and WhatsApp number.');
  END IF;

  SELECT * INTO existing FROM coupons
    WHERE event_id = p_event_id
    AND right(regexp_replace(customer_wa, '[^0-9]', '', 'g'), 10) = right(wa_digits, 10)
  LIMIT 1;

  IF FOUND THEN
    RETURN jsonb_build_object(
      'code', existing.code, 'discount_type', existing.discount_type,
      'discount_value', existing.discount_value, 'valid_until', existing.valid_until,
      'already_registered', true
    );
  END IF;

  LOOP
    new_code := 'MSH-' || upper(substr(md5(random()::text), 1, 6));
    EXIT WHEN NOT EXISTS (SELECT 1 FROM coupons WHERE code = new_code);
  END LOOP;

  INSERT INTO coupons (
    code, customer_name, customer_wa, discount_type, discount_value,
    region, valid_from, valid_until, source, event_id
  ) VALUES (
    new_code, trim(p_name), wa_digits, ev.discount_type, ev.discount_value,
    ev.region, current_date, current_date + ev.valid_days, 'event_registration', p_event_id
  )
  RETURNING * INTO c;

  RETURN jsonb_build_object(
    'code', c.code, 'discount_type', c.discount_type, 'discount_value', c.discount_value,
    'valid_until', c.valid_until, 'already_registered', false
  );
END;
$$;

NOTIFY pgrst, 'reload schema';
