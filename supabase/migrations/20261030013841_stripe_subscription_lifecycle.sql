-- =============================================================================
-- Stripe subscription lifecycle: ordered, atomic, idempotent state updates.
--
-- Builds on *_stripe_webhook_idempotency.sql. Replaces the two per-event
-- functions with one function that handles every subscription-related event
-- (checkout completion, subscription created/updated/deleted, invoice payment
-- outcomes) and guarantees, in ONE transaction per event:
--
--   1. Idempotency  — the event id is claimed in `stripe_webhook_events`
--                     (primary key); a redelivery returns 'duplicate'.
--   2. Serialisation — a transaction-scoped advisory lock on the subscription
--                     id makes concurrent events for the same subscription run
--                     one after another, in the order they acquire the lock.
--   3. Ordering     — every APPLIED event's Stripe `created` timestamp and a
--                     per-type rank are kept in the ledger. An event whose
--                     (created, rank) is older than the newest applied one does
--                     not change `status` (returns 'stale'). Terminal statuses
--                     ('canceled', 'incomplete_expired') are never left.
--   4. Association  — the application user id is taken from event metadata,
--                     else kept from the existing row, else borrowed from any
--                     row of the same Stripe customer. Identity fields are only
--                     ever filled in, never cleared, even by stale events.
--   5. Atomic failure — any error rolls back the ledger row as well, so the
--                     event is not marked processed and Stripe's retry can apply it.
--
-- Assumptions about `public.subscriptions` are unchanged from the previous
-- migration: it exists with columns stripe_customer_id, stripe_subscription_id,
-- status and "userId"; column types are taken from the table itself via
-- jsonb_populate_record. `status` now receives Stripe's real subscription
-- statuses (active, trialing, past_due, unpaid, incomplete, incomplete_expired,
-- paused, canceled) instead of a hard-coded value.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Ledger: record, per event, which subscription it concerned and its position
-- in Stripe's timeline, so the newest applied position can be looked up.
-- ---------------------------------------------------------------------------
alter table public.stripe_webhook_events
  add column stripe_subscription_id text,
  add column event_created          bigint   not null default 0,
  add column type_rank              smallint not null default 0,
  add column outcome                text     not null default 'applied';

comment on column public.stripe_webhook_events.stripe_subscription_id is 'Subscription the event concerned (null for events recorded before lifecycle ordering existed).';
comment on column public.stripe_webhook_events.event_created          is 'Stripe event `created` (unix seconds): first component of the ordering key.';
comment on column public.stripe_webhook_events.type_rank              is 'Per-event-type rank: second component of the ordering key (tie-break within one second).';
comment on column public.stripe_webhook_events.outcome                is 'processing | applied | stale. Only applied rows define a subscription''s newest known position.';

create index stripe_webhook_events_subscription_position_idx
  on public.stripe_webhook_events (stripe_subscription_id, event_created desc, type_rank desc)
  where outcome = 'applied';

-- ---------------------------------------------------------------------------
-- Replace the per-event functions.
-- ---------------------------------------------------------------------------
drop function public.stripe_apply_checkout_completed(text, text, text, text, text, text);
drop function public.stripe_apply_subscription_deleted(text, text, text, text);

-- Returns 'applied' | 'stale' | 'duplicate'.
create function public.stripe_apply_subscription_event(
  p_event_id               text,
  p_event_type             text,
  p_event_created          bigint,
  p_type_rank              smallint,
  p_stripe_subscription_id text,
  p_stripe_customer_id     text,
  p_user_id                text,
  p_status                 text
)
returns text
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_exists          boolean;
  v_current_status  text;
  v_current_customer text;
  v_current_user    text;
  v_last_created    bigint;
  v_last_rank       smallint;
  v_user_id         text;
  v_apply_status    boolean := true;
  v_row             record;  -- `record`, not %rowtype: keeps the body late-bound (see header)
begin
  if p_stripe_subscription_id is null or p_status is null then
    raise exception 'stripe_apply_subscription_event: p_stripe_subscription_id and p_status are required'
      using errcode = '22004';
  end if;

  -- 1. Claim the event id. Concurrent deliveries of the same event block here
  --    until the first transaction ends; if it committed they see a duplicate,
  --    if it rolled back they proceed.
  insert into public.stripe_webhook_events
         (event_id, event_type, stripe_subscription_id, event_created, type_rank, outcome)
  values (p_event_id, p_event_type, p_stripe_subscription_id, p_event_created, p_type_rank, 'processing')
  on conflict (event_id) do nothing;

  if not found then
    return 'duplicate';
  end if;

  -- 2. Serialise all processing for this subscription (released at commit/rollback).
  perform pg_advisory_xact_lock(hashtextextended(p_stripe_subscription_id, 0));

  -- 3. Current projection and newest applied position.
  select status, stripe_customer_id, "userId"::text
    into v_current_status, v_current_customer, v_current_user
    from public.subscriptions
   where stripe_subscription_id = p_stripe_subscription_id
   limit 1;
  v_exists := found;

  select event_created, type_rank
    into v_last_created, v_last_rank
    from public.stripe_webhook_events
   where stripe_subscription_id = p_stripe_subscription_id
     and outcome = 'applied'
   order by event_created desc, type_rank desc
   limit 1;

  -- 4. Ordering decision for `status`.
  if v_exists then
    if v_last_created is not null
       and (p_event_created, p_type_rank) < (v_last_created, v_last_rank) then
      v_apply_status := false;                      -- older than what we already applied
    end if;

    if v_current_status in ('canceled', 'incomplete_expired')
       and p_status is distinct from v_current_status then
      v_apply_status := false;                      -- terminal states are never left
    end if;
  end if;

  -- 5. User association: keep existing, else event metadata, else another
  --    subscription of the same Stripe customer.
  v_user_id := coalesce(v_current_user, p_user_id);

  if v_user_id is null and coalesce(v_current_customer, p_stripe_customer_id) is not null then
    select "userId"::text
      into v_user_id
      from public.subscriptions
     where stripe_customer_id = coalesce(v_current_customer, p_stripe_customer_id)
       and "userId" is not null
     limit 1;
  end if;

  -- 6. Build the projected row with the table's real column types.
  select r.* into v_row
    from jsonb_populate_record(
           null::public.subscriptions,
           jsonb_build_object(
             'stripe_customer_id',     coalesce(v_current_customer, p_stripe_customer_id),
             'stripe_subscription_id', p_stripe_subscription_id,
             'status',                 case when v_apply_status then p_status else v_current_status end,
             'userId',                 v_user_id
           )
         ) as r;

  if v_exists then
    update public.subscriptions
       set status             = v_row.status,
           stripe_customer_id = v_row.stripe_customer_id,
           "userId"           = v_row."userId"
     where stripe_subscription_id = p_stripe_subscription_id;
  else
    insert into public.subscriptions (stripe_customer_id, stripe_subscription_id, status, "userId")
    values (v_row.stripe_customer_id, v_row.stripe_subscription_id, v_row.status, v_row."userId");
  end if;

  -- 7. Record the outcome on the claimed ledger row.
  update public.stripe_webhook_events
     set outcome = case when v_apply_status then 'applied' else 'stale' end
   where event_id = p_event_id;

  return case when v_apply_status then 'applied' else 'stale' end;
end
$$;

comment on function public.stripe_apply_subscription_event(text, text, bigint, smallint, text, text, text, text)
  is 'Atomically records a Stripe event and applies it to public.subscriptions with per-subscription serialisation and (created, rank) ordering. Returns applied | stale | duplicate. service_role only.';

-- ---------------------------------------------------------------------------
-- Privileges: service_role only (see previous migration for the rationale).
-- ---------------------------------------------------------------------------
revoke execute on function public.stripe_apply_subscription_event(text, text, bigint, smallint, text, text, text, text) from public, anon, authenticated;
grant  execute on function public.stripe_apply_subscription_event(text, text, bigint, smallint, text, text, text, text) to service_role;
