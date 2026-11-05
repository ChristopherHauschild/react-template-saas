// @vitest-environment node
/**
 * Static contract of `supabase/migrations/*_account_activity.sql`, so the unit
 * suite (no database) notices if the statements the application relies on
 * disappear. The behaviour itself is proven in
 * `account-activity.integration.test.ts` against a real PostgreSQL.
 */
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  ACCOUNT_ACTIVITY_DETAILS_MAX_BYTES,
  ACCOUNT_ACTIVITY_EVENT_SCHEMA,
  ACCOUNT_ACTIVITY_EVENT_TYPE_PATTERN,
  ACCOUNT_ACTIVITY_TABLE,
  RECORD_ACCOUNT_ACTIVITY_RPC,
} from "./events";

const MIGRATIONS_DIR = path.resolve(__dirname, "../../../supabase/migrations");

async function migration() {
  const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith(".sql")).sort();
  const file = files.find((f) => /_account_activity\.sql$/.test(f));
  if (!file) throw new Error("account activity migration missing");

  return { file, sql: await readFile(path.join(MIGRATIONS_DIR, file), "utf8") };
}

describe("account activity migration", () => {
  it("creates the table the reader queries, owned by auth users, with server time", async () => {
    const { sql } = await migration();

    expect(sql).toMatch(
      new RegExp(`create table public\\.${ACCOUNT_ACTIVITY_TABLE} \\(`),
    );
    expect(sql).toMatch(
      /user_id\s+uuid\s+not null references auth\.users \(id\) on delete cascade/,
    );
    expect(sql).toMatch(/occurred_at timestamptz not null default now\(\)/);
    expect(sql).toMatch(/details\s+jsonb\s+not null default '\{\}'::jsonb/);
  });

  it("enforces the same event-type format and details size the TypeScript side assumes", async () => {
    const { sql } = await migration();

    // The regex literal in SQL is the one the catalogue exports.
    expect(sql).toContain(`event_type ~ '${ACCOUNT_ACTIVITY_EVENT_TYPE_PATTERN.source}'`);
    expect(sql).toContain(
      `octet_length(details::text) <= ${ACCOUNT_ACTIVITY_DETAILS_MAX_BYTES}`,
    );
    expect(sql).toMatch(/jsonb_typeof\(details\) = 'object'/);
  });

  it("locks the table down: RLS, owner-only SELECT, no writes for anyone, nothing for anon", async () => {
    const { sql } = await migration();

    expect(sql).toMatch(/alter table public\.account_activity enable row level security/);
    expect(sql).toMatch(
      /revoke all on table\s+public\.account_activity\s+from public, anon, authenticated, service_role/,
    );
    expect(sql).toMatch(
      /revoke all on sequence public\.account_activity_id_seq from public, anon, authenticated, service_role/,
    );
    expect(sql).toMatch(
      /grant select on table public\.account_activity to authenticated/,
    );
    expect(sql).toMatch(/grant select on table public\.account_activity to service_role/);
    // Reads only: no insert/update/delete is granted back to any role.
    expect(sql).not.toMatch(/^\s*grant (insert|update|delete|all)/im);
    expect(sql).toMatch(
      /create policy account_activity_select_own on public\.account_activity\s+for select to authenticated\s+using \(user_id = \(select auth\.uid\(\)\)\)/,
    );
    // Only a SELECT policy exists: writes are denied even if a privilege comes back.
    expect(sql).not.toMatch(/for (insert|update|delete|all) to/i);
  });

  it("exposes one append-only write path, executable by the service role alone", async () => {
    const { sql } = await migration();
    const signature = `public\\.${RECORD_ACCOUNT_ACTIVITY_RPC}\\(uuid, text, jsonb\\)`;

    expect(sql).toMatch(
      new RegExp(
        `create function public\\.${RECORD_ACCOUNT_ACTIVITY_RPC}\\(\\s*p_user_id\\s+uuid,\\s*p_event_type text,\\s*p_details\\s+jsonb default '\\{\\}'::jsonb\\s*\\)`,
      ),
    );
    expect(sql).toMatch(/security definer\s+set search_path = ''/);
    expect(sql).toMatch(
      new RegExp(
        `revoke execute on function ${signature} from public, anon, authenticated`,
      ),
    );
    expect(sql).toMatch(
      new RegExp(`grant\\s+execute on function ${signature} to service_role`),
    );
  });
});

describe("account activity catalogue", () => {
  it("only names event types the database accepts", () => {
    const types = ACCOUNT_ACTIVITY_EVENT_SCHEMA.options.map((o) => o.shape.type.value);

    expect(types).toEqual(
      expect.arrayContaining([
        "profile.updated",
        "password.changed",
        "sessions.others_signed_out",
        "email.change_requested",
        "email.changed",
      ]),
    );
    for (const type of types) {
      expect(type, type).toMatch(ACCOUNT_ACTIVITY_EVENT_TYPE_PATTERN);
      expect(type.length).toBeLessThanOrEqual(64);
    }
  });

  it("never stores a password: no event's details admit one", () => {
    for (const option of ACCOUNT_ACTIVITY_EVENT_SCHEMA.options) {
      const keys = Object.keys(option.shape.details.shape);
      expect(keys.join(" ")).not.toMatch(/password|secret|token/i);
    }
  });
});
