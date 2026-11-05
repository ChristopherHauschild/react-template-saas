import type { SupabaseClient } from "@supabase/supabase-js";
import { randomBytes } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import pg from "pg";

/**
 * Helpers for integration tests that run against a REAL PostgreSQL server.
 *
 * Set `TEST_DATABASE_URL` to a superuser connection string (e.g. the one printed
 * by `supabase start`, or a scratch cluster from `scripts/with-local-postgres.sh`).
 * Each test file provisions its own throwaway database and drops it afterwards, so
 * nothing in the target cluster is touched beyond role creation.
 */

export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

const ROOT = path.resolve(__dirname, "../../..");
export const MIGRATIONS_DIR = path.join(ROOT, "supabase/migrations");

export type TestDatabase = {
  /** Connection pool to the throwaway database (superuser). */
  pool: pg.Pool;
  name: string;
  /** Drops the database. */
  destroy: () => Promise<void>;
};

/** Creates an empty throwaway database on the cluster behind `TEST_DATABASE_URL`. */
export async function createTestDatabase(adminUrl: string): Promise<TestDatabase> {
  const name = `test_${Date.now()}_${randomBytes(3).toString("hex")}`;

  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`create database ${name}`);
  await admin.end();

  const url = new URL(adminUrl);
  url.pathname = `/${name}`;
  const pool = new pg.Pool({ connectionString: url.toString(), max: 20 });
  // `destroy()` force-drops the database right after `pool.end()`, which can
  // terminate a client whose socket is still closing. Such a client emits
  // 'error' with nobody left to listen, which would crash the worker.
  pool.on("error", () => {});

  return {
    pool,
    name,
    destroy: async () => {
      await pool.end();
      const cleaner = new pg.Client({ connectionString: adminUrl });
      await cleaner.connect();
      await cleaner.query(`drop database if exists ${name} with (force)`);
      await cleaner.end();
    },
  };
}

/**
 * Reproduces the parts of a Supabase database that the migration's privilege
 * handling depends on: the API roles, and the default privileges that expose new
 * `public` objects to them. Roles are cluster-wide and created only if missing
 * (a `supabase start` cluster already has them).
 */
export async function emulateSupabaseRoles(pool: pg.Pool) {
  await pool.query(`
    -- Roles are cluster-wide and test files run in parallel workers: two of
    -- them can pass the "not exists" check together, so a loser's CREATE ROLE
    -- is tolerated rather than failing the suite.
    do $$
    begin
      begin
        if not exists (select 1 from pg_roles where rolname = 'anon') then
          create role anon nologin;
        end if;
      exception when duplicate_object or unique_violation then null;
      end;
      begin
        if not exists (select 1 from pg_roles where rolname = 'authenticated') then
          create role authenticated nologin;
        end if;
      exception when duplicate_object or unique_violation then null;
      end;
      begin
        if not exists (select 1 from pg_roles where rolname = 'service_role') then
          create role service_role nologin bypassrls;
        end if;
      exception when duplicate_object or unique_violation then null;
      end;
    end $$;
    grant usage on schema public to anon, authenticated, service_role;
    alter default privileges in schema public grant all on tables    to anon, authenticated, service_role;
    alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
    alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;

    -- Supabase's auth.uid(): the JWT "sub" claim PostgREST puts into the
    -- request settings. Both the old per-claim setting and the newer claims
    -- object are honoured, like the real implementation.
    create schema if not exists auth;
    create or replace function auth.uid() returns uuid
    language sql stable
    as $fn$
      select coalesce(
        nullif(current_setting('request.jwt.claim.sub', true), ''),
        nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'
      )::uuid
    $fn$;
    grant usage on schema auth to anon, authenticated, service_role;
    grant execute on function auth.uid() to anon, authenticated, service_role;

    -- STAND-IN for Supabase's auth.users, reduced to what migrations reference
    -- (the primary key). Tests insert the ids they use as users.
    create table if not exists auth.users (id uuid primary key);
  `);
}

/** Registers users in the stand-in `auth.users` so rows may reference them. */
export async function createTestUsers(pool: pg.Pool, ids: string[]) {
  for (const id of ids) {
    await pool.query("insert into auth.users (id) values ($1) on conflict do nothing", [
      id,
    ]);
  }
}

/**
 * Runs `sql` the way PostgREST would for a request: inside a transaction, as
 * `role`, with the JWT `sub` claim set (so `auth.uid()` and RLS apply). Resolves
 * with the rows, or rejects with the database error (e.g. `code: "42501"`).
 */
export async function queryAs(
  pool: pg.Pool,
  role: "anon" | "authenticated" | "service_role",
  userId: string | null,
  sql: string,
  params: unknown[] = [],
): Promise<pg.QueryResult> {
  const conn = await pool.connect();

  try {
    await conn.query("begin");
    await conn.query(`set local role ${role}`);
    await conn.query("select set_config('request.jwt.claim.sub', $1, true)", [
      userId ?? "",
    ]);
    const result = await conn.query(sql, params);
    await conn.query("commit");
    return result;
  } catch (error) {
    await conn.query("rollback").catch(() => {});
    throw error;
  } finally {
    conn.release();
  }
}

/**
 * STAND-IN for the application's pre-existing `subscriptions` table, which is not
 * managed by any migration in this repository and whose real definition could not
 * be inspected. It has the four columns the application writes, plus an id with a
 * default and a uuid `"userId"` to exercise type conversion.
 */
export async function createStandInSubscriptionsTable(pool: pg.Pool) {
  await pool.query(`
    create table public.subscriptions (
      id uuid primary key default gen_random_uuid(),
      stripe_customer_id text,
      stripe_subscription_id text,
      status text,
      "userId" uuid
    );
  `);
}

/** Applies every `supabase/migrations/*.sql` file in filename (timestamp) order. */
export async function applyMigrations(pool: pg.Pool, filter?: (file: string) => boolean) {
  const files = (await readdir(MIGRATIONS_DIR))
    .filter((f) => f.endsWith(".sql") && (filter?.(f) ?? true))
    .sort();

  for (const file of files) {
    await pool.query(await readFile(path.join(MIGRATIONS_DIR, file), "utf8"));
  }

  return files;
}

export type RpcCall = { fn: string; params: Record<string, unknown> };

/**
 * Adapts the `supabase.rpc(fn, params)` surface onto a direct Postgres connection,
 * mimicking what PostgREST does for a service-role request: one transaction,
 * `set local role service_role`, then `select fn(named => args)`. Resolves with
 * `{ data, error }` like supabase-js and never rejects.
 *
 * `role` can be overridden to test what other API roles are allowed to do.
 */
export function createPgRpcClient(pool: pg.Pool, role = "service_role") {
  const calls: RpcCall[] = [];

  const client = {
    async rpc(fn: string, params: Record<string, unknown> = {}) {
      calls.push({ fn, params });

      const conn = await pool.connect();
      const keys = Object.keys(params);
      const sql = `select public.${fn}(${keys.map((k, i) => `${k} => $${i + 1}`).join(", ")}) as result`;

      try {
        await conn.query("begin");
        await conn.query(`set local role ${role}`);
        const result = await conn.query(
          sql,
          keys.map((k) => params[k]),
        );
        await conn.query("commit");

        return {
          data: result.rows[0]?.result ?? null,
          error: null,
          count: null,
          status: 200,
          statusText: "OK",
        };
      } catch (error) {
        await conn.query("rollback").catch(() => {});
        const e = error as pg.DatabaseError;

        return {
          data: null,
          error: { message: e.message, code: e.code, details: e.detail, hint: e.hint },
          count: null,
          status: 400,
          statusText: "Bad Request",
        };
      } finally {
        conn.release();
      }
    },
  };

  return { client: client as unknown as SupabaseClient, calls };
}
