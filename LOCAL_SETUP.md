# React SaaS Template — local setup and reviewer guide

This is a Next.js/React/TypeScript SaaS application with existing sign-up, login,
protected dashboard, **Settings** (profile, password, email confirmation,
session management and server-recorded account activity), **Billing** (subscriptions,
Stripe Customer Portal, invoice history, filters, pagination and invoice documents),
**Exports** (CSV downloads of invoices and account activity, with date filters),
and **Support** (submit requests and review request history).

There are **two local testing modes**:

- **Demo billing mode (`npm run sandbox`)**: requires no Docker, Supabase account or
  Stripe account. Uses simulated services and predetermined demo users. Best for
  reviewing invoice UI, filters, paging, PDF links, error and ownership states, and
  the CSV exports (with a seeded, read-only account activity history).
- **Full auth mode (local Supabase)**: requires Docker or a supported container
  engine, and is necessary for real sign-up, email verification, password
  changes and session-management testing. Real Stripe features additionally
  require your own **Stripe test-mode** credentials.

The supplied `.env.local` is intentionally filled with **placeholders**, not
production credentials. The file is included solely to make the required
variables discoverable; don't deploy or publish it as credentials.

## 1. Prerequisites

- Node.js **22** recommended (20+) and npm. Git is optional.
- For full auth mode only: Python 3 (`npm run env:local` uses it to write the local
  keys into `.env.local`; without it, copy them from `npx supabase status` by hand).
- Internet access for the initial `npm ci` and for the Google Fonts download
  performed by `next/font/google` in a normal production build.
- For full auth mode: Docker/Podman capable of running the Supabase CLI stack;
  PostgreSQL client (`psql`) to create the sample subscriptions table.
- For PostgreSQL integration tests (`npm run test:db`): the PostgreSQL **server**
  binaries `initdb`/`pg_ctl` (Debian/Ubuntu: `apt install postgresql`; they are found
  under `/usr/lib/postgresql/*/bin` automatically), or a disposable PostgreSQL
  connection supplied through `TEST_DATABASE_URL`. Running as **root** (a container,
  CI, `sudo`) is supported: PostgreSQL refuses to run as root, so the script starts
  the throwaway server as `$SUDO_USER`, else the `postgres` system account, else
  `nobody` — or as the user named in `WITH_LOCAL_POSTGRES_USER`.

From the **extracted project root**:

```bash
npm ci
```

If installation fails, fix npm registry/network access before trying to run tests
or the application. No `node_modules` is shipped in the archive.

## 2. Quick demo: sign in and review Billing (no external services)

```bash
npm run sandbox
```

Open **http://127.0.0.1:3000/login** (use `127.0.0.1`, not `localhost`).

| Demo login         | Password      | What to try                                               |
| ------------------ | ------------- | --------------------------------------------------------- |
| `demo@example.com` | `password123` | Invoice list, filters, pagination, documents              |
| `huge@example.com` | `password123` | Large invoice history; search and "Search older invoices" |
| any of the above   | `password123` | `/exports`: invoice and account activity CSV downloads    |

Ten pre-seeded accounts are printed by the `npm run sandbox` command, including
empty, drafts-only, unavailable and ambiguous-customer scenarios. The simulator
exposes runtime failure toggles at **http://127.0.0.1:4242/__sandbox**.

Useful flows after signing in: visit `/billing`, filter by status and dates, search
for an invoice number, use "Load more" / "Search older invoices", and open the
"View" and "PDF" document links. Try a narrow browser viewport (375 / 768 / 1024px)
and keyboard-only navigation. The PDF is simulated, not a real Stripe document.

**Exports (`/exports`).** Both downloads run unmocked against the stand-ins. The
Supabase stand-in seeds an **account activity** history per account (read-only):
`demo` has ~40 entries of every kind, including two the app cannot describe (listed
as "Unrecognised activity") and display names that look like spreadsheet formulas;
`huge` has 2,400 entries over two years (many pages, entries sharing a timestamp);
`empty` has none; reading `broken`'s history fails; everyone else has a few. The
same data appears in the Account activity card on `/settings`.

Invoice exports are **rate limited** per user: five at once, then one a minute
(the sixth in a row shows a countdown on the page, and the route answers `429`
with `Retry-After`). To try again at once, reset every allowance with
**http://127.0.0.1:54321/__sandbox/rate-limits/reset** and reload `/exports`.

**Support (`/support`).** The demo account starts with twelve older support requests;
use **Load older requests** to exercise paging. New requests are added to the demo
table; the five-per-hour request limit is enforced in the demo. The real
`support_requests` row-level security, column permissions, and constraints live in
`supabase/migrations/20261102100000_support_requests.sql` and are covered by
PostgreSQL integration tests. Expired sessions and account switching require a real
Supabase environment to validate end to end.

The `/dashboard` account overview reads each account's plan from the simulated
subscription: `demo` is on Pro, `canceled` on Pro (ended), `drafts` on Pro but
canceled in "Stripe" a moment ago while the records still say active (what the
dashboard shows in the seconds before the webhook lands), `huge` on Pro and set
to cancel in two weeks, `empty` on Pro with a discount, `ambiguous` on Enterprise,
`other` on a price outside the catalog ("unrecognized"), `broken` cannot be read,
`unknown` does not exist in "Stripe", and `free` has no subscription. Because the
sandbox configures catalog prices, `/pricing` shows live Subscribe buttons; they
lead to an unreachable Stripe URL and never create a subscription.

**Important:** the simulator emulates only the endpoints needed for Billing, the
exports, reading account activity and selected authentication. **Do not use this
mode to validate the Settings email, password or session flows.** It does not prove real Supabase Auth or Stripe
compatibility. Stop with Ctrl-C.

## 3. Full local authentication (real Supabase)

Run these in the project root **instead of** the demo sandbox (both use port 54321):

```bash
npm run preflight
npm run supabase:start
npm run env:local
bash scripts/bootstrap-local-db.sh
npm run dev
```

`npm run supabase:start` starts the configured local Supabase stack. `npm run
env:local` reads keys from `supabase status -o env` and updates only the matching
Supabase lines in `.env.local`, preserving your other settings. This avoids having
to paste secrets into a shared file. Restart `npm run dev` after changing env vars.

`bootstrap-local-db.sh` creates the minimal **local-only** `subscriptions` table
and re-applies the ownership migration. It expects the local PostgreSQL service
at `127.0.0.1:54322`, user `postgres`, password `postgres`; it is **not** for
remote databases. It can be skipped for profile/password/email-only testing.

Open these local addresses:

| URL                             | Purpose                                                      |
| ------------------------------- | ------------------------------------------------------------ |
| http://127.0.0.1:3000/signup    | Register a test user                                         |
| http://127.0.0.1:3000/login     | Sign in                                                      |
| http://127.0.0.1:3000/dashboard | Protected dashboard                                          |
| http://127.0.0.1:3000/settings  | Profile, password, email, security, account activity         |
| http://127.0.0.1:3000/billing   | Billing (real Stripe test keys required for invoice content) |
| http://127.0.0.1:3000/exports   | CSV exports (invoices need Stripe test keys, as above)       |
| http://127.0.0.1:3000/support   | Submit and review support requests                           |
| http://127.0.0.1:54324          | Supabase local mail catcher (confirmation emails)            |
| http://127.0.0.1:54323          | Supabase Studio (Authentication → Users)                     |

For the **Account activity** feature, apply the migration
`supabase/migrations/20261101100000_account_activity.sql` to the local Supabase
project if it was not already applied by the Supabase CLI. The table and RPC
require a functioning Auth schema. (The sandbox of section 2 serves a seeded,
read-only history instead.)

**Support** requires `supabase/migrations/20261102100000_support_requests.sql` to be
applied in full auth mode; the demo service emulates its access rules but cannot
replace real database RLS checks.

**Invoice exports** also need `supabase/migrations/20261105120000_rate_limits.sql`
(applied by `supabase start` / `supabase db push`): the export checks each user's
allowance in the database before calling Stripe, and refuses to export (503) if it
cannot — it never calls Stripe unchecked.

### How to enter an authenticated session

1. Open `/signup` and register a **new disposable test address** and password.
2. Find the confirmation message at `http://127.0.0.1:54324` and open its link.
   The callback establishes the browser session; you should land on `/dashboard`.
3. Open `/settings`. Change the profile name and reload; verify it persists, and that
   the **Account activity** card at the bottom lists the change (old and new name).
   Make more than ten changes to see **Load older activity**.
4. For password changes, provide the current and new passwords, then sign out and
   verify that only the new password signs in. For session revocation, sign in
   from two different browsers or one normal and one private window, then use
   the Settings **Security** card to revoke other sessions.
5. For email changes, submit a different test address in Settings. The local
   config enables `double_confirm_changes = true`, so open **both** confirmation
   messages in the mail catcher. The address should remain pending until both
   links have been processed. Test an expired/reused link and the resend action.

Security banners use a short-lived signed, HttpOnly cookie. Manually entering
`/settings?emailChange=confirmed` must **not** produce a success message.
There is no shared demo login for this mode: create your own local test account.

If using a hosted **test** Supabase project instead, manually set the URL and
keys in `.env.local`, add `http://127.0.0.1:3000/auth/callback` to redirect URLs,
and configure the custom email-change template in
`supabase/templates/email_change.html` in the Supabase dashboard.

To stop the stack:

```bash
npm run supabase:stop
```

## 4. Stripe test-mode Billing (optional, real Stripe API)

The local simulated invoices in section 2 require no credentials. For **real**
Stripe test-mode invoices and Customer Portal, keep full local Supabase running
and replace these placeholders in `.env.local` with values from **your own test
account**:

```dotenv
STRIPE_SECRET_KEY=sk_test_YOUR_TEST_SECRET
STRIPE_WEBHOOK_SECRET=whsec_YOUR_TEST_WEBHOOK_SECRET
STRIPE_PRICE_PRO=
STRIPE_PRICE_ENTERPRISE=
STRIPE_INVOICE_DOCUMENT_HOSTS=
```

Use prices from your Stripe **test** product catalog if you want to exercise
paid checkout. The invoice history and customer portal require a user-to-Stripe
customer link. Example workflow (replace the email with your **local test user**):

```bash
npm run seed:invoices -- --create-customer test@example.com
bash scripts/link-local-customer.sh test@example.com cus_REPLACE_WITH_RETURNED_ID canceled
npm run seed:invoices -- --customer cus_REPLACE_WITH_RETURNED_ID --issued 25 --drafts 12
npm run dev
```

Do not use a real person's Stripe account; these scripts create test objects and
may incur API rate limits. The billing page checks the authenticated user's
customer ownership through local subscription rows. Reproduce "no customer" by
signing in with an account without any rows, or test an ambiguous customer by
adding a second row with a different test customer.

The Stripe webhook handler lives at `/api/stripe/webhook` if you separately
configure Stripe CLI forwarding. The simulator does not exercise checkout,
webhooks or Customer Portal; these require Stripe test mode.

## 5. Verification commands (for developers and reviewers)

```bash
npm test                    # Vitest unit/regression suites
npm run test:db             # PostgreSQL-backed integration suites (see prerequisites)
npm run lint                # ESLint
npx tsc --noEmit            # TypeScript
npx prettier --check .      # Formatting
npm run build -- --webpack  # Production build (needs Google Fonts network access)
```

`npm run build` downloads the Inter font from Google Fonts; without network access it
fails with `Failed to fetch Inter from Google Fonts`. To check that everything else
compiles offline, temporarily replace the `next/font/google` import in
`src/app/layout.tsx` with a stub (`const inter = { variable: "" };`), build, and
restore the file — that checks compilation, not the unmodified build.

The two completed features were tested separately before consolidation. **The test
counts from those sessions are not totals for this merged tree.** After merging,
run the whole test suite again. The production build in the supplied
source tasks was also verified with a **temporary Google Fonts stub**, because
the sandbox could not download fonts. **Do not report an unchanged build as
passing unless it really does.**

The scripts under `scripts/sandbox/` are a development aid. They are not a
substitute for independent provider verification or security review.
