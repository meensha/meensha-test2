-- Schedules daily-region-summary once per region, each at 9:00am in that
-- region's own local time — same pg_cron + net.http_post pattern as the
-- existing daily-health-check cron.
--
-- India: 9:00 IST = 03:30 UTC (IST has no daylight saving, this is exact
-- year-round).
-- Australia: 9:00 AEST = 23:00 UTC the previous day. AEST is UTC+10 —
-- during Australian daylight saving (AEDT, UTC+11, roughly early Oct to
-- early Apr) this cron fires at 10am local instead of 9am, a known
-- limitation of a fixed-UTC cron expression. Adjust to '0 22 * * *' during
-- AEDT months if exact 9am matters, or revisit with a DST-aware scheduler
-- later.

CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

SELECT cron.schedule(
  'meensha-daily-summary-india',
  '30 3 * * *',
  $$
  SELECT net.http_post(
    url := 'https://eglanmhhcccsuhbxywua.supabase.co/functions/v1/daily-region-summary',
    headers := jsonb_build_object('Content-Type', 'application/json'),
    body := jsonb_build_object('region', 'india')
  );
  $$
);

SELECT cron.schedule(
  'meensha-daily-summary-australia',
  '0 23 * * *',
  $$
  SELECT net.http_post(
    url := 'https://eglanmhhcccsuhbxywua.supabase.co/functions/v1/daily-region-summary',
    headers := jsonb_build_object('Content-Type', 'application/json'),
    body := jsonb_build_object('region', 'australia')
  );
  $$
);

NOTIFY pgrst, 'reload schema';
