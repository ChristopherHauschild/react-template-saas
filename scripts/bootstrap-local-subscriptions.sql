-- DEVELOPMENT ONLY: the repository originally assumed a pre-existing
-- public.subscriptions table. Create a minimal compatible table in a fresh
-- *local* Supabase database so billing pages/webhooks can be exercised.
-- NEVER treat this stand-in as the canonical production schema.
create table if not exists public.subscriptions (
  id uuid primary key default gen_random_uuid(),
  stripe_customer_id text,
  stripe_subscription_id text,
  status text,
  "userId" uuid
);
