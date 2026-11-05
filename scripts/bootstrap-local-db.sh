#!/usr/bin/env bash
# Development only. Operates on Supabase CLI's local Postgres at 127.0.0.1:54322.
set -euo pipefail
cd "$(dirname "$0")/.."
command -v psql >/dev/null || { echo 'psql not found. Install PostgreSQL client.' >&2; exit 1; }
export PGPASSWORD=postgres
PSQL=(psql -X -v ON_ERROR_STOP=1 -h 127.0.0.1 -p 54322 -U postgres -d postgres)
"${PSQL[@]}" -f scripts/bootstrap-local-subscriptions.sql
# The ownership migration deliberately no-ops if the table was absent when the
# initial Supabase migrations ran; applying it again after the table exists
# installs RLS, privileges, the unique index, and owner trigger.
"${PSQL[@]}" -f supabase/migrations/20261031120000_subscriptions_ownership.sql
echo 'Local subscriptions baseline ready; inspect warnings and use Stripe TEST keys.'
