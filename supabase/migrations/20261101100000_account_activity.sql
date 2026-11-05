-- =============================================================================
-- Account activity: an append-only, per-user history of account changes.
--
-- The settings page shows users what has changed in their account (profile
-- updates first; email, password and session events to follow). Each row is
-- one event, owned by the user it happened to. The guarantees are enforced by
-- the database, not by the application:
--
--   1. Ownership  — `user_id` references `auth.users`; a row cannot name a user
--                   that does not exist, and the history goes away with the
--                   account (ON DELETE CASCADE).
--   2. Read access — row level security with ONE policy: a signed-in user
--                   SELECTs their own rows. The anonymous role sees nothing.
--   3. Append-only — no role holds INSERT, UPDATE or DELETE on the table, and
--                   there is no policy for them. The only way in is
--                   `record_account_activity(...)`, a SECURITY DEFINER function
--                   that only `service_role` may execute. A user's session
--                   token (the same one a Server Action uses) therefore cannot
--                   add, edit or remove entries, from the browser or anywhere
--                   else: anything exposed to `authenticated` through
--                   /rest/v1/rpc would be callable with that token.
--   4. Well-formed — `event_type` is a dotted lowercase identifier
--                   ("profile.updated"), `details` is a JSON object of bounded
--                   size, and `occurred_at` is set by the server.
--
-- Retention (pruning old rows) is an operator task performed as `postgres`;
-- see supabase/README.md.
-- =============================================================================

create table public.account_activity (
  id          bigint      generated always as identity primary key,
  user_id     uuid        not null references auth.users (id) on delete cascade,
  event_type  text        not null,
  details     jsonb       not null default '{}'::jsonb,
  occurred_at timestamptz not null default now(),

  -- "segment.segment[.segment…]", lowercase, e.g. profile.updated
  constraint account_activity_event_type_format
    check (event_type ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$' and length(event_type) <= 64),
  constraint account_activity_details_object
    check (jsonb_typeof(details) = 'object'),
  -- Generous for "what changed" payloads; stops a bug from storing blobs.
  constraint account_activity_details_size
    check (octet_length(details::text) <= 4096)
);

comment on table  public.account_activity             is 'Append-only history of account changes, one row per event, owned by the user it happened to.';
comment on column public.account_activity.user_id     is 'The account the event belongs to (auth.users.id).';
comment on column public.account_activity.event_type  is 'Dotted lowercase identifier, e.g. profile.updated. The application defines the catalogue.';
comment on column public.account_activity.details     is 'Event-specific JSON object (what changed). Schema per event_type is defined by the application.';
comment on column public.account_activity.occurred_at is 'Server time the event was recorded.';

-- Newest-first listing for one user; `id` breaks ties within a timestamp.
create index account_activity_user_recent_idx
  on public.account_activity (user_id, occurred_at desc, id desc);

-- ---------------------------------------------------------------------------
-- Privileges and row level security.
-- Supabase's default privileges grant ALL on new public tables and sequences to
-- anon/authenticated/service_role; start from nothing and grant back SELECT.
-- ---------------------------------------------------------------------------
alter table public.account_activity enable row level security;

revoke all on table    public.account_activity        from public, anon, authenticated, service_role;
revoke all on sequence public.account_activity_id_seq from public, anon, authenticated, service_role;

grant select on table public.account_activity to authenticated;
-- Reading (e.g. support tooling) is harmless for the service role; writing is
-- not granted so that even a service-role bug cannot rewrite history.
grant select on table public.account_activity to service_role;

create policy account_activity_select_own on public.account_activity
  for select to authenticated
  using (user_id = (select auth.uid()));

-- ---------------------------------------------------------------------------
-- The one write path. SECURITY DEFINER: runs with the privileges of its owner
-- (the migration role, which owns the table), so callers need no table
-- privilege at all. `search_path` is pinned so the unqualified names inside
-- cannot be hijacked. Returns the new row's id.
-- ---------------------------------------------------------------------------
create function public.record_account_activity(
  p_user_id    uuid,
  p_event_type text,
  p_details    jsonb default '{}'::jsonb
)
returns bigint
language sql
security definer
set search_path = ''
as $$
  insert into public.account_activity (user_id, event_type, details)
  values (p_user_id, p_event_type, coalesce(p_details, '{}'::jsonb))
  returning id
$$;

comment on function public.record_account_activity(uuid, text, jsonb)
  is 'Appends one account activity event for a user. service_role only: the application calls it after verifying the user''s session.';

-- Postgres grants EXECUTE to PUBLIC on new functions, and Supabase's default
-- privileges add anon/authenticated. Only the service role may record events.
revoke execute on function public.record_account_activity(uuid, text, jsonb) from public, anon, authenticated;
grant  execute on function public.record_account_activity(uuid, text, jsonb) to service_role;
