-- =============================================================================
-- Stripe webhook idempotency: durable, database-enforced event deduplication.
--
-- Stripe delivers webhook events at least once. If the HTTP response is lost
-- after a successful write, the same event is delivered again. This migration
-- adds a ledger keyed on Stripe's event id and two functions that record the
-- event and persist its effect inside ONE transaction, so that:
--
--   * a redelivered event is detected (returns 'duplicate') and not re-applied;
--   * concurrent deliveries of the same event serialise on the ledger's primary
--     key: the second waits for the first transaction and then sees 'duplicate';
--   * a failed persistence operation rolls back the ledger row as well, so the
--     event is NOT marked processed and Stripe's retry can apply it.
--
-- Assumptions about the pre-existing `public.subscriptions` table (not managed
-- by this migration): it exists, and has the columns the application already
-- writes: stripe_customer_id, stripe_subscription_id, status, "userId" (this
-- casing is what the application code uses). Column TYPES are not assumed:
-- values are converted through `jsonb_populate_record(null::public.subscriptions, …)`,
-- which uses the table's actual column types. Function bodies are resolved at
-- first execution, so this migration applies even before `subscriptions` exists,
-- and a schema mismatch surfaces as an error on the first call (which the
-- webhook reports as a 5xx so Stripe retries).
--
-- See supabase/README.md for deployment steps.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Ledger of applied Stripe events
-- ---------------------------------------------------------------------------
create table public.stripe_webhook_events (
  event_id     text        primary key,
  event_type   text        not null,
  processed_at timestamptz not null default now()
);

comment on table  public.stripe_webhook_events              is 'Stripe webhook events whose effect has been committed. The primary key is the idempotency guard.';
comment on column public.stripe_webhook_events.event_id     is 'Stripe event id (evt_…).';
comment on column public.stripe_webhook_events.event_type   is 'Stripe event type, for observability only.';
comment on column public.stripe_webhook_events.processed_at is 'When the event''s effect was committed.';

-- Supabase grants API roles access to new public objects by default; this table
-- is internal to the webhook and must not be reachable through the REST API.
alter table public.stripe_webhook_events enable row level security;
revoke all on table public.stripe_webhook_events from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- checkout.session.completed  →  insert subscription row
-- Returns 'applied' | 'duplicate'.
-- ---------------------------------------------------------------------------
create function public.stripe_apply_checkout_completed(
  p_event_id               text,
  p_event_type             text,
  p_stripe_customer_id     text,
  p_stripe_subscription_id text,
  p_status                 text,
  p_user_id                text
)
returns text
language plpgsql
security invoker
set search_path = ''
as $$
begin
  -- Claim the event. Under concurrency the loser blocks here until the winner's
  -- transaction ends; if the winner committed, the claim fails and we report a
  -- duplicate. If the winner rolled back, the claim succeeds and we proceed.
  insert into public.stripe_webhook_events (event_id, event_type)
  values (p_event_id, p_event_type)
  on conflict (event_id) do nothing;

  if not found then
    return 'duplicate';
  end if;

  -- Same four columns the application wrote before this migration. Types come
  -- from the real table definition via jsonb_populate_record.
  insert into public.subscriptions (stripe_customer_id, stripe_subscription_id, status, "userId")
  select r.stripe_customer_id, r.stripe_subscription_id, r.status, r."userId"
  from jsonb_populate_record(
         null::public.subscriptions,
         jsonb_build_object(
           'stripe_customer_id',     p_stripe_customer_id,
           'stripe_subscription_id', p_stripe_subscription_id,
           'status',                 p_status,
           'userId',                 p_user_id
         )
       ) as r;

  return 'applied';
end
$$;

comment on function public.stripe_apply_checkout_completed(text, text, text, text, text, text)
  is 'Atomically records a Stripe event and inserts its subscription row. Returns applied | duplicate. service_role only.';

-- ---------------------------------------------------------------------------
-- customer.subscription.deleted  →  mark subscription canceled
-- Returns 'applied' | 'duplicate' | 'no_match'.
-- A 'no_match' is NOT recorded in the ledger: nothing was changed, and a later
-- redelivery (e.g. once the subscription row exists) should still be able to apply.
-- ---------------------------------------------------------------------------
create function public.stripe_apply_subscription_deleted(
  p_event_id               text,
  p_event_type             text,
  p_stripe_subscription_id text,
  p_status                 text
)
returns text
language plpgsql
security invoker
set search_path = ''
as $$
begin
  insert into public.stripe_webhook_events (event_id, event_type)
  values (p_event_id, p_event_type)
  on conflict (event_id) do nothing;

  if not found then
    return 'duplicate';
  end if;

  update public.subscriptions
     set status = p_status
   where stripe_subscription_id = p_stripe_subscription_id;

  if not found then
    delete from public.stripe_webhook_events where event_id = p_event_id;
    return 'no_match';
  end if;

  return 'applied';
end
$$;

comment on function public.stripe_apply_subscription_deleted(text, text, text, text)
  is 'Atomically records a Stripe event and updates the subscription status. Returns applied | duplicate | no_match. service_role only.';

-- ---------------------------------------------------------------------------
-- Privileges: Postgres grants EXECUTE to PUBLIC on new functions and Supabase's
-- default privileges add anon/authenticated. Anyone holding the public anon key
-- could otherwise call these through /rest/v1/rpc and forge subscription state,
-- bypassing Stripe signature verification. Only service_role may execute them.
-- ---------------------------------------------------------------------------
revoke execute on function public.stripe_apply_checkout_completed(text, text, text, text, text, text) from public, anon, authenticated;
revoke execute on function public.stripe_apply_subscription_deleted(text, text, text, text)           from public, anon, authenticated;

grant execute on function public.stripe_apply_checkout_completed(text, text, text, text, text, text) to service_role;
grant execute on function public.stripe_apply_subscription_deleted(text, text, text, text)           to service_role;
