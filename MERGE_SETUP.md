# Combined SaaS baseline — Support + Data Export

Start with **[LOCAL_SETUP.md](./LOCAL_SETUP.md)** for environment and verification
instructions. This is a single project intended as the base for subsequent
Code Behaviors tasks.

The project includes sign-up and session management, authenticated dashboard,
account Settings and Account Activity, Stripe subscription/billing and invoices,
CSV Data Export (`/exports`), and Support request submission/history (`/support`).
The routes share the existing dashboard navigation and authentication guard.

**Archive content:** source, tests, lockfile, migrations, setup documentation,
`.gitignore`, placeholder-only `.env.local` and `.env.example`, and the fake
service configuration in `scripts/sandbox/sandbox.env`. There is no repository
history, `node_modules` or generated build output. **Do not use the supplied
placeholder credentials against a real service.**

**Local verification:** run `npm ci`, `npm test`, `npm run test:db`, `npm run lint`,
`npx tsc --noEmit`, and `npx prettier --check .` with dependencies installed.
`npm run sandbox` launches development stand-ins for invoices, account activity,
rate limits and support. For full Supabase Auth/RLS and Stripe behaviour, use
separate real test services and apply all migrations in order.

The unmodified production build downloads a Google font, so it may require
network access. Do not claim the merged project passed a complete build or test
run unless you actually ran those checks.
