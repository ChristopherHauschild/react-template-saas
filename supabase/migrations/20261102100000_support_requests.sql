-- =============================================================================
-- Support requests: messages a signed-in user sends to support.
--
-- The support page lets a user describe a problem and see what they have sent.
-- Each row is one request, owned by the user who sent it. The rules are
-- enforced by the database, because the table is reachable through the REST
-- API with the user's own session token (the one the browser holds), not only
-- through the application:
--
--   1. Ownership   — `user_id` references `auth.users` and defaults to
--                    `auth.uid()`; the history goes away with the account
--                    (ON DELETE CASCADE), like `account_activity`.
--   2. Create      — a signed-in user may INSERT, for themselves only, and may
--                    supply only `category`, `subject` and `message`
--                    (column-level privilege). `id`, `user_id`, `status` and
--                    `created_at` always come from the defaults, so a request
--                    cannot be filed for someone else, backdated, or filed as
--                    already closed. An RLS WITH CHECK (`user_id = auth.uid()`)
--                    backs this up should a column privilege be granted back.
--                    Unlike account activity, no service-role function is
--                    needed: sending a request IS the user's own action, so the
--                    user's token is the right credential for it.
--   3. Read        — a signed-in user SELECTs their own requests only. The
--                    service role may read all of them (support tooling).
--   4. No edits    — nobody (user or service role) holds UPDATE or DELETE and
--                    no policy exists for them: a request cannot be rewritten
--                    after support has read it. Status changes are an operator
--                    task until support tooling exists (grant it then,
--                    column-limited to `status`).
--   5. Anonymous   — nothing. Someone who cannot sign in needs another channel.
--   6. Well-formed — known category and status, non-blank single-line subject,
--                    non-blank bounded message.
--   7. Flood limit — at most 5 requests per user per rolling hour, enforced by
--                    a trigger (the REST API bypasses any application-level
--                    limit). Rejected with SQLSTATE PT429, which PostgREST
--                    returns as HTTP 429.
--
-- See supabase/README.md.
-- =============================================================================

create table public.support_requests (
  id         uuid        primary key default gen_random_uuid(),
  user_id    uuid        not null default auth.uid() references auth.users (id) on delete cascade,
  category   text        not null default 'other',
  subject    text        not null,
  message    text        not null,
  status     text        not null default 'open',
  created_at timestamptz not null default now(),

  constraint support_requests_category_known
    check (category in ('account', 'billing', 'technical', 'other')),
  constraint support_requests_status_known
    check (status in ('open', 'closed')),
  -- "Not blank" = contains a character outside the whitespace set of
  -- JavaScript's String.prototype.trim(), so the database and the form agree
  -- on what is blank. The sets are spelled out instead of [[:space:]] /
  -- [[:cntrl:]], whose meaning depends on the database locale. Lengths are
  -- in characters (the database is UTF8).
  --
  -- The subject is a single line (it ends up in list rows and notification
  -- subjects): no C0 controls, DEL, C1 controls or U+2028/U+2029 separators.
  constraint support_requests_subject_format
    check (subject ~ '[^\t\n\u000b\f\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]'
           and char_length(subject) <= 150
           and subject !~ '[\u0001-\u001f\u007f-\u009f\u2028\u2029]'),
  constraint support_requests_message_format
    check (message ~ '[^\t\n\u000b\f\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]'
           and char_length(message) <= 5000)
);

comment on table  public.support_requests            is 'Requests users send to support, one row per request, owned by the sender.';
comment on column public.support_requests.user_id    is 'The sender (auth.users.id). Set from the session (auth.uid()), never from input.';
comment on column public.support_requests.category   is 'account | billing | technical | other. The application defines the labels.';
comment on column public.support_requests.subject    is 'One-line summary, 1..150 characters, no control characters or line breaks.';
comment on column public.support_requests.message    is 'The request itself, 1..5000 characters.';
comment on column public.support_requests.status     is 'open | closed. Users cannot change it.';
comment on column public.support_requests.created_at is 'Server time the request was received.';

-- A user's requests, newest first; also serves the flood-limit count.
create index support_requests_user_recent_idx
  on public.support_requests (user_id, created_at desc);

-- ---------------------------------------------------------------------------
-- Privileges and row level security.
-- Supabase's default privileges grant ALL on new public tables to
-- anon/authenticated/service_role; start from nothing and grant back.
-- ---------------------------------------------------------------------------
alter table public.support_requests enable row level security;

revoke all on table public.support_requests from public, anon, authenticated, service_role;

grant select                              on table public.support_requests to authenticated;
grant insert (category, subject, message) on table public.support_requests to authenticated;
-- Support tooling may read; it may not rewrite what users sent.
grant select                              on table public.support_requests to service_role;

create policy support_requests_select_own on public.support_requests
  for select to authenticated
  using (user_id = (select auth.uid()));

create policy support_requests_insert_own on public.support_requests
  for insert to authenticated
  with check (user_id = (select auth.uid()));

-- ---------------------------------------------------------------------------
-- Flood limit. SECURITY DEFINER so the count sees every row of the sender
-- regardless of the caller's privileges; `search_path` pinned. Concurrent
-- inserts by one user are serialised (transaction-scoped advisory lock, key
-- namespaced) so parallel requests cannot each see "under the limit".
-- ---------------------------------------------------------------------------
create function public.support_requests_enforce_rate_limit()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_recent integer;
begin
  if new.user_id is null then
    return new;  -- the NOT NULL constraint reports it
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended('support_requests_rate_limit:' || new.user_id::text, 0)
  );

  select count(*)
    into v_recent
    from public.support_requests
   where user_id = new.user_id
     and created_at > now() - interval '1 hour';

  if v_recent >= 5 then
    raise exception 'Too many support requests; try again later'
      using errcode = 'PT429',  -- PostgREST: HTTP 429
            hint = 'At most 5 support requests per hour.';
  end if;

  return new;
end
$$;

comment on function public.support_requests_enforce_rate_limit()
  is 'BEFORE INSERT trigger: at most 5 support requests per user per rolling hour.';

revoke execute on function public.support_requests_enforce_rate_limit() from public, anon, authenticated;

create trigger support_requests_rate_limit
  before insert on public.support_requests
  for each row execute function public.support_requests_enforce_rate_limit();
