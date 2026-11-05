-- =============================================================================
-- Rate limits: per-user allowances for expensive operations, enforced in the
-- database so that every server instance shares them.
--
-- The first user is the invoice export, which may make up to a hundred Stripe
-- requests per click; nothing stopped a user (or a script holding their
-- session) from repeating it. An in-memory counter would not do: each server
-- instance — and each serverless cold start — would keep its own, so the real
-- limit would grow with the number of instances and reset on every deploy.
--
-- Algorithm: GCRA (the "generic cell rate algorithm", a token bucket that
-- needs no background refill). Each (user, bucket) keeps one timestamp, the
-- theoretical arrival time `tat`. With an emission interval T and a burst B,
-- a request at `now` is allowed when `tat - now <= T * (B - 1)`, and then
-- moves `tat` to `max(tat, now) + T`. So B requests may come at once, and one
-- more every T after that. A refused request changes nothing and is told how
-- long until one would be allowed.
--
-- The guarantees, as in the other migrations, are the database's:
--   1. Atomic  — the row is locked for the decision (`for update`), so
--                concurrent requests are decided one after another, each on
--                the previous one's result: B parallel requests get B slots,
--                never more.
--   2. Private — row level security with NO policy, and no privilege for any
--                API role: nobody can read, reset or forge a row through the
--                REST API. The only way in is `consume_rate_limit(...)`, which
--                only `service_role` may execute (the application calls it
--                after verifying the user's session).
--   3. Bounded — one row per user and bucket, removed with the user.
-- =============================================================================

create table public.rate_limits (
  user_id uuid        not null references auth.users (id) on delete cascade,
  -- "segment[.segment…]", lowercase, e.g. export.invoices
  bucket  text        not null,
  tat     timestamptz not null,

  primary key (user_id, bucket),

  constraint rate_limits_bucket_format
    check (bucket ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$' and length(bucket) <= 64)
);

comment on table  public.rate_limits        is 'Per-user allowances for expensive operations (GCRA). Written only by consume_rate_limit().';
comment on column public.rate_limits.bucket is 'What is limited, e.g. export.invoices. The application defines the buckets and their policies.';
comment on column public.rate_limits.tat    is 'Theoretical arrival time: when the allowance will be fully refilled.';

alter table public.rate_limits enable row level security;

-- Supabase's default privileges grant ALL on new public tables to the API
-- roles; take everything back. No policy is created: RLS then denies all rows.
revoke all on table public.rate_limits from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- The one entry point. SECURITY DEFINER (runs as the table's owner), with a
-- pinned search_path. Returns one row: whether the request is allowed and, if
-- not, how many whole seconds until it would be (at least 1).
-- ---------------------------------------------------------------------------
create function public.consume_rate_limit(
  p_user_id          uuid,
  p_bucket           text,
  p_interval_seconds integer,
  p_burst            integer
)
returns table (allowed boolean, retry_after_seconds integer)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_interval  interval;
  v_tolerance interval;
  v_tat       timestamptz;
  v_now       timestamptz;
begin
  if p_user_id is null or p_bucket is null then
    raise exception 'consume_rate_limit: user and bucket are required' using errcode = '22004';
  end if;
  if p_interval_seconds is null or p_interval_seconds < 1 or p_interval_seconds > 86400 then
    raise exception 'consume_rate_limit: interval must be 1..86400 seconds' using errcode = '22023';
  end if;
  if p_burst is null or p_burst < 1 or p_burst > 1000 then
    raise exception 'consume_rate_limit: burst must be 1..1000' using errcode = '22023';
  end if;

  v_interval  := make_interval(secs => p_interval_seconds);
  v_tolerance := v_interval * (p_burst - 1);

  -- First use of the bucket: a row that allows the full burst. A concurrent
  -- first use waits on the primary key, then does nothing.
  insert into public.rate_limits (user_id, bucket, tat)
  values (p_user_id, p_bucket, '-infinity')
  on conflict (user_id, bucket) do nothing;

  select r.tat into v_tat
    from public.rate_limits r
   where r.user_id = p_user_id and r.bucket = p_bucket
     for update;

  -- The time is read AFTER the lock is held: a request that waited for
  -- another is decided on when it is actually decided.
  v_now := clock_timestamp();
  v_tat := greatest(v_tat, v_now);

  if v_tat - v_now > v_tolerance then
    allowed := false;
    retry_after_seconds := greatest(
      1,
      ceil(extract(epoch from (v_tat - v_tolerance - v_now)))::integer
    );
    return next;
    return;
  end if;

  update public.rate_limits
     set tat = v_tat + v_interval
   where user_id = p_user_id and bucket = p_bucket;

  allowed := true;
  retry_after_seconds := 0;
  return next;
end
$$;

comment on function public.consume_rate_limit(uuid, text, integer, integer)
  is 'Takes one request from a user''s allowance for a bucket (GCRA: burst p_burst, one more every p_interval_seconds). service_role only.';

revoke execute on function public.consume_rate_limit(uuid, text, integer, integer) from public, anon, authenticated;
grant  execute on function public.consume_rate_limit(uuid, text, integer, integer) to service_role;
