-- Logs one row per completed bot action (sale, voucher created, stock
-- intake submitted, event form created, Insta/Razorpay link generated) so
-- MeenshaMonitor can be told a session summary once a chat goes quiet for
-- a while, instead of a separate ping per action. See
-- supabase/functions/_shared/activityLog.ts (writer, both bots) and
-- supabase/functions/activity-summary-digest (reader/summarizer, cron).
-- No RLS/anon grants needed — only ever written/read via service_role.

CREATE TABLE IF NOT EXISTS bot_activity_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bot text NOT NULL CHECK (bot IN ('india','au')),
  chat_id text NOT NULL,
  actor text,
  action text NOT NULL,
  detail text,
  amount numeric,
  created_at timestamptz NOT NULL DEFAULT now(),
  notified boolean NOT NULL DEFAULT false
);
CREATE INDEX IF NOT EXISTS bot_activity_log_pending_idx ON bot_activity_log (chat_id) WHERE NOT notified;

CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

-- Checks every 10 minutes for chats with unnotified activity whose most
-- recent action is itself already 10+ minutes old (a "clear break") —
-- the digest function does that comparison itself, this just triggers it
-- often enough that a summary lands soon after a break, not hours later.
SELECT cron.schedule(
  'meensha-activity-summary-digest',
  '*/10 * * * *',
  $$
  SELECT net.http_post(
    url := 'https://eglanmhhcccsuhbxywua.supabase.co/functions/v1/activity-summary-digest',
    headers := jsonb_build_object('Content-Type', 'application/json')
  );
  $$
);

NOTIFY pgrst, 'reload schema';
