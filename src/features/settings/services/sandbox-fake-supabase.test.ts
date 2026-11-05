// @vitest-environment node
/**
 * The sandbox's Supabase stand-in (`scripts/sandbox/fake-supabase.mjs` and
 * `fake-account-activity.mjs`) against the application's REAL code, over
 * HTTP, through the real supabase-js client: the activity export collector,
 * the settings card's reader and the rate limiter. The sandbox is where
 * people try the exports by hand, so it must answer exactly what the app
 * asks — and refuse what it does not understand rather than guess.
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Server } from "node:http";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/infrastructure/auth/supabase/server", () => ({
  createClient: () => {
    throw new Error("the injected client must be used");
  },
}));
vi.mock("@/infrastructure/supabase/admin", () => ({
  createAdminClient: () => {
    throw new Error("the injected client must be used");
  },
}));

import {
  listAccountActivity,
  readAccountActivityPage,
} from "@/infrastructure/account-activity/list-account-activity";
import { consumeRateLimit } from "@/infrastructure/rate-limit/consume-rate-limit";
import { dateRangeBounds } from "@/shared/utils/date-range";

// A plain .mjs development script (typed through allowJs).
import {
  PASSWORD,
  startFakeSupabase,
} from "../../../../scripts/sandbox/fake-supabase.mjs";

import { collectAccountActivityForExport } from "./collect-account-activity-export";

const SERVICE_ROLE_KEY = "sandbox-service-role-key";
const ANON_KEY = "sandbox-anon-key";

let server: Server;
let base: string;
let reads = 0;

type Row = { id: number; event_type: string; details: unknown; occurred_at: string };

/** A user's own client, as the app builds it from the session cookie; counts activity reads. */
async function signIn(
  email: string,
): Promise<{ id: string; token: string; client: SupabaseClient }> {
  const response = await fetch(`${base}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: ANON_KEY, "content-type": "application/json" },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  const session = (await response.json()) as {
    access_token: string;
    user: { id: string };
  };

  const client = createClient(base, ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: {
      headers: { Authorization: `Bearer ${session.access_token}` },
      fetch: (input, init) => {
        if (String(input).includes("/rest/v1/account_activity")) reads++;
        return fetch(input, init);
      },
    },
  });

  return { id: session.user.id, token: session.access_token, client };
}

/** Every row of the user's history in one raw request, newest first: the reference. */
async function everything(client: SupabaseClient, userId: string): Promise<Row[]> {
  const { data, error } = await client
    .from("account_activity")
    .select("id, event_type, details, occurred_at")
    .eq("user_id", userId)
    .order("occurred_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(10_000);
  if (error) throw new Error(error.message);
  return data as Row[];
}

const idsOf = (result: Awaited<ReturnType<typeof collectAccountActivityForExport>>) => {
  if (!result.ok) throw new Error(`expected ok, got ${result.reason}`);
  return result.entries.map((entry) => entry.id);
};

beforeAll(async () => {
  process.env.SUPABASE_SERVICE_ROLE_KEY = SERVICE_ROLE_KEY;
  server = await startFakeSupabase(0);
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no port");
  base = `http://127.0.0.1:${address.port}`;
});

afterAll(() => {
  server?.close();
});

beforeEach(() => {
  reads = 0;
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("sandbox account activity – the real export collector", () => {
  it("pages through huge@example.com's 2,400 entries completely, in order, each once", async () => {
    const { id, client } = await signIn("huge@example.com");
    const reference = await everything(client, id);
    reads = 0;

    const result = await collectAccountActivityForExport(id, { supabase: client });

    expect(reference).toHaveLength(2400);
    expect(idsOf(result)).toEqual(reference.map((row) => row.id));
    // 100 per read: 24 reads, the last one finding nothing beyond it.
    expect(reads).toBe(24);
    // Entries recorded together share a timestamp, to the microsecond.
    const stamps = reference.map((row) => row.occurred_at);
    expect(new Set(stamps).size).toBeLessThan(stamps.length);
    expect(stamps[0]).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}\+00:00$/);
  });

  it("applies a date range exactly, at the edges of UTC days", async () => {
    const { id, client } = await signIn("huge@example.com");
    const reference = await everything(client, id);
    const day = (offset: number) =>
      new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
    const range = { from: day(-400), to: day(-300) };
    const { start, end } = dateRangeBounds(range);

    const result = await collectAccountActivityForExport(id, { supabase: client, range });

    const expected = reference.filter((row) => {
      const t = Date.parse(row.occurred_at);
      return t >= start! && t < end!;
    });
    expect(expected.length).toBeGreaterThan(100); // several pages
    expect(idsOf(result)).toEqual(expected.map((row) => row.id));
  });

  it("keeps demo@example.com's entries this version cannot describe", async () => {
    const { id, client } = await signIn("demo@example.com");

    const result = await collectAccountActivityForExport(id, { supabase: client });

    expect(result).toMatchObject({ ok: true, unrecognised: 2 });
    expect(idsOf(result)).toHaveLength(42);
  });

  it("answers an empty history for empty@example.com", async () => {
    const { id, client } = await signIn("empty@example.com");

    await expect(
      collectAccountActivityForExport(id, { supabase: client }),
    ).resolves.toEqual({
      ok: true,
      entries: [],
      unrecognised: 0,
    });
  });

  it("fails the export for broken@example.com, whose reads fail", async () => {
    const { id, client } = await signIn("broken@example.com");

    await expect(
      collectAccountActivityForExport(id, { supabase: client }),
    ).resolves.toEqual({
      ok: false,
      reason: "read_failed",
    });
  });

  it("emulates row level security: another user's id in the filter reads nothing", async () => {
    const huge = await signIn("huge@example.com");
    const demo = await signIn("demo@example.com");

    await expect(
      collectAccountActivityForExport(huge.id, { supabase: demo.client }),
    ).resolves.toEqual({ ok: true, entries: [], unrecognised: 0 });
  });

  it("serves the settings card's first page too (which leaves out what it cannot describe)", async () => {
    const { id, client } = await signIn("demo@example.com");

    const page = await listAccountActivity(id, { limit: 10, supabase: client });

    // demo's two newest entries are the unrecognised ones: the card shows the
    // other 8 of its first 10 rows (the export keeps all of them, see above).
    expect(page.ok && page.entries.length).toBe(8);
    expect(page.ok && page.nextCursor).toEqual(expect.any(String));
  });
});

describe("sandbox account activity – refuses what the app does not send", () => {
  it.each([
    [
      "an unknown parameter",
      "select=id&user_id=eq.{id}&order=occurred_at.desc,id.desc&x=1",
    ],
    ["another order", "select=id&user_id=eq.{id}&order=id.asc"],
    ["no owner filter", "select=id&order=occurred_at.desc,id.desc"],
    ["an unknown column", "select=secret&user_id=eq.{id}&order=occurred_at.desc,id.desc"],
    [
      "an unsupported range operator",
      "select=id&user_id=eq.{id}&occurred_at=gt.2026-01-01T00:00:00Z&order=occurred_at.desc,id.desc",
    ],
    [
      "a malformed keyset filter",
      "select=id&user_id=eq.{id}&or=(id.lt.5)&order=occurred_at.desc,id.desc",
    ],
  ])("%s → 400", async (_label, query) => {
    const { id, token } = await signIn("demo@example.com");

    const response = await fetch(
      `${base}/rest/v1/account_activity?${query.replace("{id}", id)}`,
      {
        headers: { apikey: ANON_KEY, Authorization: `Bearer ${token}` },
      },
    );

    expect(response.status).toBe(400);
  });

  it("still answers the reader's exact query shape (a sanity check for the list above)", async () => {
    const { id, client } = await signIn("demo@example.com");

    await expect(
      readAccountActivityPage(client, id, { limit: 5 }),
    ).resolves.toMatchObject({
      ok: true,
      hasMore: true,
    });
  });
});

describe("sandbox rate limits – the real limiter", () => {
  const POLICY = { bucket: "export.invoices", burst: 5, intervalSeconds: 60 };
  const serviceRole = () =>
    createClient(base, SERVICE_ROLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    });

  beforeEach(async () => {
    await fetch(`${base}/__sandbox/rate-limits/reset`);
  });

  it("allows five exports, then limits with the wait", async () => {
    const { id } = await signIn("demo@example.com");
    const outcomes = [];
    for (let i = 0; i < 6; i++)
      outcomes.push(await consumeRateLimit(id, POLICY, serviceRole()));

    expect(outcomes.slice(0, 5)).toEqual(Array(5).fill({ outcome: "allowed" }));
    expect(outcomes[5]).toEqual({ outcome: "limited", retryAfterSeconds: 60 });
  });

  it("forgets every allowance on /__sandbox/rate-limits/reset", async () => {
    const { id } = await signIn("demo@example.com");
    for (let i = 0; i < 6; i++) await consumeRateLimit(id, POLICY, serviceRole());

    await fetch(`${base}/__sandbox/rate-limits/reset`);

    await expect(consumeRateLimit(id, POLICY, serviceRole())).resolves.toEqual({
      outcome: "allowed",
    });
  });

  it("refuses a user's own token, like the database (service role only)", async () => {
    const { id, client } = await signIn("demo@example.com");

    await expect(consumeRateLimit(id, POLICY, client)).resolves.toEqual({
      outcome: "unavailable",
    });
  });
});
