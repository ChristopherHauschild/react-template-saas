-- =============================================================================
-- Ownership, privileges and integrity of public.subscriptions
-- =============================================================================
-- `public.subscriptions` predates this repository and nothing so far said who
-- may read or write it. Through PostgREST, a table created with Supabase's
-- defaults and no row level security is readable AND writable by anyone holding
-- the public anon key: every user's billing rows, a self-granted `active`
-- status, deleted or forged rows. This migration makes the database enforce
-- what the application assumes:
--
--   1. Privileges — only the service role (the Stripe webhook) writes. Signed-in
--      users may SELECT; the anonymous role may do nothing.
--   2. Row level security — enabled, with a single policy: a user sees only rows
--      whose "userId" is their own. Every pre-existing policy is dropped first
--      (policies are OR-ed, so one permissive leftover would defeat this one).
--      No INSERT/UPDATE/DELETE policy exists, so even a privilege granted back
--      by accident denies writes.
--   3. One row per Stripe subscription — a unique index on
--      stripe_subscription_id. Created only when the table holds no duplicates;
--      otherwise skipped with a WARNING, so the rest still applies (clean up,
--      then re-run: this file is idempotent).
--   4. One owner per Stripe customer — a trigger rejects a row that would link a
--      customer to a second user, or move it to another user, and serialises
--      concurrent writers per customer (advisory lock) so two transactions
--      cannot slip past each other's check. The webhook's own merge rule
--      already assumes this; now a mis-entered subscription fails loudly
--      (non-2xx, Stripe retries, the ledger row is rolled back) instead of
--      silently cross-linking two accounts.
--
-- Assumptions are the ones already made elsewhere: the table has the columns
-- stripe_customer_id, stripe_subscription_id, status and "userId". The type of
-- "userId" is read from the catalog (uuid or text) so the policy compares
-- correctly either way. If the table does not exist yet, nothing is done and a
-- NOTICE says so; re-run the migration once it exists.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 4. One owner per Stripe customer (function first: the trigger refers to it).
-- ---------------------------------------------------------------------------
create or replace function public.subscriptions_enforce_customer_owner()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.stripe_customer_id is null or new."userId" is null then
    return new;
  end if;

  -- Serialise per customer (released at commit/rollback). Without this, two
  -- concurrent transactions linking the same customer to different users each
  -- check against a snapshot taken before the other's write, see no conflict,
  -- and both commit. The waiter re-checks after the holder finishes, with a
  -- fresh snapshot (each statement in READ COMMITTED sees committed work).
  -- The key is namespaced so it cannot collide with the webhook function's
  -- per-subscription lock.
  perform pg_advisory_xact_lock(
    hashtextextended('subscriptions_customer_owner:' || new.stripe_customer_id, 0)
  );

  -- Any row of this customer that belongs to a different user — including, on
  -- UPDATE, the row's own previous owner: a customer never changes hands.
  if exists (
    select 1
      from public.subscriptions s
     where s.stripe_customer_id = new.stripe_customer_id
       and s."userId" is not null
       and s."userId"::text <> new."userId"::text
  ) then
    raise exception 'Stripe customer is already linked to a different user'
      using errcode = '23505',  -- unique_violation: the webhook reports it as a persistence failure
            hint = 'One Stripe customer belongs to exactly one user. Check the subscription''s metadata.userId in Stripe.';
  end if;

  return new;
end
$$;

comment on function public.subscriptions_enforce_customer_owner()
  is 'BEFORE INSERT/UPDATE trigger: a Stripe customer is linked to at most one user, and never moves to another.';

revoke execute on function public.subscriptions_enforce_customer_owner() from public, anon, authenticated;

do $$
declare
  v_user_type text;
  v_policy    record;
  v_dupes     bigint;
begin
  if to_regclass('public.subscriptions') is null then
    raise notice 'subscriptions_ownership: public.subscriptions does not exist; nothing secured. Re-run once it exists.';
    return;
  end if;

  select data_type
    into v_user_type
    from information_schema.columns
   where table_schema = 'public' and table_name = 'subscriptions' and column_name = 'userId';

  if v_user_type is null then
    raise exception 'subscriptions_ownership: public.subscriptions has no "userId" column';
  end if;

  -- -------------------------------------------------------------------------
  -- 1. Privileges.
  -- -------------------------------------------------------------------------
  revoke all on table public.subscriptions from public, anon;
  revoke all on table public.subscriptions from authenticated;
  grant select on table public.subscriptions to authenticated;
  grant select, insert, update, delete on table public.subscriptions to service_role;

  -- -------------------------------------------------------------------------
  -- 2. Row level security: owner-only SELECT, nothing else.
  -- -------------------------------------------------------------------------
  alter table public.subscriptions enable row level security;

  for v_policy in
    select policyname from pg_policies where schemaname = 'public' and tablename = 'subscriptions'
  loop
    execute format('drop policy %I on public.subscriptions', v_policy.policyname);
  end loop;

  if v_user_type = 'uuid' then
    create policy subscriptions_select_own on public.subscriptions
      for select to authenticated
      using ("userId" = (select auth.uid()));
  else
    create policy subscriptions_select_own on public.subscriptions
      for select to authenticated
      using ("userId"::text = (select auth.uid())::text);
  end if;

  -- -------------------------------------------------------------------------
  -- 3. One row per Stripe subscription.
  -- -------------------------------------------------------------------------
  select count(*)
    into v_dupes
    from (
      select stripe_subscription_id
        from public.subscriptions
       where stripe_subscription_id is not null
       group by stripe_subscription_id
      having count(*) > 1
    ) duplicates;

  if v_dupes = 0 then
    create unique index if not exists subscriptions_stripe_subscription_id_key
      on public.subscriptions (stripe_subscription_id)
      where stripe_subscription_id is not null;
  else
    raise warning 'subscriptions_ownership: % Stripe subscription id(s) have duplicate rows; the unique index was NOT created. Resolve the duplicates (supabase/README.md) and re-run this migration.', v_dupes;
  end if;

  -- -------------------------------------------------------------------------
  -- 4. Trigger (function defined above). Existing cross-linked customers are
  --    not rejected retroactively, but the next webhook write to one of their
  --    rows will be — say so now rather than let operators find out from 5xxs.
  -- -------------------------------------------------------------------------
  select count(*)
    into v_dupes
    from (
      select stripe_customer_id
        from public.subscriptions
       where stripe_customer_id is not null and "userId" is not null
       group by stripe_customer_id
      having count(distinct "userId"::text) > 1
    ) shared;

  if v_dupes > 0 then
    raise warning 'subscriptions_ownership: % Stripe customer(s) are linked to more than one user. Webhook writes for them will fail until resolved (supabase/README.md).', v_dupes;
  end if;

  drop trigger if exists subscriptions_customer_owner on public.subscriptions;
  create trigger subscriptions_customer_owner
    before insert or update of stripe_customer_id, "userId" on public.subscriptions
    for each row execute function public.subscriptions_enforce_customer_owner();
end
$$;
