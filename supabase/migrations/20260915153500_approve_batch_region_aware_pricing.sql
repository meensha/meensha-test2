-- Fix: admin_approve_purchase_batch always created new SKUs as India-only
-- (sale_price + india default visibility), even for region='australia'
-- batches — meaning an approved AU purchase's item would never actually be
-- sellable on the AU storefront (au_available stayed false, sale_price_aud
-- stayed null). Cost (purchase_price) is unaffected — that's always INR
-- regardless of region, since vendors are India-based; only which price
-- field/availability flag gets set depends on region.

CREATE OR REPLACE FUNCTION admin_approve_purchase_batch(
  p_batch_id uuid,
  p_reviewed_by text
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_purchase_id  uuid;
  v_vendor_uuid  uuid;
  v_vendor_code  text;
  v_payment      jsonb;
  v_region       text;
  v_items        jsonb := '[]'::jsonb;
  v_total        numeric := 0;
  v_row          record;
  v_sku_id       uuid;
  v_sku_code     text;
  v_units_affected integer := 0;
  v_pending_count  integer;
BEGIN
  SELECT vendor_uuid, payment, region INTO v_vendor_uuid, v_payment, v_region
  FROM stock_intake_drafts WHERE batch_id = p_batch_id LIMIT 1;

  IF v_vendor_uuid IS NULL THEN
    RAISE EXCEPTION 'Batch % has no vendor or does not exist', p_batch_id;
  END IF;

  SELECT count(*) INTO v_pending_count
  FROM stock_intake_drafts WHERE batch_id = p_batch_id AND status = 'pending';
  IF v_pending_count = 0 THEN
    RAISE EXCEPTION 'Batch % has no pending items left to approve', p_batch_id;
  END IF;

  SELECT vendor_id INTO v_vendor_code FROM vendors WHERE id = v_vendor_uuid;

  INSERT INTO purchases (vendor_uuid, vendor_code, date, payment, items, total, sub)
  VALUES (v_vendor_uuid, v_vendor_code, CURRENT_DATE, v_payment, '[]'::jsonb, 0, 0)
  RETURNING id INTO v_purchase_id;

  FOR v_row IN
    SELECT * FROM stock_intake_drafts
    WHERE batch_id = p_batch_id AND status = 'pending'
    ORDER BY created_at
  LOOP
    IF v_row.is_defective THEN
      INSERT INTO inventory_returns_pending (sku_id, purchase_id, vendor_uuid, qty, reason, photo_url, flagged_by)
      VALUES (
        v_row.sku_id, v_purchase_id, v_vendor_uuid,
        COALESCE(v_row.defect_qty, v_row.qty), v_row.defect_reason,
        v_row.photo_urls->>0, p_reviewed_by
      );
    ELSE
      v_sku_id := v_row.sku_id;
      IF v_sku_id IS NULL THEN
        v_sku_code := upper(left(regexp_replace(coalesce(v_row.proposed_name, 'ITEM'), '[^a-zA-Z0-9]+', '', 'g'), 10))
          || '-' || to_char(now(), 'MMDD') || '-' || substr(md5(random()::text), 1, 4);
        WHILE EXISTS (SELECT 1 FROM inventory_skus WHERE sku_code = v_sku_code) LOOP
          v_sku_code := v_sku_code || substr(md5(random()::text), 1, 2);
        END LOOP;

        IF v_row.region = 'australia' THEN
          INSERT INTO inventory_skus (
            sku_code, name, material, variant, display_material, display_variant,
            sale_price_aud, au_available, cost, photos
          ) VALUES (
            v_sku_code, v_row.proposed_name, v_row.proposed_material, v_row.proposed_variant,
            v_row.proposed_material, v_row.proposed_variant,
            v_row.proposed_sale_price, true, v_row.purchase_price, v_row.photo_urls
          )
          RETURNING id INTO v_sku_id;
        ELSE
          INSERT INTO inventory_skus (
            sku_code, name, material, variant, display_material, display_variant,
            sale_price, india_available, cost, photos
          ) VALUES (
            v_sku_code, v_row.proposed_name, v_row.proposed_material, v_row.proposed_variant,
            v_row.proposed_material, v_row.proposed_variant,
            v_row.proposed_sale_price, true, v_row.purchase_price, v_row.photo_urls
          )
          RETURNING id INTO v_sku_id;
        END IF;
      END IF;

      PERFORM create_batch_units(
        p_sku_id := v_sku_id,
        p_vendor_code := v_vendor_code,
        p_purchase_id := v_purchase_id,
        p_qty := v_row.qty,
        p_photo_urls := ARRAY(SELECT jsonb_array_elements_text(v_row.photo_urls))
      );
      v_units_affected := v_units_affected + v_row.qty;
    END IF;

    v_items := v_items || jsonb_build_object(
      'name', v_row.proposed_name,
      'material', v_row.proposed_material,
      'variant', v_row.proposed_variant,
      'qty', v_row.qty,
      'cost', v_row.purchase_price,
      'defective', v_row.is_defective
    );
    v_total := v_total + COALESCE(v_row.purchase_price, 0) * v_row.qty;

    UPDATE stock_intake_drafts
    SET status = 'approved', reviewed_by = p_reviewed_by, reviewed_at = now()
    WHERE id = v_row.id;
  END LOOP;

  UPDATE purchases SET items = v_items, total = v_total, sub = v_total WHERE id = v_purchase_id;

  INSERT INTO vendor_audit_log (vendor_uuid, action, new_value, performed_by, units_affected)
  VALUES (v_vendor_uuid, 'purchase_approved', v_purchase_id::text, p_reviewed_by, v_units_affected);

  RETURN v_purchase_id;
END;
$$;

NOTIFY pgrst, 'reload schema';
