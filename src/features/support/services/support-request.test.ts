// @vitest-environment node
/**
 * Static contract between `supabase/migrations/*_support_requests.sql` and
 * `support-request.ts`, so the unit suite (no database) notices drift. The
 * behaviour itself — who can read and create, constraints, the flood limit —
 * is proven against a real PostgreSQL in `support-requests.integration.test.ts`.
 */
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  NEW_SUPPORT_REQUEST_SCHEMA,
  normalizeLineBreaks,
  SUPPORT_REQUEST_CATEGORIES,
  SUPPORT_REQUEST_FIELD_ERRORS,
  SUPPORT_REQUEST_INSERTABLE_COLUMNS,
  SUPPORT_REQUEST_MESSAGE_MAX_LENGTH,
  SUPPORT_REQUEST_RATE_LIMIT,
  SUPPORT_REQUEST_RATE_LIMITED_CODE,
  SUPPORT_REQUEST_STATUSES,
  SUPPORT_REQUEST_SUBJECT_MAX_LENGTH,
  SUPPORT_REQUESTS_TABLE,
} from "./support-request";

const MIGRATIONS_DIR = path.resolve(__dirname, "../../../../supabase/migrations");

async function migration() {
  const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith(".sql")).sort();
  const file = files.find((f) => /_support_requests\.sql$/.test(f));
  if (!file) throw new Error("support requests migration missing");
  return readFile(path.join(MIGRATIONS_DIR, file), "utf8");
}

const quoted = (values: readonly string[]) => values.map((v) => `'${v}'`).join(", ");

describe("support requests migration", () => {
  it("creates the table with a session-derived owner that follows the account", async () => {
    const sql = await migration();

    expect(sql).toMatch(
      new RegExp(`create table public\\.${SUPPORT_REQUESTS_TABLE} \\(`),
    );
    expect(sql).toMatch(
      /user_id\s+uuid\s+not null default auth\.uid\(\) references auth\.users \(id\) on delete cascade/,
    );
    expect(sql).toMatch(/status\s+text\s+not null default 'open'/);
    expect(sql).toMatch(/created_at timestamptz not null default now\(\)/);
  });

  it("allows the categories, statuses and lengths the application uses", async () => {
    const sql = await migration();

    expect(sql).toContain(`category in (${quoted(SUPPORT_REQUEST_CATEGORIES)})`);
    expect(sql).toContain(`status in (${quoted(SUPPORT_REQUEST_STATUSES)})`);
    expect(sql).toContain(
      `char_length(subject) <= ${SUPPORT_REQUEST_SUBJECT_MAX_LENGTH}`,
    );
    expect(sql).toContain(
      `char_length(message) <= ${SUPPORT_REQUEST_MESSAGE_MAX_LENGTH}`,
    );
  });

  it("grants users SELECT and column-limited INSERT only, the service role SELECT only, anon nothing", async () => {
    const sql = await migration();

    expect(sql).toMatch(/alter table public\.support_requests enable row level security/);
    expect(sql).toMatch(
      /revoke all on table public\.support_requests from public, anon, authenticated, service_role/,
    );
    expect(sql).toMatch(
      new RegExp(
        `grant insert \\(${SUPPORT_REQUEST_INSERTABLE_COLUMNS.join(", ")}\\)\\s+on table public\\.support_requests to authenticated;`,
      ),
    );
    expect(sql).toMatch(
      /grant select\s+on table public\.support_requests to authenticated;/,
    );
    expect(sql).toMatch(
      /grant select\s+on table public\.support_requests to service_role;/,
    );

    const grants = sql.match(/^\s*grant .*$/gim) ?? [];
    expect(grants).toHaveLength(3);
    expect(sql).not.toMatch(/^\s*grant (update|delete|all)/im);
    expect(sql).not.toMatch(/to anon/);
  });

  it("has owner-only SELECT and INSERT policies and none for UPDATE/DELETE", async () => {
    const sql = await migration();

    expect(sql).toMatch(
      /create policy support_requests_select_own on public\.support_requests\s+for select to authenticated\s+using \(user_id = \(select auth\.uid\(\)\)\)/,
    );
    expect(sql).toMatch(
      /create policy support_requests_insert_own on public\.support_requests\s+for insert to authenticated\s+with check \(user_id = \(select auth\.uid\(\)\)\)/,
    );
    expect(sql.match(/create policy/g)).toHaveLength(2);
    expect(sql).not.toMatch(/for (update|delete|all) to/i);
  });

  it("enforces the flood limit the application reports", async () => {
    const sql = await migration();

    expect(sql).toMatch(
      /create trigger support_requests_rate_limit\s+before insert on public\.support_requests/,
    );
    expect(sql).toContain(`v_recent >= ${SUPPORT_REQUEST_RATE_LIMIT.requests}`);
    expect(sql).toContain(
      `interval '${SUPPORT_REQUEST_RATE_LIMIT.windowMinutes / 60} hour'`,
    );
    expect(sql).toContain(`errcode = '${SUPPORT_REQUEST_RATE_LIMITED_CODE}'`);
    expect(sql).toMatch(/perform pg_advisory_xact_lock\(/);
  });
});

describe("NEW_SUPPORT_REQUEST_SCHEMA", () => {
  const valid = {
    category: "billing",
    subject: "Charged twice",
    message: "Two charges.",
  };

  it("accepts a request and trims its text", () => {
    expect(
      NEW_SUPPORT_REQUEST_SCHEMA.parse({
        ...valid,
        subject: "  Charged twice ",
        message: "\n Two charges.\n",
      }),
    ).toEqual(valid);
  });

  it("accepts only the user-supplied columns (unknown keys are dropped)", () => {
    const parsed = NEW_SUPPORT_REQUEST_SCHEMA.parse({
      ...valid,
      user_id: "someone-else",
      status: "closed",
    });
    expect(Object.keys(parsed).sort()).toEqual(
      [...SUPPORT_REQUEST_INSERTABLE_COLUMNS].sort(),
    );
  });

  it.each([
    ["an unknown category", { category: "sales" }],
    ["a blank subject", { subject: " \u00a0 " }],
    ["a multi-line subject", { subject: "a\nb" }],
    ["a subject with a C1 control", { subject: "a\u0085b" }],
    ["a subject with a line separator", { subject: "a\u2028b" }],
    ["a long subject", { subject: "é".repeat(SUPPORT_REQUEST_SUBJECT_MAX_LENGTH + 1) }],
    ["a blank message", { message: "\n\t " }],
    ["a message with NUL", { message: "a\u0000b" }],
    ["a long message", { message: "m".repeat(SUPPORT_REQUEST_MESSAGE_MAX_LENGTH + 1) }],
  ])("rejects %s", (_label, override) => {
    expect(NEW_SUPPORT_REQUEST_SCHEMA.safeParse({ ...valid, ...override }).success).toBe(
      false,
    );
  });

  it("counts characters, not UTF-16 units, like the database", () => {
    const subject = "🙂".repeat(SUPPORT_REQUEST_SUBJECT_MAX_LENGTH); // 300 UTF-16 units
    expect(NEW_SUPPORT_REQUEST_SCHEMA.safeParse({ ...valid, subject }).success).toBe(
      true,
    );
  });

  it("counts and stores line breaks as the browser does: one LF each", () => {
    // Browsers count a textarea's line break as one character but send it as
    // CRLF when the form is encoded (found in Chromium). Normalised first.
    expect(
      NEW_SUPPORT_REQUEST_SCHEMA.parse({ ...valid, message: "a\r\nb\rc\nd" }).message,
    ).toBe("a\nb\nc\nd");
    expect(normalizeLineBreaks("x\r\n\r\ny")).toBe("x\n\ny");
  });

  it("accepts a message at the limit whose line breaks arrived as CRLF", () => {
    // 50 lines of 99 + 49 breaks + 1 = 5000 as the browser counts; 5049 as sent.
    const asTyped = `${Array.from({ length: 50 }, () => "x".repeat(99)).join("\n")}y`;
    const asSent = asTyped.replace(/\n/g, "\r\n");
    expect([...asTyped]).toHaveLength(SUPPORT_REQUEST_MESSAGE_MAX_LENGTH);
    expect(asSent.length).toBeGreaterThan(SUPPORT_REQUEST_MESSAGE_MAX_LENGTH);

    const parsed = NEW_SUPPORT_REQUEST_SCHEMA.safeParse({ ...valid, message: asSent });

    expect(parsed.success).toBe(true);
    expect(parsed.data?.message).toBe(asTyped);
  });

  it("still refuses a message over the limit once line breaks are counted as one", () => {
    const over = `${"x".repeat(SUPPORT_REQUEST_MESSAGE_MAX_LENGTH)}\r\n!`;

    expect(
      NEW_SUPPORT_REQUEST_SCHEMA.safeParse({ ...valid, message: over }).success,
    ).toBe(false);
  });

  it("treats a message of only line breaks as blank", () => {
    const result = NEW_SUPPORT_REQUEST_SCHEMA.safeParse({
      ...valid,
      message: "\r\n\r\n",
    });

    expect(result.success).toBe(false);
    expect(result.error?.issues[0].message).toBe(
      SUPPORT_REQUEST_FIELD_ERRORS.messageRequired,
    );
  });

  it("keeps multi-line messages", () => {
    const message = "Steps:\n1. open\n2. click";
    expect(NEW_SUPPORT_REQUEST_SCHEMA.parse({ ...valid, message }).message).toBe(message);
  });
});
