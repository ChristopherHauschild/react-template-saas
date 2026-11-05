# React SaaS Template — Development Roadmap

This document captures **proposed future work**, not features that already exist. React SaaS Template is a personal, open-source starter for developing SaaS applications, built around Next.js, React, TypeScript, Supabase, and Stripe.

The broader plan represents approximately **120 hours of independent development**. That is an overall planning estimate, **not** a fixed delivery schedule, an allocation per feature, or a claim that every item below will be implemented. Priorities will change with technical discoveries and actual product needs.

## Existing foundation (November 2026)

Before implementing anything new, prefer to extend the code that already exists:

- **Auth and account:** signup, email confirmation, sign-in/out, protected routes, profile/password/email changes, session controls, and recorded account activity.
- **Dashboard:** authenticated account overview, subscription and latest-invoice summary, responsive navigation, and command palette.
- **Billing:** server-side plan catalog, Stripe Checkout, webhook-driven subscription lifecycle, Customer Portal, invoice history, filters, documents, pagination, and CSV export.
- **Support:** customer-facing request form and paginated history, server-side validation, user ownership, database RLS, and a submission rate limit.
- **Data and testing:** Supabase migrations, invoice/activity CSV exports, unit/component tests, PostgreSQL integration tests, and an optional demo sandbox with simulated services.

**Not implemented yet:** in-app notification history, staff-operated support inbox, threaded support messages, password recovery while signed out, server-enforced plan feature entitlements, organization/workspace membership, or a comprehensive browser E2E pipeline. The existing Support page is not a staff helpdesk.

## Prioritization and task design

| Priority | Meaning |
| --- | --- |
| **P0** | Best next candidates; direct extension of existing functionality with clear user value |
| **P1** | Product completeness: account lifecycle, monetization, reliability and useful daily workflows |
| **P2** | Platform maturity: scalability, accessibility, testing, maintainability and optional expansion |

Complexity uses **S / M / L** (focused / multi-layer / larger feature). These are relative scopes, **not hours approved for payment**. Large features should be broken into independently reviewable changes.

For every proposed task, begin with the user-facing problem, inspect the current behavior, define a narrow deliverable, then validate success and failure paths. Prefer realistic fixtures and observable outcomes; avoid invented metrics, unnecessary rewrites and unsupported “all tests pass” claims.

## P0 — Recommended next development

### NC-01 — In-App Notification Center

**Complexity:** L, delivered incrementally  
**Why it matters:** Security and billing events exist, but users cannot find important changes or keep track of unread events in one place.

**Build on:** account activity event recording, successful auth actions, Stripe lifecycle handlers, dashboard shell.

**Suggested increments:**

1. Introduce a per-user notification schema, constrained event types, and an event-to-notification mapping. Generate a notification only **after** the originating operation succeeds.
2. Reuse existing account-activity and billing sources. Deduplicate by a stable event/source identifier, including webhook retries and concurrent workers; do not copy sensitive provider payloads into notifications.
3. Add paginated history, accurate unread count, mark-as-read/unread actions, and safe deep links to settings and billing.
4. Integrate a small accessible entry point into the dashboard, with loading, empty, unavailable, and mobile states. Real-time delivery can follow later.

**Acceptance criteria:**

- Successful password/email or billing changes generate a notification for the correct account; failed actions do not generate false successes.
- Replayed Stripe events and repeated requests cannot create duplicate records.
- A user cannot read, mutate, enumerate, or infer another account's notifications, including through direct action/API calls.
- Unread counts and pagination remain correct after concurrent mutations and newly added records.
- Unit, database-authorization, and UI tests cover both success and negative scenarios.

**Likely code:** `src/infrastructure/account-activity/`, `src/features/auth/`, `src/features/billing/services/handle-stripe-webhook-event.ts`, `src/features/dashboard/`, `supabase/migrations/`.

**Not in the initial scope:** email/push delivery, marketing messages, raw audit/event payload exposure.

### SI-01 — Staff Support Inbox and Resolution Workflow

**Complexity:** L, delivered incrementally  
**Why it matters:** Users can submit and view requests, but no authorized operator can triage, assign or reply to them within the application.

**Build on:** existing `support_requests` schema, customer request flow, authenticated routes and RLS policies.

**Suggested increments:**

1. Define server-managed support-staff authorization and permissions, separate from user-editable profile metadata. Extend the database safely without granting regular users new write access to operator-owned fields.
2. Add an authenticated, staff-only inbox: filters, paging, assignment, priority, state changes and a record of who performed each operation.
3. Extend requests to threaded conversations, including public staff replies and clearly isolated internal staff notes; keep existing requests readable after migration.
4. Extend the customer Support page to view replies and post follow-ups, and connect reply events to notifications when NC-01 exists.

**Acceptance criteria:**

- Regular users can access only their own requests and customer-visible replies; internal notes and staff identifiers stay private as designed.
- Guessing another user's request ID or calling a staff action directly never bypasses authorization.
- Assignment, status changes and replies have a reliable audit trail; retries and racing updates do not silently overwrite history.
- Existing request history, validation and request-rate limits remain functional.
- Tests explicitly exercise customer, staff and unauthorized roles, at both action and database levels.

**Likely code:** `src/features/support/`, `src/app/(protected)/(dashboard)/support/`, `src/infrastructure/auth/`, `supabase/migrations/20261102100000_support_requests.sql` (extend with a new migration).

**Not in the initial scope:** live chat, third-party helpdesk integrations, AI-generated replies.

## P1 — Product features with clear practical value

### AR-01 — Password Recovery and Account Re-entry

**Complexity:** M  
**Gap:** Password change while signed in exists, but “forgot password” for signed-out users is not implemented.

**Proposal:** Add request-reset and new-password screens using Supabase recovery links; handle expired, invalid and reused links, sessions and safe redirect destinations. Keep public responses neutral so addresses cannot be enumerated.

**Done when:** a valid recovery flow works end to end; obsolete links cannot change a password; invalid input and network failures are handled; access is never granted through an unverified redirect. Cover with auth and browser tests.

**Likely code:** `src/features/auth/`, `src/app/(auth)/`, `src/app/auth/callback/`.

### PE-01 — Enforced Plan Entitlements and Usage Gates

**Complexity:** M/L  
**Gap:** Starter, Pro and Enterprise plans advertise capabilities, but feature access needs a trusted, reusable policy layer.

**Proposal:** Define typed entitlements, determine effective access from server-verified subscription state and apply enforcement to relevant server actions and data reads. Start with one real example capability and clear states for free, canceled, past-due, unknown-plan and temporarily unavailable billing.

**Done when:** neither a hidden button nor a forged server-action request bypasses a paid gate; plan changes yield the correct access; stale/unavailable billing data does not silently grant paid access; tests cover every supported state.

**Likely code:** `src/features/billing/services/plan-catalog.ts`, `src/features/billing/services/get-subscription-overview.ts`, `src/config/featureFlags.ts`.

### BR-01 — Billing Reconciliation and Failed-payment Recovery

**Complexity:** M/L  
**Gap:** Webhook idempotency and subscription synchronization already exist; missed or delayed events, failed payments and long-running inconsistencies still need operational recovery.

**Proposal:** Audit the current handler before adding anything. Implement a safe reconciliation path for a specific owned customer/subscription, user-facing recovery states and a deployable strategy for periodic checks if needed. Avoid an in-memory timer as a substitute for scheduled infrastructure.

**Done when:** retries and out-of-order updates do not leave permanently wrong entitlements; a missed provider event can be reconciled without crossing account boundaries; users see actionable payment failure states; tests cover delayed, canceled and recovered subscriptions.

**Likely code:** `src/app/api/stripe/webhook/`, `src/features/billing/services/handle-stripe-webhook-event.ts`, `src/features/billing/services/current-plan.ts`.

### ON-01 — Guided Onboarding and Meaningful Empty States

**Complexity:** M  
**Gap:** A new account has a functional dashboard but limited guidance on completing its setup.

**Proposal:** Add a lightweight, dismissible checklist using **actual account state**, such as confirmed email, completed profile and chosen plan. Provide first-use guidance for settings and support, without fabricated engagement/revenue numbers.

**Done when:** progress survives refresh and reflects authoritative data; no unchecked requirement is reported complete; returning users see appropriate states; accessible mobile and keyboard flows are tested.

**Likely code:** `src/features/dashboard/`, `src/features/auth/`, `src/features/settings/`.

### AL-01 — Account Closure and Data Portability

**Complexity:** L  
**Gap:** Invoice/activity exports exist, but the complete self-service account lifecycle does not.

**Proposal:** Document which records belong to an account and which Stripe or Supabase records need special handling. Add a guarded, confirmed account deletion/closure workflow; define retention and partial-failure behavior; build on existing export features rather than duplicating them.

**Done when:** a user cannot close anyone else's account, retries cannot cause inconsistent destructive actions, provider cleanup and retention rules are explicit, and the UI reports the actual outcome. This feature alone is not a claim of regulatory compliance.

**Likely code:** `src/features/settings/`, `src/features/billing/`, `src/infrastructure/auth/`, `supabase/migrations/`.

### DI-01 — Useful Account Insights from Existing Records

**Complexity:** M  
**Gap:** Dashboard billing summaries exist, but a user's recent security/support activity is scattered across pages.

**Proposal:** Add grounded indicators such as recent account changes, own open support requests and invoice/subscription status, with direct links to each source. Only add charts when they make sense for real available data.

**Done when:** metrics can be reproduced from source records, empty/error states are truthful, aggregates cannot expose another user, and no fake analytics series are presented as production information.

**Likely code:** `src/features/dashboard/`, `src/infrastructure/account-activity/`, `src/features/support/`, `src/features/billing/`.

## P2 — Reliability, maintainability and long-term reuse

### OR-01 — Optional Team Workspaces, Membership and Invites

**Complexity:** L, architectural  
**Value:** Many SaaS products need teams, but the current template assumes a personal account.

**Proposal:** Introduce optional workspaces, invitations and owner/admin/member roles. Decide explicitly which data remains personal versus workspace-owned. Keep customer workspace roles separate from support-staff privileges.

**Done when:** invitations, member removal and role changes are enforced in server access checks and RLS; users cannot cross workspaces by changing IDs; legacy single-account behavior remains supported.

**Likely code:** `src/infrastructure/auth/`, `src/features/settings/`, `src/features/dashboard/`, `supabase/migrations/`.

### QA-01 — Playwright Browser Tests and CI

**Complexity:** M  
**Gap:** There is meaningful Vitest/PostgreSQL coverage, but no comprehensive versioned browser E2E suite or established PR validation pipeline.

**Proposal:** Introduce deterministic Playwright tests for login, protected redirects, dashboard navigation, invoices, exports and support using the sandbox where appropriate. Add GitHub Actions checks for install, lint, typecheck, tests and build, isolating PostgreSQL prerequisites.

**Done when:** a clean checkout can reproduce the checks; reports and browser traces are available without secrets; critical desktop/mobile journeys are covered; CI identifies failures rather than silently skipping checks.

**Likely code:** `package.json`, `scripts/sandbox/`, `src/app/`, new `tests/e2e/` and `.github/workflows/`.

### AX-01 — Accessibility and Responsive UX Review

**Complexity:** M  
**Gap:** The UI is responsive, but continued feature growth increases the chance of regressions in keyboard, focus and narrow-screen behavior.

**Proposal:** Audit the navigation drawer, command palette, forms, invoice filters, pagination, dialogs, status announcements and typical mobile/tablet breakpoints. Fix observed issues rather than redesigning speculatively.

**Done when:** tested flows work without a mouse; focus remains visible and is restored appropriately; error/status messages are accessible; content avoids horizontal overflow and includes regression coverage.

**Likely code:** `src/features/dashboard/components/`, `src/features/billing/components/`, `src/features/settings/components/`, `src/shared/components/ui/`.

### OB-01 — Diagnostics and Privacy-safe Observability

**Complexity:** M  
**Gap:** Critical operations log failures, but debugging cross-service incidents is harder without consistent error categories and correlation identifiers.

**Proposal:** Introduce structured server-side diagnostics and correlation IDs for auth, billing and support, with a small failure taxonomy. Record no tokens, passwords, raw support messages or sensitive payment details. Document alert-worthy failure classes.

**Done when:** simulated provider failures can be followed through a request; logs distinguish expected errors from faults; retries are visible; there is no sensitive-data leakage in recorded fields.

**Likely code:** `src/infrastructure/`, `src/features/auth/`, `src/features/billing/`, `src/features/support/`, `scripts/sandbox/`.

### DX-01 — First-run Setup and Dependency Hygiene

**Complexity:** S/M  
**Gap:** Setup instructions exist, but fresh-clone configuration is multi-step, and the public tree does not currently provide a tracked `.env.example`.

**Proposal:** Add a placeholder-only `.env.example` and allow it through `.gitignore` while excluding real environment files. Verify bootstrap and preflight scripts on a clean checkout, document provider-specific limitations and review dependency advisories with regression checks.

**Done when:** a newcomer can run sandbox mode from README alone; full-auth prerequisites and failures are actionable; no actual secret is committed or printed; applicable checks pass after dependency changes.

**Likely code:** `README.md`, `LOCAL_SETUP.md`, `scripts/configure-local-supabase.py`, `scripts/preflight-local.sh`, `package.json`, `.gitignore`.

## Proposed sequence

1. **NC-01 first:** notification persistence and deduplication, then read state/paging, then dashboard integration.
2. **SI-01 second:** staff authorization and schema, then inbox controls, then threaded replies and customer history.
3. Choose smaller **P1** improvements (such as password recovery or onboarding) when they are more useful than extending a large feature.
4. Apply **QA, AX and DX** improvements when related issues are discovered; do not postpone regression testing until the entire roadmap is finished.
5. Consider **OR-01** only when multi-tenant requirements justify changing the project's account ownership model.

## Definition of done for a roadmap item

- A demonstrable user problem is addressed, with clear in-scope and out-of-scope behavior.
- User-owned data is protected by server/database authorization; cross-account denial is tested where relevant.
- Retries, stale sessions, invalid input, empty states and provider failures have explicit outcomes.
- The implementation reuses established services and migrations where practical.
- Desktop/mobile layout, keyboard access and actionable feedback are considered.
- Relevant tests are **actually run** and reported with remaining limitations; no unverified success claims.
- The change is traceable through normal commits and focused documentation.

## Technical references

These are design references, not evidence that proposed features already exist:

- [Supabase: Row Level Security](https://supabase.com/docs/guides/database/postgres/row-level-security)
- [Supabase: Custom Claims and Role-based Access Control](https://supabase.com/docs/guides/api/custom-claims-and-role-based-access-control-rbac)
- [Next.js: Authentication and authorization](https://nextjs.org/docs/app/guides/authentication)
- [Stripe: resilient webhook processing](https://stripe.dev/blog/building-resilient-webhook-handlers-aws-dlqs-stripe-events)
- [Playwright: Continuous Integration](https://playwright.dev/docs/ci)
- [OWASP: Application Security Verification Standard](https://asvs.owasp.org/)

---

This is a living plan, not a contractual backlog or a record of approved paid sessions.
