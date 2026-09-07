-- Event-scoped visitor voucher registration: staff creates an "event"
-- (discount config + region + validity), gets a shareable registration
-- link, and each visitor who fills it in on that link gets their own
-- unique one-time coupon tied to that event. Extends the existing
-- stall-registration pattern (register_visitor/register.html — one fixed
-- global 5% code) to support any number of differently-configured events
-- running at once, each India- or Australia-scoped independently.

CREATE TABLE IF NOT EXISTS voucher_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title text NOT NULL,
  region text NOT NULL CHECK (region IN ('india','australia','all')),
  discount_type text NOT NULL CHECK (discount_type IN ('percent','flat')),
  discount_value numeric NOT NULL CHECK (discount_value > 0),
  valid_days int NOT NULL DEFAULT 7,
  active boolean NOT NULL DEFAULT true,
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE coupons ADD COLUMN IF NOT EXISTS event_id uuid REFERENCES voucher_events(id);

-- Public: fetch an event's display info for the registration page header —
-- no auth needed, same trust level as the coupon code itself.
CREATE OR REPLACE FUNCTION get_voucher_event(p_event_id uuid)
RETURNS jsonb
LANGUAGE sql SECURITY DEFINER SET search_path = public, extensions AS $$
  SELECT CASE WHEN id IS NULL THEN NULL ELSE jsonb_build_object(
    'id', id, 'title', title, 'region', region,
    'discount_type', discount_type, 'discount_value', discount_value, 'active', active
  ) END
  FROM voucher_events WHERE id = p_event_id;
$$;
GRANT EXECUTE ON FUNCTION get_voucher_event(uuid) TO anon, authenticated;

-- Public: a visitor registers against a specific event and gets a unique
-- coupon back, one per WhatsApp number per event (repeat visits return
-- their existing code rather than minting a new one each time).
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

  IF existing IS NOT NULL THEN
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
GRANT EXECUTE ON FUNCTION register_event_visitor(uuid, text, text) TO anon, authenticated;

-- Staff-facing: create a new event (from admin.html or either Telegram
-- bot), returns its id so a caller can build the shareable registration link.
CREATE OR REPLACE FUNCTION admin_create_voucher_event(
  p_title text, p_region text, p_discount_type text, p_discount_value numeric,
  p_valid_days int, p_created_by text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions AS $$
DECLARE ev voucher_events;
BEGIN
  INSERT INTO voucher_events (title, region, discount_type, discount_value, valid_days, created_by)
  VALUES (p_title, p_region, p_discount_type, p_discount_value, COALESCE(p_valid_days, 7), p_created_by)
  RETURNING * INTO ev;
  RETURN jsonb_build_object('id', ev.id, 'title', ev.title);
END;
$$;
GRANT EXECUTE ON FUNCTION admin_create_voucher_event(text, text, text, numeric, int, text) TO anon, authenticated;

NOTIFY pgrst, 'reload schema';
