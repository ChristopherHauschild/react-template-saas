#!/usr/bin/env bash
# DEVELOPMENT ONLY. Links a local Supabase user to a Stripe TEST customer by
# inserting one row into public.subscriptions on the Supabase CLI's local
# Postgres (127.0.0.1:54322) — the row the billing page's ownership rule reads.
#
#   bash scripts/link-local-customer.sh <user email> <cus_…> [status]
#
# `status` defaults to `active` (the billing page shows an active subscription
# and the Manage-billing button; the pricing page refuses a second checkout).
# Use `canceled` to keep checkout available while still listing invoices.
#
# The same script can be used to REPRODUCE the refusals:
#   link the user to a second customer  → "more than one billing account" (ambiguous)
# Delete the rows to start over:
#   psql -h 127.0.0.1 -p 54322 -U postgres -c "delete from public.subscriptions where \"userId\" = '<uuid>'"
set -euo pipefail
cd "$(dirname "$0")/.."

email="${1:-}"
customer="${2:-}"
status="${3:-active}"

if [[ -z "$email" || -z "$customer" ]]; then
  echo "usage: bash scripts/link-local-customer.sh <user email> <cus_…> [status]" >&2
  exit 1
fi
if [[ ! "$customer" =~ ^cus_[A-Za-z0-9]+$ ]]; then
  echo "'$customer' is not a Stripe customer id (cus_…)" >&2
  exit 1
fi
case "$status" in
  active|trialing|past_due|unpaid|paused|incomplete|incomplete_expired|canceled) ;;
  *) echo "'$status' is not a Stripe subscription status" >&2; exit 1 ;;
esac
command -v psql >/dev/null || { echo 'psql not found. Install the PostgreSQL client.' >&2; exit 1; }

export PGPASSWORD=postgres
PSQL=(psql -X -v ON_ERROR_STOP=1 -h 127.0.0.1 -p 54322 -U postgres -d postgres -q)

# A unique, clearly fake subscription id: the table has a unique index on it and
# the billing page only ever reads its status, never sends it to Stripe.
subscription="sub_local_$(date +%s)_$RANDOM"

# psql interpolates :'var' only in scripts read from stdin (not with -c), and
# never inside dollar-quoted blocks, hence the plain statements below.
uid="$("${PSQL[@]}" -At -v email="$email" <<'SQL'
select id from auth.users where email = :'email';
SQL
)"

if [[ -z "$uid" ]]; then
  echo "No local user with email '$email'. Sign up at http://127.0.0.1:3000/signup and confirm the email first." >&2
  exit 1
fi

"${PSQL[@]}" -v uid="$uid" -v customer="$customer" -v status="$status" -v sub="$subscription" <<'SQL'
insert into public.subscriptions (stripe_customer_id, stripe_subscription_id, status, "userId")
values (:'customer', :'sub', :'status', :'uid'::uuid);
SQL

echo "Linked $email ($uid) to $customer with status '$status'. Open http://127.0.0.1:3000/billing."
