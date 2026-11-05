# React SaaS Template

A Next.js / React / TypeScript SaaS project with Supabase authentication,
account Settings, Stripe billing, invoice history, CSV exports of invoices and
account activity, a Support Center, and a responsive dashboard.

**Start with [LOCAL_SETUP.md](./LOCAL_SETUP.md)** for local setup and reviewer
instructions: how to log into the demo billing sandbox, create a real Supabase
test account, configure Stripe test mode, and run the verification checks.

For a short summary of the project merge and its limitations, see
[MERGE_SETUP.md](./MERGE_SETUP.md).

Quick development commands (after following the setup guide):

```bash
npm ci
npm run sandbox       # demo login + simulated billing, no Docker
# OR
npm run supabase:start
npm run env:local
npm run dev           # real local Supabase auth
```

Never use live Stripe credentials or a production Supabase project for demos.
The included `.env.local` contains placeholder credentials only.
