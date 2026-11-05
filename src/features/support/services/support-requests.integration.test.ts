// @vitest-environment node
/**
 * INTEGRATION TESTS — run against a real PostgreSQL server.
 *
 * What `supabase/migrations/*_support_requests.sql` guarantees about
 * `public.support_requests`, exercised the way PostgREST runs a request (API
 * role + JWT subject, see `queryAs`):
 *
 * - create: a signed-in user, for themselves, supplying only category, subject
 *   and message; never for someone else, never with a chosen status/time/id;
 * - read:   a signed-in user sees only their own requests; the service role
 *   sees all; the anonymous role sees nothing;
 * - nobody updates or deletes;
 * - rows are well-formed and the application's input schema agrees with the
 *   database about what is valid;
 * - at most 5 requests per user per hour, also under concurrency.
 *
 * Skipped unless TEST_DATABASE_URL is set. Run with `npm run test:db`.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  applyMigrations,
  createTestDatabase,
  createTestUsers,
  emulateSupabaseRoles,
  queryAs,
  TEST_DATABASE_URL,
  type TestDatabase,
} from "@/shared/test/postgres";

import {
  NEW_SUPPORT_REQUEST_SCHEMA,
  SUPPORT_REQUEST_CATEGORIES,
  SUPPORT_REQUEST_INSERTABLE_COLUMNS,
  SUPPORT_REQUEST_MESSAGE_MAX_LENGTH,
  SUPPORT_REQUEST_RATE_LIMIT,
  SUPPORT_REQUEST_RATE_LIMITED_CODE,
  SUPPORT_REQUEST_STATUSES,
  SUPPORT_REQUEST_SUBJECT_MAX_LENGTH,
} from "./support-request";

const ALICE = "11111111-1111-4111-8111-111111111111";
const BOB = "22222222-2222-4222-8222-222222222222";
const CAROL = "44444444-4444-4444-8444-444444444444";
/** A valid token subject with no account behind it (e.g. a deleted user's JWT). */
const GHOST = "33333333-3333-4333-8333-333333333333";

type Role = "anon" | "authenticated" | "service_role";

const INSERT = `insert into public.support_requests (category, subject, message)
                values ($1, $2, $3) returning *`;
const LIST = `select id, user_id::text as user_id, category, subject, message, status, created_at
                from public.support_requests order by created_at, subject`;

const expectDenied = (promise: Promise<unknown>) =>
  expect(promise).rejects.toMatchObject({ code: "42501" });
const expectCheckViolation = (promise: Promise<unknown>) =>
  expect(promise).rejects.toMatchObject({ code: "23514" });

describe.skipIf(!TEST_DATABASE_URL)("support requests (real PostgreSQL)", () => {
  let db: TestDatabase;

  /** Sends a request the way the support form will: as the user, three columns. */
  const send = (
    user: string | null,
    fields: { category?: string; subject?: string; message?: string } = {},
    role: Role = "authenticated",
  ) =>
    queryAs(db.pool, role, user, INSERT, [
      fields.category ?? "technical",
      fields.subject ?? "Export is stuck",
      fields.message ?? "The CSV export has been spinning for an hour.",
    ]);

  /** Inserts directly as the table owner (bypasses privileges, RLS and defaults). */
  const seed = (user: string, subject: string, extra: Record<string, unknown> = {}) => {
    const columns = { user_id: user, subject, message: "seeded", ...extra };
    const keys = Object.keys(columns);
    return db.pool.query(
      `insert into public.support_requests (${keys.join(", ")})
       values (${keys.map((_, i) => `$${i + 1}`).join(", ")}) returning id`,
      Object.values(columns),
    );
  };

  beforeAll(async () => {
    db = await createTestDatabase(TEST_DATABASE_URL!);
    await emulateSupabaseRoles(db.pool);
    await applyMigrations(db.pool);
    await createTestUsers(db.pool, [ALICE, BOB, CAROL]);
  });

  afterAll(async () => {
    await db.destroy();
  });

  afterEach(async () => {
    await db.pool.query("delete from public.support_requests");
  });

  it("runs on a UTF8 database, like Supabase (lengths are in characters)", async () => {
    const { rows } = await db.pool.query("show server_encoding");
    expect(
      rows[0].server_encoding,
      "TEST_DATABASE_URL must point at a UTF8 cluster; see scripts/with-local-postgres.sh",
    ).toBe("UTF8");
  });

  describe("creating a request", () => {
    it("a signed-in user creates one for themselves; owner, status and time come from the server", async () => {
      const before = Date.now();
      const { rows } = await send(ALICE, {
        category: "billing",
        subject: "Charged twice",
        message: "I see two charges for March.",
      });

      // RETURNING works under the SELECT policy (supabase-js `.insert().select()`).
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        id: expect.stringMatching(/^[0-9a-f-]{36}$/),
        user_id: ALICE,
        category: "billing",
        subject: "Charged twice",
        message: "I see two charges for March.",
        status: "open",
      });
      expect(new Date(rows[0].created_at).getTime()).toBeGreaterThanOrEqual(
        before - 1000,
      );
    });

    it("the category defaults to 'other' when the form does not send one", async () => {
      const { rows } = await queryAs(
        db.pool,
        "authenticated",
        ALICE,
        `insert into public.support_requests (subject, message) values ('Hi', 'Hello') returning category`,
      );
      expect(rows[0].category).toBe("other");
    });

    it.each([
      ["another user's id", "user_id", BOB],
      ["their own id (the server sets it)", "user_id", ALICE],
      ["a status", "status", "closed"],
      ["a creation time (backdating)", "created_at", "2020-01-01T00:00:00Z"],
      ["an id", "id", "99999999-9999-4999-8999-999999999999"],
    ])("a signed-in user cannot supply %s", async (_label, column, value) => {
      await expectDenied(
        queryAs(
          db.pool,
          "authenticated",
          ALICE,
          `insert into public.support_requests (${column}, subject, message) values ($1, 'S', 'M')`,
          [value],
        ),
      );
      expect((await db.pool.query(LIST)).rows).toEqual([]);
    });

    it("the anonymous role cannot create a request", async () => {
      await expectDenied(send(null, {}, "anon"));
      // Not even with a subject in the claims: the role is what counts.
      await expectDenied(send(ALICE, {}, "anon"));
    });

    it("a token without a subject cannot create a request (no owner)", async () => {
      await expect(send(null)).rejects.toMatchObject({
        code: expect.stringMatching(/^(42501|23502)$/),
      });
      expect((await db.pool.query(LIST)).rows).toEqual([]);
    });

    it("a token for a user that no longer exists cannot create a request", async () => {
      await expect(send(GHOST)).rejects.toMatchObject({ code: "23503" });
    });

    it("the service role cannot create requests (it is not a user)", async () => {
      await expectDenied(send(null, {}, "service_role"));
    });

    it("even if INSERT on user_id were granted back, the policy refuses a request for someone else", async () => {
      // Defence in depth: simulate a privilege handed back by accident, inside
      // a transaction that is rolled back so nothing leaks into other tests.
      const conn = await db.pool.connect();
      try {
        await conn.query("begin");
        await conn.query(
          "grant insert (user_id) on public.support_requests to authenticated",
        );
        await conn.query("set local role authenticated");
        await conn.query("select set_config('request.jwt.claim.sub', $1, true)", [ALICE]);

        await expect(
          conn.query(
            `insert into public.support_requests (user_id, subject, message) values ($1, 'S', 'M')`,
            [ALICE],
          ),
        ).resolves.toMatchObject({ rowCount: 1 });

        await expect(
          conn.query(
            `insert into public.support_requests (user_id, subject, message) values ($1, 'S', 'M')`,
            [BOB],
          ),
        ).rejects.toMatchObject({
          code: "42501",
          message: expect.stringMatching(/row-level security/),
        });
      } finally {
        await conn.query("rollback").catch(() => {});
        conn.release();
      }
      expect(
        (
          await db.pool.query(
            `select has_column_privilege('authenticated', 'public.support_requests', 'user_id', 'INSERT') as granted`,
          )
        ).rows[0].granted,
      ).toBe(false);
    });
  });

  describe("reading requests", () => {
    it("a signed-in user reads only their own requests", async () => {
      await send(ALICE, { subject: "Alice 1" });
      await send(ALICE, { subject: "Alice 2" });
      await send(BOB, { subject: "Bob 1" });

      const alice = await queryAs(db.pool, "authenticated", ALICE, LIST);
      expect(alice.rows.map((r) => r.subject)).toEqual(["Alice 1", "Alice 2"]);

      const bob = await queryAs(db.pool, "authenticated", BOB, LIST);
      expect(bob.rows.map((r) => r.subject)).toEqual(["Bob 1"]);

      // Asking for someone else's rows explicitly returns nothing rather than an error.
      const probe = await queryAs(
        db.pool,
        "authenticated",
        BOB,
        `select id from public.support_requests where user_id = $1`,
        [ALICE],
      );
      expect(probe.rows).toEqual([]);
    });

    it("a token without a subject reads nothing rather than everything", async () => {
      await send(ALICE);
      const nobody = await queryAs(db.pool, "authenticated", null, LIST);
      expect(nobody.rows).toEqual([]);
    });

    it("the anonymous role cannot read requests at all", async () => {
      await send(ALICE);
      await expectDenied(queryAs(db.pool, "anon", null, LIST));
      await expectDenied(queryAs(db.pool, "anon", ALICE, LIST));
    });

    it("the service role (support tooling) reads every request", async () => {
      await send(ALICE, { subject: "Alice 1" });
      await send(BOB, { subject: "Bob 1" });

      const all = await queryAs(db.pool, "service_role", null, LIST);
      expect(all.rows.map((r) => r.subject).sort()).toEqual(["Alice 1", "Bob 1"]);
    });
  });

  describe("changing requests", () => {
    it("a signed-in user cannot update or delete — not even their own requests", async () => {
      await send(ALICE, { subject: "Original" });

      await expectDenied(
        queryAs(
          db.pool,
          "authenticated",
          ALICE,
          `update public.support_requests set subject = 'Rewritten'`,
        ),
      );
      await expectDenied(
        queryAs(
          db.pool,
          "authenticated",
          ALICE,
          `update public.support_requests set status = 'closed'`,
        ),
      );
      await expectDenied(
        queryAs(db.pool, "authenticated", ALICE, `delete from public.support_requests`),
      );

      const rows = (await db.pool.query(LIST)).rows;
      expect(rows).toMatchObject([{ subject: "Original", status: "open" }]);
    });

    it("the service role cannot update or delete either", async () => {
      await send(ALICE);

      await expectDenied(
        queryAs(
          db.pool,
          "service_role",
          null,
          `update public.support_requests set status = 'closed'`,
        ),
      );
      await expectDenied(
        queryAs(db.pool, "service_role", null, `delete from public.support_requests`),
      );
      expect((await db.pool.query(LIST)).rows).toHaveLength(1);
    });

    it("even if UPDATE/DELETE were granted back, no policy lets a user touch a row", async () => {
      await send(ALICE);

      const conn = await db.pool.connect();
      try {
        await conn.query("begin");
        await conn.query(
          "grant update, delete on public.support_requests to authenticated",
        );
        await conn.query("set local role authenticated");
        await conn.query("select set_config('request.jwt.claim.sub', $1, true)", [ALICE]);

        const updated = await conn.query(
          `update public.support_requests set status = 'closed'`,
        );
        const deleted = await conn.query(`delete from public.support_requests`);
        expect(updated.rowCount).toBe(0);
        expect(deleted.rowCount).toBe(0);
      } finally {
        await conn.query("rollback").catch(() => {});
        conn.release();
      }
      expect((await db.pool.query(LIST)).rows).toMatchObject([{ status: "open" }]);
    });
  });

  describe("privileges, policies and RLS (catalog)", () => {
    it("grants exactly: authenticated SELECT + INSERT(category, subject, message); service_role SELECT; anon nothing", async () => {
      const table = await db.pool.query(`
        select r.rolname, p.priv
          from pg_roles r, (values ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE'), ('TRUNCATE'), ('REFERENCES'), ('TRIGGER')) as p(priv)
         where r.rolname in ('anon', 'authenticated', 'service_role')
           and has_table_privilege(r.rolname, 'public.support_requests', p.priv)
         order by 1, 2`);
      // Table-wide privileges: reads only. INSERT exists per column only.
      expect(table.rows.map((r) => `${r.rolname}:${r.priv}`)).toEqual([
        "authenticated:SELECT",
        "service_role:SELECT",
      ]);

      const columns = await db.pool.query(`
        select grantee, privilege_type, column_name
          from information_schema.column_privileges
         where table_schema = 'public' and table_name = 'support_requests'
           and grantee in ('anon', 'authenticated', 'service_role')
           and privilege_type <> 'SELECT'
         order by 1, 2, 3`);
      expect(
        columns.rows.map((r) => `${r.grantee}:${r.privilege_type}:${r.column_name}`),
      ).toEqual(
        SUPPORT_REQUEST_INSERTABLE_COLUMNS.toSorted().map(
          (c) => `authenticated:INSERT:${c}`,
        ),
      );
    });

    it("has RLS enabled with exactly two policies: own SELECT and own INSERT", async () => {
      const policies = await db.pool.query(
        `select policyname, cmd, roles::text as roles, qual, with_check from pg_policies
          where schemaname = 'public' and tablename = 'support_requests' order by policyname`,
      );
      expect(policies.rows).toEqual([
        {
          policyname: "support_requests_insert_own",
          cmd: "INSERT",
          roles: "{authenticated}",
          qual: null,
          with_check: expect.stringMatching(/user_id = \( SELECT auth\.uid\(\)/),
        },
        {
          policyname: "support_requests_select_own",
          cmd: "SELECT",
          roles: "{authenticated}",
          qual: expect.stringMatching(/user_id = \( SELECT auth\.uid\(\)/),
          with_check: null,
        },
      ]);

      const rls = await db.pool.query(
        `select relrowsecurity from pg_class where oid = 'public.support_requests'::regclass`,
      );
      expect(rls.rows[0].relrowsecurity).toBe(true);
    });

    it("the rate-limit trigger function cannot be called through the API", async () => {
      const { rows } = await db.pool.query(`
        select r.rolname,
               has_function_privilege(r.rolname, 'public.support_requests_enforce_rate_limit()', 'EXECUTE') as can_execute
          from pg_roles r where r.rolname in ('anon', 'authenticated')
         order by 1`);
      expect(rows).toEqual([
        { rolname: "anon", can_execute: false },
        { rolname: "authenticated", can_execute: false },
      ]);
    });
  });

  describe("well-formed rows", () => {
    it.each(SUPPORT_REQUEST_CATEGORIES)("accepts the category %s", async (category) => {
      await expect(send(ALICE, { category })).resolves.toMatchObject({ rowCount: 1 });
    });

    it.each(["", "Billing", "sales", "urgent"])(
      "rejects the category %j",
      async (category) => {
        await expectCheckViolation(send(ALICE, { category }));
      },
    );

    it("knows exactly the statuses the application knows", async () => {
      for (const status of SUPPORT_REQUEST_STATUSES) {
        await seed(ALICE, `status ${status}`, { status });
      }
      await expectCheckViolation(seed(ALICE, "bad status", { status: "pending" }));
    });

    it.each([
      ["empty", ""],
      ["whitespace only", "   "],
      ["non-breaking spaces only", "\u00a0\u00a0"],
      ["a newline", "Line one\nline two"],
      ["a carriage return", "Header\r\nInjected: yes"],
      ["a tab", "Tab\there"],
      ["a C1 control (U+0085)", "Next\u0085line"],
      ["a line separator (U+2028)", "Line\u2028separator"],
      ["too long", "x".repeat(SUPPORT_REQUEST_SUBJECT_MAX_LENGTH + 1)],
    ])("rejects a subject with %s", async (_label, subject) => {
      await expectCheckViolation(send(ALICE, { subject }));
    });

    it("measures the subject in characters, not bytes", async () => {
      const emoji = "🙂".repeat(SUPPORT_REQUEST_SUBJECT_MAX_LENGTH); // 600 bytes in UTF-8
      await expect(send(ALICE, { subject: emoji })).resolves.toMatchObject({
        rowCount: 1,
      });
    });

    it.each([
      ["empty", ""],
      ["whitespace only", " \n\t "],
      ["Unicode whitespace only", "\u00a0\u3000\ufeff\u2028"],
      ["too long", "x".repeat(SUPPORT_REQUEST_MESSAGE_MAX_LENGTH + 1)],
    ])("rejects a message that is %s", async (_label, message) => {
      await expectCheckViolation(send(ALICE, { message }));
    });

    it("accepts a multi-line message at the maximum length", async () => {
      const message = `Steps:\n1. open\n2. click\n`.padEnd(
        SUPPORT_REQUEST_MESSAGE_MAX_LENGTH,
        "x",
      );
      await expect(send(ALICE, { message })).resolves.toMatchObject({ rowCount: 1 });
    });
  });

  describe("the application's input schema agrees with the database", () => {
    // Raw form input. `schema` is whether NEW_SUPPORT_REQUEST_SCHEMA accepts it;
    // `database` is whether the database accepts it as sent (untrimmed).
    const cases: [string, Record<string, string>, boolean, boolean][] = [
      [
        "a normal request",
        { category: "account", subject: "Locked", message: "Help" },
        true,
        true,
      ],
      [
        "padded fields (trimmed by the schema)",
        { category: "other", subject: "  Hi  ", message: "\n Hey \n" },
        true,
        true,
      ],
      [
        "blank subject",
        { category: "other", subject: "  ", message: "Hey" },
        false,
        false,
      ],
      [
        "blank message",
        { category: "other", subject: "Hi", message: "\n\n" },
        false,
        false,
      ],
      [
        "message of Unicode spaces",
        { category: "other", subject: "Hi", message: "\u3000\u00a0" },
        false,
        false,
      ],
      [
        "subject of Unicode spaces",
        { category: "other", subject: "\u2003\ufeff", message: "Hey" },
        false,
        false,
      ],
      [
        "unknown category",
        { category: "sales", subject: "Hi", message: "Hey" },
        false,
        false,
      ],
      [
        "subject at the limit",
        {
          category: "other",
          subject: "é".repeat(SUPPORT_REQUEST_SUBJECT_MAX_LENGTH),
          message: "Hey",
        },
        true,
        true,
      ],
      [
        "subject over the limit",
        {
          category: "other",
          subject: "é".repeat(SUPPORT_REQUEST_SUBJECT_MAX_LENGTH + 1),
          message: "Hey",
        },
        false,
        false,
      ],
      [
        "astral subject at the limit",
        {
          category: "other",
          subject: "🙂".repeat(SUPPORT_REQUEST_SUBJECT_MAX_LENGTH),
          message: "Hey",
        },
        true,
        true,
      ],
      [
        "multi-line subject",
        { category: "other", subject: "a\nb", message: "Hey" },
        false,
        false,
      ],
      [
        "C1 control in subject",
        { category: "other", subject: "a\u009bb", message: "Hey" },
        false,
        false,
      ],
      [
        "paragraph separator in subject",
        { category: "other", subject: "a\u2029b", message: "Hey" },
        false,
        false,
      ],
      [
        "message at the limit",
        {
          category: "other",
          subject: "Hi",
          message: "m".repeat(SUPPORT_REQUEST_MESSAGE_MAX_LENGTH),
        },
        true,
        true,
      ],
      [
        // As a browser sends a message typed at its limit: CRLF line breaks
        // (found in Chromium). Raw, that is over the database's limit; the
        // schema normalises it to what the user typed, which the database takes.
        "message at the limit with CRLF line breaks",
        {
          category: "other",
          subject: "Hi",
          message: `${Array.from({ length: 50 }, () => "x".repeat(99)).join("\r\n")}y`,
        },
        true,
        false,
      ],
      [
        "message over the limit",
        {
          category: "other",
          subject: "Hi",
          message: "m".repeat(SUPPORT_REQUEST_MESSAGE_MAX_LENGTH + 1),
        },
        false,
        false,
      ],
    ];

    it("'blank' means the same in the database as in String.prototype.trim(), for every BMP character", async () => {
      // Evaluates the installed message constraint for each single character
      // (no NUL: text cannot hold it; no lone surrogates: not valid UTF-8).
      const chars: string[] = [];
      for (let cp = 1; cp <= 0xffff; cp++) {
        if (cp >= 0xd800 && cp <= 0xdfff) continue;
        chars.push(String.fromCodePoint(cp));
      }
      const { rows: def } = await db.pool.query(
        `select pg_get_constraintdef(oid) as def from pg_constraint
          where conname = 'support_requests_message_format'`,
      );
      const expression = def[0].def.replace(/^CHECK /, "");
      const { rows } = await db.pool.query(
        `select array_agg(ascii(message) order by ascii(message)) as blank
           from unnest($1::text[]) as u(message) where not (${expression})`,
        [chars],
      );

      const jsBlank = chars.filter((c) => c.trim() === "").map((c) => c.codePointAt(0));
      expect(rows[0].blank).toEqual(jsBlank);
      expect(jsBlank.length).toBeGreaterThan(20); // sanity: the set is not trivially empty
    });

    it.each(cases)("%s", async (_label, input, schemaAccepts, databaseAccepts) => {
      const parsed = NEW_SUPPORT_REQUEST_SCHEMA.safeParse(input);
      expect(parsed.success).toBe(schemaAccepts);

      const raw = send(ALICE, input);
      if (databaseAccepts) {
        await expect(raw).resolves.toMatchObject({ rowCount: 1 });
      } else {
        await expectCheckViolation(raw);
      }

      // Whatever the schema lets through, the database stores.
      if (parsed.success) {
        await db.pool.query("delete from public.support_requests");
        await expect(send(ALICE, parsed.data)).resolves.toMatchObject({ rowCount: 1 });
      }
    });
  });

  describe("lifecycle", () => {
    it("a user's requests are deleted with the account", async () => {
      await createTestUsers(db.pool, [GHOST]);
      await send(GHOST, { subject: "Going away" });
      await send(ALICE, { subject: "Staying" });

      await db.pool.query("delete from auth.users where id = $1", [GHOST]);

      expect((await db.pool.query(LIST)).rows.map((r) => r.subject)).toEqual(["Staying"]);
    });

    it("lists a user's requests newest first through the index", async () => {
      const index = await db.pool.query(
        `select indexdef from pg_indexes where indexname = 'support_requests_user_recent_idx'`,
      );
      expect(index.rows[0].indexdef).toMatch(/\(user_id, created_at DESC\)$/);
    });
  });

  describe("keyset paging (the predicate the reader sends)", () => {
    /**
     * The SQL equivalent of what `listSupportRequests` asks PostgREST for:
     * the user's own rows, newest first, `(created_at, id)` as the position,
     * and one row beyond the page to detect a next one.
     */
    const PAGE = `select id::text as id, created_at, subject
                    from public.support_requests
                   where user_id = $1
                     and ($2::timestamptz is null
                          or created_at < $2::timestamptz
                          or (created_at = $2::timestamptz and id < $3::uuid))
                   order by created_at desc, id desc
                   limit $4`;

    const readPage = async (
      user: string,
      cursor: { createdAt: string; id: string } | null,
      limit: number,
    ) => {
      const { rows } = await queryAs(db.pool, "authenticated", user, PAGE, [
        user,
        cursor?.createdAt ?? null,
        cursor?.id ?? null,
        limit + 1,
      ]);

      const page = rows.slice(0, limit);
      const last = page[page.length - 1];

      return {
        subjects: page.map((r) => r.subject as string),
        next:
          rows.length > limit && last
            ? {
                createdAt: (last.created_at as Date).toISOString(),
                id: last.id as string,
              }
            : null,
      };
    };

    /** Walks every page, returning what the user saw, in order. */
    const walk = async (user: string, limit: number) => {
      const seen: string[] = [];
      let cursor: { createdAt: string; id: string } | null = null;

      for (let guard = 0; guard < 20; guard++) {
        const page = await readPage(user, cursor, limit);
        seen.push(...page.subjects);
        cursor = page.next;
        if (!cursor) break;
      }

      return seen;
    };

    beforeEach(async () => {
      // Older than an hour, so the flood limit does not apply to the fixtures.
      const at = (minutesAgo: number) =>
        new Date(Date.now() - minutesAgo * 60 * 1000).toISOString();

      for (let i = 0; i < 5; i++) {
        await seed(ALICE, `Alice ${i}`, { created_at: at(200 - i) });
      }
      // Two of Alice's requests share an instant: the id must break the tie.
      await seed(ALICE, "Alice tie A", { created_at: at(90) });
      await seed(ALICE, "Alice tie B", { created_at: at(90) });

      for (let i = 0; i < 3; i++) {
        await seed(BOB, `Bob ${i}`, { created_at: at(150 - i) });
      }
    });

    it("walks a user's own requests newest first, without repeats or gaps", async () => {
      const seen = await walk(ALICE, 2);

      expect(seen).toHaveLength(7);
      expect(new Set(seen).size).toBe(7);
      // Newest first; the two tied rows are adjacent and in a stable order.
      expect(seen.slice(0, 2).sort()).toEqual(["Alice tie A", "Alice tie B"]);
      expect(seen.slice(2)).toEqual([
        "Alice 4",
        "Alice 3",
        "Alice 2",
        "Alice 1",
        "Alice 0",
      ]);
    });

    it("never shows another user's requests, at any page size", async () => {
      for (const limit of [1, 2, 3, 7, 50]) {
        const seen = await walk(ALICE, limit);

        expect(seen).toHaveLength(7);
        expect(seen.some((subject) => subject.startsWith("Bob"))).toBe(false);
      }

      expect(await walk(BOB, 2)).toEqual(["Bob 2", "Bob 1", "Bob 0"]);
    });

    it("a request filed while paging does not shift or repeat what was shown", async () => {
      const first = await readPage(ALICE, null, 3);
      expect(first.next).not.toBeNull();

      await send(ALICE, { subject: "Filed while paging" });

      const rest: string[] = [];
      let cursor = first.next;
      for (let guard = 0; guard < 20 && cursor; guard++) {
        const page = await readPage(ALICE, cursor, 3);
        rest.push(...page.subjects);
        cursor = page.next;
      }

      // The new request is newer than the cursor, so it belongs to the first
      // page; the remaining pages are exactly the rest, each row once.
      expect(rest).not.toContain("Filed while paging");
      expect(new Set([...first.subjects, ...rest]).size).toBe(7);
    });

    it("a cursor naming another user's row still only reads the caller's own requests", async () => {
      // Bob pages with a position taken from one of Alice's rows (the worst a
      // client can do: cursors are not secret). RLS and the user filter hold.
      const { rows } = await db.pool.query(
        `select id::text as id, created_at from public.support_requests
          where user_id = $1 order by created_at desc limit 1`,
        [ALICE],
      );
      const alicesPosition = {
        createdAt: (rows[0].created_at as Date).toISOString(),
        id: rows[0].id as string,
      };

      const page = await readPage(BOB, alicesPosition, 10);

      expect(page.subjects.every((subject) => subject.startsWith("Bob"))).toBe(true);
    });
  });

  describe("flood limit", () => {
    const { requests: LIMIT } = SUPPORT_REQUEST_RATE_LIMIT;

    it(`accepts ${LIMIT} requests per hour, then rejects with ${SUPPORT_REQUEST_RATE_LIMITED_CODE} and stores nothing`, async () => {
      for (let i = 0; i < LIMIT; i++) {
        await send(ALICE, { subject: `Request ${i}` });
      }

      await expect(send(ALICE, { subject: "One too many" })).rejects.toMatchObject({
        code: SUPPORT_REQUEST_RATE_LIMITED_CODE,
      });

      const { rows } = await db.pool.query(
        `select count(*)::int as n from public.support_requests where user_id = $1`,
        [ALICE],
      );
      expect(rows[0].n).toBe(LIMIT);
    });

    it("is per user: one user's requests do not count against another", async () => {
      for (let i = 0; i < LIMIT; i++) {
        await send(ALICE, { subject: `Alice ${i}` });
      }
      await expect(send(BOB)).resolves.toMatchObject({ rowCount: 1 });
    });

    it("is a rolling window: requests older than an hour no longer count", async () => {
      for (let i = 0; i < LIMIT; i++) {
        await seed(ALICE, `Old ${i}`, {
          created_at: new Date(Date.now() - 61 * 60 * 1000).toISOString(),
        });
      }
      await seed(ALICE, "Recent", {
        created_at: new Date(Date.now() - 59 * 60 * 1000).toISOString(),
      });

      for (let i = 0; i < LIMIT - 1; i++) {
        await send(ALICE, { subject: `New ${i}` });
      }
      await expect(send(ALICE, { subject: "Over" })).rejects.toMatchObject({
        code: SUPPORT_REQUEST_RATE_LIMITED_CODE,
      });
    });

    describe("concurrency", () => {
      async function openSend(user: string, subject: string) {
        const conn = await db.pool.connect();
        let open = true;
        await conn.query("begin");
        await conn.query("set local role authenticated");
        await conn.query("select set_config('request.jwt.claim.sub', $1, true)", [user]);
        const insert = conn.query(
          `insert into public.support_requests (subject, message) values ($1, 'M')`,
          [subject],
        );
        insert.catch(() => {}); // inspected later; must not surface as unhandled

        const end = async (statement: "commit" | "rollback") => {
          if (!open) return;
          open = false;
          await conn.query(statement).catch(() => {});
          conn.release();
        };

        return {
          insert,
          commit: () => end("commit"),
          rollback: () => end("rollback"),
          finish: () => end("rollback"),
        };
      }

      const settled = (promise: Promise<unknown>, ms = 300) =>
        Promise.race([
          promise.then(
            () => "resolved",
            () => "rejected",
          ),
          new Promise<"pending">((resolve) => setTimeout(() => resolve("pending"), ms)),
        ]);

      it("parallel requests cannot slip past the limit together", async () => {
        for (let i = 0; i < LIMIT - 1; i++) {
          await seed(CAROL, `Earlier ${i}`);
        }

        const first = await openSend(CAROL, "Last allowed");
        const second = await openSend(CAROL, "Racing");
        try {
          await first.insert; // holds the per-user lock, uncommitted
          expect(await settled(second.insert)).toBe("pending"); // waits, does not count a stale snapshot

          await first.commit();

          await expect(second.insert).rejects.toMatchObject({
            code: SUPPORT_REQUEST_RATE_LIMITED_CODE,
          });
        } finally {
          await first.finish();
          await second.finish();
        }

        const { rows } = await db.pool.query(
          `select count(*)::int as n from public.support_requests where user_id = $1`,
          [CAROL],
        );
        expect(rows[0].n).toBe(LIMIT);
      });

      it("if the first request rolls back, the waiting one goes through", async () => {
        for (let i = 0; i < LIMIT - 1; i++) {
          await seed(CAROL, `Earlier ${i}`);
        }

        const first = await openSend(CAROL, "Abandoned");
        const second = await openSend(CAROL, "Goes through");
        try {
          await first.insert;
          expect(await settled(second.insert)).toBe("pending");

          await first.rollback();

          await expect(second.insert).resolves.toMatchObject({ rowCount: 1 });
          await second.commit();
        } finally {
          await first.finish();
          await second.finish();
        }
      });

      it("different users do not wait for each other", async () => {
        const alice = await openSend(ALICE, "Alice");
        const bob = await openSend(BOB, "Bob");
        try {
          await alice.insert;
          expect(await settled(bob.insert)).toBe("resolved");
        } finally {
          await alice.finish();
          await bob.finish();
        }
      });
    });
  });
});
