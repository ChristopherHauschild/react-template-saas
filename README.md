# React SaaS Template

A personal, open-source SaaS starter built with **Next.js, React, and TypeScript**. It brings together account authentication, a protected dashboard, subscription billing, account settings, activity history, data exports, and customer support requests in a modular codebase.

The goal is to provide a practical foundation for building and extending SaaS products rather than a finished, production-ready service. The project is actively maintained and has a roadmap of additional features, integration work, testing, and reliability improvements.

## What is implemented

| Area                     | Current functionality                                                                                                                                                                     |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Authentication**       | Sign-up and sign-in with Supabase Auth, email confirmation, protected routes, and sign-out.                                                                                               |
| **Dashboard**            | Authenticated account overview, current plan and subscription information, latest invoice, responsive navigation, and command palette.                                                    |
| **Billing**              | Stripe Checkout integration, subscription state handling through webhooks, plan catalog, Customer Portal entry point, invoice history, filtering, pagination, and invoice document links. |
| **Account settings**     | Profile updates, password and email changes, session/security controls, and account activity history.                                                                                     |
| **Data exports**         | Date-filtered CSV downloads for invoices and account activity.                                                                                                                            |
| **Support**              | Submit categorized support requests and review a paginated history of your own requests.                                                                                                  |
| **UI and accessibility** | Responsive dashboard layout, mobile navigation, reusable components, keyboard-oriented interactions, and light/dark styling.                                                              |

**Current scope:** Support is presently a **customer-facing request form and history**, not an agent-operated support inbox. An in-app notification center has **not** been implemented yet. Both are planned extensions (see [Roadmap](#roadmap)).

## Tech stack

- **Application:** Next.js 16 (App Router), React 19, TypeScript
- **UI:** Tailwind CSS 4, shadcn/ui-style components, Radix UI, Lucide icons
- **Authentication and persistence:** Supabase Auth, PostgreSQL, Row Level Security (RLS)
- **Payments:** Stripe Checkout, webhooks, and Customer Portal
- **State and validation:** Zustand, Zod
- **Testing and tooling:** Vitest, React Testing Library, ESLint, Prettier, TypeScript

## Project structure

```text
src/
  app/                  App Router pages, layouts, and route handlers
  config/               Route definitions, environment validation, feature flags
  features/
    auth/                Authentication flows and forms
    billing/             Plans, subscriptions, invoices, and exports
    dashboard/           Account overview, navigation, and shell
    settings/            Profile, security, and account activity UI
    support/             Customer support request submission and history
  infrastructure/        Supabase, Stripe, auth sessions, activity, rate limiting
  shared/                Shared UI, utilities, hooks, and test helpers
  proxy.ts               Supabase session refresh for applicable requests
supabase/
  migrations/            Database schema, access policies, and related changes
  templates/             Authentication email templates
scripts/
  sandbox/               Local stand-ins for development and UI review
  *.sh / *.py / *.mjs    Local setup, checks, and test utilities
```

The application separates feature-oriented UI and business logic from infrastructure integrations. Protected routes use a shared authentication guard, while data access rules are also enforced at the database level where appropriate.

## Get started

**Prerequisites:** Node.js 22 recommended (20+), npm. The demo mode does not need Docker, Supabase credentials, or a Stripe account.

### Option A — Local demo sandbox

This is the fastest way to explore the application without connecting external services:

```bash
npm ci
npm run sandbox
```

Open **http://127.0.0.1:3000/login** and use the simulated account:

```text
Email:    demo@example.com
Password: password123
```

You can then explore `/dashboard`, `/billing`, `/settings`, `/exports`, and `/support`. The sandbox provides fake Supabase/Stripe endpoints and seeded data for selected billing, activity, and support scenarios; its behavior does **not** establish that real providers work end to end. Other demo accounts and failure controls are described in [LOCAL_SETUP.md](./LOCAL_SETUP.md).

> Use `127.0.0.1` consistently in demo mode. Do not use the bundled demo credentials or simulator outside local development.

### Option B — Real local Supabase

For actual sign-up, email confirmation, password changes, and session-management testing, run a local Supabase instance. This requires Docker or another supported container runtime, Python 3 for the environment helper, and PostgreSQL client tools for the local database bootstrap.

```bash
npm ci
npm run preflight
npm run supabase:start
```

Create a local `.env.local` containing `NEXT_PUBLIC_APP_URL=http://127.0.0.1:3000` and placeholder entries for `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, and `SUPABASE_SERVICE_ROLE_KEY`. Then populate those local values and bootstrap the development database:

```bash
npm run env:local
bash scripts/bootstrap-local-db.sh
npm run dev
```

Visit **http://127.0.0.1:3000/signup** and register a disposable test account. The local email catcher is available at `http://127.0.0.1:54324`.

Stripe Checkout, real invoice history, and the Customer Portal require **separate Stripe test-mode credentials and configuration**. Never use live payment keys or real customer data for demos.

For exact environment variables, migrations, billing setup, test accounts, and troubleshooting, read **[LOCAL_SETUP.md](./LOCAL_SETUP.md)**. For technical notes about the consolidated baseline, see [MERGE_SETUP.md](./MERGE_SETUP.md).

## Application routes

| Route                 | Purpose                                     |
| --------------------- | ------------------------------------------- |
| `/login`              | Sign in                                     |
| `/signup`             | Register an account                         |
| `/dashboard`          | Protected account overview                  |
| `/pricing`            | Subscription plans                          |
| `/billing`            | Subscription management and invoice history |
| `/settings`           | Profile, security, and account activity     |
| `/exports`            | CSV data exports                            |
| `/support`            | Submit and track customer support requests  |
| `/auth/callback`      | Authentication confirmation callback        |
| `/api/stripe/webhook` | Signed Stripe webhook endpoint              |

## Development and verification

```bash
npm run dev                 # Next.js development server
npm run sandbox             # App + local simulated services
npm test                    # Unit, component, and regression tests
npm run test:db             # PostgreSQL-backed integration tests (extra setup)
npm run lint               # ESLint
npx tsc --noEmit            # Type checking
npx prettier --check .      # Formatting verification
npm run build -- --webpack  # Production build; network required for Google Fonts
```

The repository includes automated tests for authentication, subscriptions, invoice history, exports, support requests, authorization, and other application behavior. **Passing tests or a successful unmodified production build are not asserted here:** run the checks against your current environment and commit before relying on them. Some integration tests require PostgreSQL server binaries or a disposable test database; see the setup guide.

## Security and development boundaries

- Account pages and server actions require an authenticated session.
- Supabase RLS policies and database constraints restrict access to user-owned records in the relevant tables.
- The billing integration validates server-side plan selections and uses verified Stripe webhook signatures.
- Support requests are user-scoped and subject to database-enforced input and rate limits.
- Server credentials belong in **local environment variables**, never browser code or Git history. The `.gitignore` excludes `.env*` files.
- The sandbox is for local testing only. A production deployment would require its own operational, security, provider-integration, and deployment review.

## Roadmap

React SaaS Template is an actively maintained personal project with approximately **120 hours of planned independent development**. This is an overall planning estimate, not a fixed delivery schedule or a commitment to complete every proposed feature.

A detailed development plan is available in **[ROADMAP.md](./ROADMAP.md)**, including priorities, technical scope, dependencies, implementation considerations, and acceptance criteria.

### Upcoming priorities

**Notification Center**

- In-app notifications for account security and billing events.
- Unread notification counters, paginated history, and read/unread management.
- Integration with existing account activity tracking and Stripe event handling.
- Event deduplication, user isolation, and authorization tests.

**Support Inbox**

- Extend the existing support request system into threaded conversations.
- Authorized support staff inbox with filtering, assignment, and request management.
- Customer and support-agent replies, status tracking, and audit history.
- Server-side authorization and database-level access controls.

### Additional planned improvements

- **Account recovery:** Self-service password recovery with secure email-based verification.
- **Plan entitlements:** Server-enforced feature access based on subscription plans.
- **Billing reliability:** Subscription reconciliation, payment failure recovery, and improved lifecycle handling.
- **Guided onboarding:** Account setup checklist, progress tracking, and improved first-use experience.
- **Account lifecycle:** Secure account deletion and improved data portability.
- **Dashboard insights:** Meaningful account activity, billing, and support indicators based on real application data.
- **Team workspaces:** Optional organization management, member invitations, and role-based permissions.
- **End-to-end testing:** Playwright browser tests and automated GitHub Actions checks.
- **Accessibility:** Keyboard navigation, screen reader support, responsive behavior, and UI improvements.
- **Observability:** Structured error handling, diagnostics, and safe operational logging.
- **Developer experience:** Improved local setup, environment configuration, documentation, and dependency maintenance.

### Development approach

Features will be developed incrementally, building on the existing architecture and reusing implemented functionality whenever possible.

Each development task should include:

- Clearly defined scope and expected behavior.
- Appropriate authentication, authorization, and data isolation.
- Automated tests covering successful and failure scenarios.
- Responsive and accessible user interfaces where applicable.
- Documentation of implementation decisions and known limitations.

Priorities and scope may evolve as the application grows. All roadmap items represent **planned work**, not functionality already implemented.

For detailed task descriptions and completion criteria, see **[Development Roadmap](./ROADMAP.md)**.

## Status and limitations

This repository is a **development baseline**, not a fully deployed commercial SaaS. The demo provides useful UI and contract testing but is not a substitute for live Supabase/Stripe test-mode verification. In particular, the Notification Center and support-agent inbox described in the roadmap are **future features** and are not available in the current application.

## Ownership and license

Created and independently maintained by [Christopher Hauschild Schott](https://github.com/ChristopherHauschild).

Licensed under the **MIT License**. See [LICENSE](./LICENSE).
