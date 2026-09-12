-- Schedules the pending-cost-digest Edge Function to run daily at
-- 9:00 IST via pg_cron, same mechanism as
-- setup/add_returns_pending_digest_cron.sql. Requires: the function already
-- deployed with JWT verification OFF (`supabase functions deploy
-- pending-cost-digest --no-verify-jwt`) — pg_cron's net.http_post call
-- carries no auth header, same reasoning as the other digest jobs.

CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

-- 09:00 IST = 03:30 UTC.
SELECT cron.schedule(
  'meensha-pending-cost-digest',
  '30 3 * * *',
  $$
  SELECT net.http_post(
    url := 'https://eglanmhhcccsuhbxywua.supabase.co/functions/v1/pending-cost-digest',
    headers := jsonb_build_object('Content-Type', 'application/json')
  );
  $$
);

NOTIFY pgrst, 'reload schema';
