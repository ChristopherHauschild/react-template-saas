// @vitest-environment node
/**
 * Static contract of `supabase/migrations/*_subscriptions_ownership.sql`, so the
 * unit suite (no database) notices if the statements the application relies on
 * disappear. The behaviour itself is proven in
 * `subscriptions-ownership.integration.test.ts` against a real PostgreSQL.
 */
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

const MIGRATIONS_DIR = path.resolve(__dirname, "../../../../supabase/migrations");

async function ownershipMigration() {
  const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith(".sql")).sort();
  const file = files.find((f) => /_subscriptions_ownership\.sql$/.test(f));
  if (!file) throw new Error("ownership migration missing");

  return { file, files, sql: await readFile(path.join(MIGRATIONS_DIR, file), "utf8") };
}

describe("subscriptions ownership migration", () => {
  it("runs after the webhook migrations it protects", async () => {
    const { file, files } = await ownershipMigration();

    const webhookMigrations = files.filter((f) => /_stripe_/.test(f));
    expect(webhookMigrations).toHaveLength(2);
    for (const earlier of webhookMigrations) {
      expect(files.indexOf(file)).toBeGreaterThan(files.indexOf(earlier));
    }
  });

  it("locks the table down: RLS, owner-only SELECT, no writes for users, nothing for anon", async () => {
    const { sql } = await ownershipMigration();

    expect(sql).toMatch(/alter table public\.subscriptions enable row level security/);
    expect(sql).toMatch(/revoke all on table public\.subscriptions from public, anon/);
    expect(sql).toMatch(/revoke all on table public\.subscriptions from authenticated/);
    expect(sql).toMatch(/grant select on table public\.subscriptions to authenticated/);
    expect(sql).toMatch(
      /create policy subscriptions_select_own on public\.subscriptions\s+for select to authenticated/,
    );
    // Only a SELECT policy exists: writes are denied even if a privilege comes back.
    expect(sql).not.toMatch(/for (insert|update|delete|all) to/i);
    // Leftover policies are removed, not merely added to (policies are OR-ed).
    expect(sql).toMatch(/drop policy %I on public\.subscriptions/);
  });

  it('adapts the policy to the stored type of "userId" (uuid or text)', async () => {
    const { sql } = await ownershipMigration();

    expect(sql).toMatch(/"userId" = \(select auth\.uid\(\)\)/);
    expect(sql).toMatch(/"userId"::text = \(select auth\.uid\(\)\)::text/);
  });

  it("enforces one row per subscription and one owner per customer", async () => {
    const { sql } = await ownershipMigration();

    expect(sql).toMatch(
      /create unique index if not exists subscriptions_stripe_subscription_id_key\s+on public\.subscriptions \(stripe_subscription_id\)\s+where stripe_subscription_id is not null/,
    );
    expect(sql).toMatch(
      /create trigger subscriptions_customer_owner\s+before insert or update of stripe_customer_id, "userId" on public\.subscriptions/,
    );
    expect(sql).toMatch(
      /raise exception 'Stripe customer is already linked to a different user'/,
    );
    // Concurrent writers for one customer are serialised before the check.
    expect(sql).toMatch(
      /pg_advisory_xact_lock\(\s*hashtextextended\('subscriptions_customer_owner:' \|\| new\.stripe_customer_id, 0\)/,
    );
  });

  it("degrades safely: no table → notice; duplicates or shared customers → warning, never an abort of the lockdown", async () => {
    const { sql } = await ownershipMigration();

    expect(sql).toMatch(
      /if to_regclass\('public\.subscriptions'\) is null then\s+raise notice/,
    );
    expect(sql).toMatch(/raise warning .*duplicate rows/);
    expect(sql).toMatch(/raise warning .*linked to more than one user/);
  });
});
